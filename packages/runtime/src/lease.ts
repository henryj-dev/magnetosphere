// job_leases 임대 잠금 (계획서 3.2, 5.9). 여러 인스턴스(MySQL·Postgres)가 같은 주기 작업을 동시에 돌리지 않게 한다.
// 판정은 DB 한 문장의 원자성에 맡긴다.
//   1) 행이 없으면 INSERT (기본 키 충돌이면 아무것도 안 함) — 동시에 넣어도 한쪽만 들어간다.
//   2) 행이 있으면 "만료됐거나 내 임대"일 때만 UPDATE — 행 잠금 뒤 조건을 다시 보므로 동시에 해도 한쪽만 바뀐다
//      (InnoDB 는 UPDATE 가 최신 커밋 값을 읽고, Postgres READ COMMITTED 는 바뀐 행에 조건을 다시 건다).
// 시각은 앱이 만든 값을 넘긴다. 인스턴스 시계가 맞는다는 전제다 (NTP).
//
// 하트비트·펜싱 (K1.T2, S4 보안 리뷰 L4)
//   - 잡을 때마다 fence 가 1 씩 는다. 잡은 쪽은 { fence } 를 받는다.
//   - 작업 중에는 ttl / 3 마다 renewLease 로 늘린다. 같은 holder·fence 일 때만 늘어난다. 늘리지 못하면 작업 신호를 끊는다.
//   - 임대를 잃은 뒤에도 깨어나 쓰는 인스턴스(GC·절전)를 막으려고 DB 쓰기에 fenced() 조건을 붙인다. 다른 쪽이 잡아
//     fence 가 바뀌었으면 그 쓰기는 0행이다.
// 경계 번호 (K1 리뷰 #6)
//   - 주기 작업은 경계 번호 slot(경계 시각 / 주기)을 넘긴다. 잡을 때 last_slot < slot 이어야 하고, 잡으면 last_slot = slot.
//     같은 경계는 같은 holder 라도, 만료 뒤 다른 holder 라도 다시 돌지 않는다. K2 분배가 "경계마다 한 번"에 기댄다.
import { and, eq, exists, gt, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { DbHandle } from "./types.ts";

/** 잡은 임대. fence 는 이 이름에서 잡을 때마다 엄격히 는다 */
export interface Lease {
  name: string;
  holder: string;
  fence: number;
}

/** 임대를 잃어 작업 신호를 끊을 때의 이유 */
export class LeaseLostError extends Error {
  constructor(lease: Lease) {
    super(`임대 ${lease.name} (fence ${lease.fence}) 를 잃었다. 작업을 멈춘다`);
    this.name = "LeaseLostError";
  }
}

/**
 * UPDATE 하나가 바꾼(조건에 맞은) 행 수. MySQL 은 RETURNING 이 없어 영향 행 수로 센다
 * (mysql2 는 FOUND_ROWS 를 켜 둬 값이 같아도 맞은 행을 센다). 나머지는 RETURNING 행 수다.
 * update 는 .where() 까지 붙인 Drizzle UPDATE, key 는 RETURNING 에 쓸 칼럼 하나.
 */
export async function updatedRows(h: DbHandle, update: any, key: any): Promise<number> {
  if (h.provider === "mysql") {
    const [r] = await update;
    return r.affectedRows;
  }
  return (await update.returning({ k: key })).length;
}

/**
 * name 임대를 holder 가 ttlMs 동안 잡는다. 잡았으면(새로 잡았거나 내 임대를 다시 잡았으면) 새 fence 를 담은 임대, 아니면 null.
 * slot(경계 번호)을 주면 그 경계를 이미 돈 임대(last_slot ≥ slot)는 잡지 않는다.
 */
export async function acquireLease(h: DbHandle, name: string, holder: string, ttlMs: number, now: Date = new Date(), slot?: number): Promise<Lease | null> {
  const t = h.schema.jobLeases;
  const lockedUntil = new Date(now.getTime() + ttlMs);
  const fresh = slot === undefined ? undefined : or(isNull(t.lastSlot), lt(t.lastSlot, slot));
  const takeable = and(eq(t.name, name), or(lt(t.lockedUntil, now), eq(t.holder, holder)), fresh);
  const lastSlot = slot === undefined ? {} : { lastSlot: slot };
  if (h.provider === "mysql") {
    // MySQL 은 RETURNING 이 없다. INSERT IGNORE·UPDATE 의 영향 행 수로 판정한다.
    // 새 fence 는 LAST_INSERT_ID(expr) 로 같은 문장의 OK 패킷(insertId)에 실어 받는다. 다시 읽으면 그 사이에 다른 쪽이
    // 잡을 수 있고, 연결 풀에서는 다음 질의가 다른 연결로 가 LAST_INSERT_ID() 를 읽을 수도 없다
    const [ins] = await h.db.insert(t).ignore().values({ name, holder, lockedUntil, fence: 1, ...lastSlot });
    if (ins.affectedRows === 1) return { name, holder, fence: 1 };
    const [upd] = await h.db
      .update(t)
      .set({ holder, lockedUntil, fence: sql`LAST_INSERT_ID(${t.fence} + 1)`, ...lastSlot })
      .where(takeable);
    return upd.affectedRows === 1 ? { name, holder, fence: Number(upd.insertId) } : null;
  }
  const ins = await h.db.insert(t).values({ name, holder, lockedUntil, fence: 1, ...lastSlot }).onConflictDoNothing().returning({ fence: t.fence });
  if (ins.length === 1) return { name, holder, fence: Number(ins[0].fence) };
  const upd = await h.db
    .update(t)
    .set({ holder, lockedUntil, fence: sql`${t.fence} + 1`, ...lastSlot })
    .where(takeable)
    .returning({ fence: t.fence });
  return upd.length === 1 ? { name, holder, fence: Number(upd[0].fence) } : null;
}

/** 내 임대(같은 holder·fence)일 때만 지금부터 ttlMs 로 늘린다. 다른 쪽이 잡아 fence 가 바뀌었으면 false */
export async function renewLease(h: DbHandle, lease: Lease, ttlMs: number, now: Date = new Date()): Promise<boolean> {
  const t = h.schema.jobLeases;
  const mine = and(eq(t.name, lease.name), eq(t.holder, lease.holder), eq(t.fence, lease.fence));
  return (await updatedRows(h, h.db.update(t).set({ lockedUntil: new Date(now.getTime() + ttlMs) }).where(mine), t.name)) === 1;
}

/**
 * 쓰기 조건: 이 임대가 아직 내 것이다 (같은 이름의 fence 가 그대로다). DB 쓰기의 where 에 and 로 붙인다.
 * 임대를 잃은 쪽의 쓰기는 0행이 된다 (TC-K1.T2.b).
 */
export function fenced(h: DbHandle, lease: Lease): SQL {
  const t = h.schema.jobLeases;
  return exists(
    h.db
      .select({ one: sql`1` })
      .from(t)
      .where(and(eq(t.name, lease.name), eq(t.holder, lease.holder), eq(t.fence, lease.fence))),
  );
}

/** p 가 ms 안에 끝나지 않으면 fallback 으로 끝낸다 (p 는 계속 돌지만 기다리지 않는다) */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 작업 fn 을 돌리는 동안 ttlMs / 3 마다 renew 를 부른다. renew 가 false 이거나 예외면 fn 에 넘긴 신호를 끊는다.
 * fn 이 끝나면 하트비트를 멈춘다. 신호를 끊었으면 그 이유(LeaseLostError 등)를 던진다 — 임대를 잃은 작업은 실패다.
 * DB 가 멈춰도 끊는다 (K1 리뷰 #3, TC-K1.T2.e):
 *   - renew 하나는 ttlMs / 3 안에 끝나야 한다. 넘기면 실패로 본다 (늘렸는지 모르는 채로 쓰지 않는다).
 *   - 로컬 마감: 마지막으로 늘린 시각(처음은 holdLease 를 부른 시각 = 임대를 잡은 직후) + ttlMs − ttlMs / 6.
 *     이 시각까지 다음 갱신이 성공하지 않으면 끊는다. DB 의 만료(ttlMs)보다 먼저 멈춰 다른 인스턴스가 잡기 전에 손을 뗀다.
 * DB 를 모르는 하트비트 부분만 따로 둔다 (TC-K1.T2.c·e 가 가짜 renew 로 본다).
 */
export async function holdLease(
  renew: () => Promise<boolean>,
  ttlMs: number,
  fn: (signal: AbortSignal) => Promise<void>,
  lost: () => Error = () => new Error("임대를 잃었다"),
): Promise<void> {
  const ac = new AbortController();
  const step = Math.max(1, Math.floor(ttlMs / 3));
  const margin = Math.floor(ttlMs / 6);
  let done = false;
  let beating = false;
  const stop = () => {
    if (!done && !ac.signal.aborted) ac.abort(lost());
  };
  let deadline = setTimeout(stop, ttlMs - margin);
  const beat = async () => {
    // 앞 하트비트가 아직 끝나지 않았으면 겹쳐 보내지 않는다 (renew 하나는 step 안에 끝난다)
    if (beating || done || ac.signal.aborted) return;
    beating = true;
    const startedAt = performance.now();
    let ok = false;
    try {
      ok = await within(renew(), step, false);
    } catch {
      // 늘렸는지 모르면 잃은 것으로 본다. 모르는 채로 쓰는 것보다 멈추는 쪽이 안전하다
      ok = false;
    } finally {
      beating = false;
    }
    if (!ok) return stop();
    // 늘리기 질의를 보낸 시각부터 ttlMs 가 DB 의 새 만료다. 그 시각을 기준으로 마감을 다시 건다
    clearTimeout(deadline);
    if (!done) deadline = setTimeout(stop, Math.max(0, ttlMs - margin - (performance.now() - startedAt)));
  };
  const timer = setInterval(() => void beat(), step);
  try {
    await fn(ac.signal);
  } finally {
    done = true;
    clearInterval(timer);
    clearTimeout(deadline);
  }
  if (ac.signal.aborted) throw ac.signal.reason;
}

/**
 * name 임대를 잡으면 fn 을 하트비트 아래에서 돌린다. 못 잡으면(또는 slot 경계를 이미 돌았으면) fn 을 부르지 않고 false.
 * 끝나면 임대 만료를 "처음 잡을 때의 만료"로 되돌린다 (이미 지났으면 지금). 하트비트가 늘린 만료가 다음 주기 경계를
 * 넘으면 이 인스턴스가 죽었을 때 다음 경계를 아무도 못 돈다. 같은 경계 안에서는 여전히 잠겨 있어 두 번 돌지 않는다.
 */
export async function runLeased(
  h: DbHandle,
  name: string,
  holder: string,
  ttlMs: number,
  fn: (signal: AbortSignal, lease: Lease) => Promise<void>,
  now: () => number = Date.now,
  slot?: number,
): Promise<boolean> {
  const startedAt = now();
  const lease = await acquireLease(h, name, holder, ttlMs, new Date(startedAt), slot);
  if (!lease) return false;
  try {
    await holdLease(() => renewLease(h, lease, ttlMs, new Date(now())), ttlMs, (signal) => fn(signal, lease), () => new LeaseLostError(lease));
  } finally {
    const t = h.schema.jobLeases;
    const until = new Date(Math.max(now(), startedAt + ttlMs));
    // 되돌리기가 실패하거나 멈춰도(DB 끊김) 임대는 늘린 만료에 스스로 풀린다. 작업의 결과·예외를 이것으로 덮지 않고,
    // ttlMs / 3 넘게 기다리지 않는다 (멈춘 DB 에 붙들려 이 인스턴스의 다음 경계가 막히지 않게)
    const restore = Promise.resolve(
      h.db
        .update(t)
        .set({ lockedUntil: until })
        .where(and(eq(t.name, lease.name), eq(t.holder, lease.holder), eq(t.fence, lease.fence), gt(t.lockedUntil, until))),
    ).catch(() => undefined);
    await within(restore, Math.max(1, Math.floor(ttlMs / 3)), undefined);
  }
  return true;
}
