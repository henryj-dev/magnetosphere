// OmniRoute 작업 큐 omniroute_jobs (계획서 5.7 반영, 5.9, K1.T3).
// 요청 안에서 바로 한 OmniRoute 반영이 실패하면 여기에 넣고, 1분 실행기(jobs.ts 의 omniroute_jobs)가 재시도한다.
//
// 재시도 (계획서 v5.6 Q2·Q3·Q6)
//   - 실패할 때마다 attempts + 1, 다음 시도는 실패 시각 + RETRY_DELAYS_MS[attempts − 1] (1분·2분·10분·30분).
//     실행기 최소 주기가 1분이라 1분보다 짧은 간격은 지킬 수 없다.
//   - 실행기는 1분 경계마다 깨지만 깨는 시각이 몇십 초씩 늦을 수 있다. 차례 비교에 tick 주기의 절반(DUE_GRACE_MS, 30초)
//     유예를 둬, 다음 tick 의 지연이 이번보다 작아도 한 주기를 건너뛰지 않는다 (K1 리뷰 #2, TC-K1.T3.a).
//   - 4번째 재시도(다섯 번째 시도)도 실패하면 failed_at = 지금, 대상 키 sync_state = failed, audit_log alert.job_failed 1행.
//     next_run_at 은 그대로 둔다. failed_at 이 있는 작업은 runDue 가 다시 집지 않는다 (정합성 점검이 키를 다시 맞춘다, 5.7).
//   - failed_at 에서 30분이 지나면 "오래 실패"다 (isLongFailed, 관리 화면은 7단계).
//   - failed_at·키 sync_state·알림은 한 트랜잭션(D1 은 batch)으로 함께 남거나 함께 되돌려진다 (K1 리뷰 #4, TC-K1.T3.g).
//     알림 없는 failed 는 아무도 모르는 실패라서다. 되돌려진 작업은 차지 시각(CLAIM_MS) 뒤 다시 집혀 실패 처리를 다시 한다.
//   - 실패 처리 자체가 계속 실패하면(알림 저장 장애 등) 차지 시각마다 다시 집힌다. attempts 가 RETRY_DELAYS_MS 길이 + 2 를
//     넘은 작업은 핸들러(OmniRoute 호출)를 다시 부르지 않고 실패 처리만 시도하며, 실패하면 onAlarm(경보)으로 올린다 (K1 재검토).
//   - 한 작업의 처리(쓰기) 예외는 그 작업에서 잡아 errors 로 세고 다음 작업으로 간다. tick 하나가 끊기지 않는다.
// 키별 순서 (K1 리뷰 #1, TC-K1.T3.f)
//   - key.apply_state 는 값을 싣지 않는다 (payload { keyId }). 실행할 때 api_keys·회원 상태로 목표를 다시 계산해 건다 (target.ts).
//     그래서 오래된 재시도가 더 새 반영을 덮지 않는다.
//   - 같은 키의 미완료 key.apply_state 가 있으면 새로 넣지 않고 그 작업에 합친다: generation + 1, attempts = 0(남은 시도 새로),
//     next_run_at = min(기존, 지금). 동시에 넣어 둘이 생겨도 둘 다 실행 시점의 목표를 걸므로 결과는 같다.
//   - 결과 쓰기(완료·재시도·실패)는 차지할 때 읽은 generation·attempts 가 그대로일 때만 한다. 실행 중에 합쳐졌으면 0행이고
//     (stale 로 센다) 합치기가 이미 next_run_at 을 당겨 두었으므로 곧바로 다시 돈다 — 새 목표로 (K1 재검토, TC-K1.T3.j·k).
//   - 같은 키에 미완료 key.delete 가 있으면 key.apply_state 는 켜지 않는다 (delete 가 이긴다).
// 차지 (TC-K1.T3.c)
//   - 실행기 둘이 동시에 돌아도 작업마다 핸들러는 한 번이다. 작업 하나를 "attempts 가 내가 읽은 값일 때만" 바꾸는 UPDATE 로
//     차지한다 (attempts + 1, next_run_at = 지금 + CLAIM_MS). 0행이면 다른 실행기가 먼저 차지한 것이다.
//   - 차지한 채 프로세스가 죽으면 CLAIM_MS 뒤에 다시 집힌다. 그 시도도 attempts 에 센다.
//   - 임대(lease)를 주면 모든 쓰기에 fenced() 를 붙인다. 임대를 잃은 실행기의 쓰기는 0행이다 (K1.T2).
//   - 임대를 잃어 신호가 끊긴 시도는 attempts 로 세지 않는다. 차지를 풀어 attempts·next_run_at 을 되돌린다 (K1 리뷰 #8).
//     대신 interrupts 를 1 올린다. 매번 끊기는 작업이 영원히 돌지 않게, MAX_INTERRUPTS 번 끊긴 작업은 다음에 차지한
//     실행기가 핸들러 없이 failed 로 둔다 (끊긴 쪽은 임대를 잃어 펜싱 쓰기를 못 한다, K1 재검토).
// last_error 에는 OmniRoute 오류 코드·상태만 남긴다. OmniRouteError.message 는 응답 본문 300자를 담아 관리 토큰·원문 키가
// 섞일 수 있다 (TC-K1.T3.e).
import { and, asc, eq, exists, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { OmniRouteError, OmniRouteFormatError } from "@magnetosphere/omniroute";
import { fenced, updatedRows, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle } from "@magnetosphere/runtime/types";

/** 재시도 간격 (ms). 계획서 v5.6 Q2 */
export const RETRY_DELAYS_MS = [60_000, 120_000, 600_000, 1_800_000] as const;
/** failed_at 에서 이만큼 지나면 오래 실패 (계획서 v5.6 Q3) */
export const LONG_FAILED_MS = 30 * 60_000;
/** 임대를 잃어 끊긴 횟수의 상한. 넘으면 failed (K1 재검토) */
export const MAX_INTERRUPTS = 5;
/** 차례 비교의 유예: next_run_at ≤ now + 이 값이면 돈다. 실행기 주기(1분)의 절반 */
export const DUE_GRACE_MS = 30_000;
/** 차지한 작업을 다른 실행기가 다시 집기까지. 핸들러 하나가 이보다 오래 걸리지 않는다 (OmniRoute 호출 제한 15초) */
export const CLAIM_MS = 5 * 60_000;
/**
 * key.delete 는 키를 끈 시각 + 2분 뒤에 잡는다. OmniRoute 는 끈 뒤 60초가 지나야 지울 수 있고(V18, 계획서 v5.6 5.2),
 * 실행기가 1분마다 돌고 차례 비교에 30초 유예가 있으므로, 2분이면 끈 뒤 90초가 지나기 전에는 집히지 않는다.
 */
export const KEY_DELETE_DELAY_MS = 120_000;

export const ACTIONS = ["key.apply_state", "key.delete", "budget.set", "key.rollback"] as const;
export type JobAction = (typeof ACTIONS)[number];

/** 작업 대상. keyId 는 api_keys.id — 재시도를 다 써도 실패하면 이 키의 sync_state 를 failed 로 둔다 */
export interface JobPayload {
  keyId?: string;
  [field: string]: unknown;
}

export interface QueuedJob {
  id: string;
  action: JobAction;
  payload: JobPayload;
  /** 이번 시도를 포함한 시도 횟수 */
  attempts: number;
  /** 차지할 때 읽은 세대. 결과 쓰기는 이 값이 그대로일 때만 */
  generation: number;
}

export type Handler = (payload: JobPayload, ctx: { job: QueuedJob; db: DbHandle; signal?: AbortSignal }) => Promise<void>;
export type Handlers = Record<JobAction, Handler>;

export interface EnqueueOptions {
  /** 처음 시도 시각 (기본 now). key.delete 는 꼭 준다 (끈 시각 + KEY_DELETE_DELAY_MS) */
  runAt?: Date;
  now?: Date;
}

/** 작업 하나를 넣는다. id 를 돌려준다 */
export async function enqueue(h: DbHandle, action: JobAction, payload: JobPayload, opts: EnqueueOptions = {}): Promise<string> {
  if (!ACTIONS.includes(action)) throw new TypeError(`모르는 작업: ${action}`);
  if (action === "key.delete" && !opts.runAt) throw new TypeError("key.delete 는 runAt(끈 시각 + KEY_DELETE_DELAY_MS)이 필요하다 (V18)");
  const keyId = typeof payload.keyId === "string" && payload.keyId !== "" ? payload.keyId : null;
  // key.* 는 모두 대상 키가 있어야 한다. key_id 가 NULL 이면 delete 우선·키별 합치기·실패 표시가 조용히 빠진다 (K1 재검토)
  if (action.startsWith("key.") && !keyId) throw new TypeError(`${action} 는 payload.keyId(api_keys.id)가 필요하다`);
  const t = h.schema.omnirouteJobs;
  if (action === "key.apply_state" && keyId) {
    // 값은 싣지 않는다. 넣는 쪽이 준 active 등은 버린다 (실행할 때 다시 계산한다)
    payload = { keyId };
    const at = opts.runAt ?? opts.now ?? new Date();
    // 고르고 바꾸는 사이에 그 작업이 끝나면(0행) 다시 고른다. 없으면 새로 넣는다
    for (let i = 0; i < 3; i++) {
      const [pending] = await h.db
        .select({ id: t.id, generation: t.generation, nextRunAt: t.nextRunAt })
        .from(t)
        .where(and(eq(t.keyId, keyId), eq(t.action, action), isNull(t.doneAt), isNull(t.failedAt)))
        .limit(1);
      if (!pending) break;
      const merged = await updatedRows(
        h,
        h.db
          .update(t)
          .set({ generation: pending.generation + 1, attempts: 0, nextRunAt: pending.nextRunAt < at ? pending.nextRunAt : at })
          .where(and(eq(t.id, pending.id), eq(t.generation, pending.generation), isNull(t.doneAt), isNull(t.failedAt))),
        t.id,
      );
      if (merged === 1) return pending.id;
    }
  }
  const id = crypto.randomUUID();
  await h.db.insert(t).values({ id, action, payload: JSON.stringify(payload), keyId, attempts: 0, nextRunAt: opts.runAt ?? opts.now ?? new Date() });
  return id;
}

/** 실패 기록. 비밀 값(관리 토큰 oma_live_…, 제공자 키 sk-…)을 지운 짧은 문자열 */
export function describeError(e: unknown): string {
  let s: string;
  if (e instanceof OmniRouteError) s = `OmniRoute ${e.status}${e.code ? ` ${e.code}` : ""}`;
  else if (e instanceof OmniRouteFormatError) s = "OmniRouteFormatError";
  else if (e instanceof Error) s = e.name;
  else s = "unknown";
  // 오류 코드도 응답 본문에서 온다. 비밀 값 모양은 남기지 않는다
  return redact(s).slice(0, 200);
}

const SECRET = /(oma_live_|sk-)[A-Za-z0-9_\-.]*/gi;
const redact = (s: string) => s.replace(SECRET, "[비밀 값 지움]");

export function isLongFailed(job: { failedAt: Date | null }, now: Date): boolean {
  return job.failedAt !== null && now.getTime() - job.failedAt.getTime() > LONG_FAILED_MS;
}

export interface RunDueOptions {
  /** 이 실행기의 임대. 주면 모든 쓰기를 펜싱한다 */
  lease?: Lease;
  /** 끊기면 다음 작업을 집지 않는다. 핸들러에도 넘긴다 */
  signal?: AbortSignal;
  /** 작업 결과 쓰기 실패 (기본 console.warn). 작업 id 와 오류. 차지 시각 뒤 다시 집힌다 */
  onError?: (jobId: string, e: unknown) => void;
  /** 재시도를 다 쓰고도 실패 처리를 거듭 못 쓰는 작업 (기본 console.error 경보). 운영자가 DB·알림 저장을 봐야 한다 */
  onAlarm?: (jobId: string, e: unknown) => void;
  /** 실패·완료 시각을 재는 시계 (기본: now 고정). 실행기는 실제 시계를 넘긴다. 재시도 간격은 실패 시각에서 잰다 */
  clock?: () => number;
}

export interface RunDueResult {
  done: number;
  retried: number;
  failed: number;
  /** 결과를 쓰지 못한 작업 수 (DB 오류). 차지 시각 뒤 다시 집힌다 */
  errors: number;
  /** 결과 쓰기가 0행인 작업 수 (실행 중에 합쳐져 세대가 바뀜·임대 상실). 시도로 세지 않는다 */
  stale: number;
}

/** 지금 돌 차례인 작업(done_at·failed_at NULL, next_run_at ≤ now + DUE_GRACE_MS)을 하나씩 차지해 돈다 */
export async function runDue(h: DbHandle, handlers: Handlers, now: Date, opts: RunDueOptions = {}): Promise<RunDueResult> {
  const t = h.schema.omnirouteJobs;
  const guard = (cond: SQL | undefined) => (opts.lease ? and(cond, fenced(h, opts.lease)) : cond);
  const result: RunDueResult = { done: 0, retried: 0, failed: 0, errors: 0, stale: 0 };
  const onError = opts.onError ?? ((id: string, e: unknown) => console.warn(`[queue] 작업 ${id} 결과를 쓰지 못했다. 차지 시각 뒤 다시 집는다`, e));
  const onAlarm =
    opts.onAlarm ?? ((id: string, e: unknown) => console.error(`[queue][경보] 작업 ${id}: 재시도를 다 쓴 뒤 실패 처리(failed_at·sync_state·alert)를 거듭 쓰지 못한다`, e));
  const clock = opts.clock ?? (() => now.getTime());
  const due = and(isNull(t.doneAt), isNull(t.failedAt), lte(t.nextRunAt, new Date(now.getTime() + DUE_GRACE_MS)));
  const missed = new Set<string>();
  for (;;) {
    if (opts.signal?.aborted) break;
    const [row] = await h.db.select().from(t).where(due).orderBy(asc(t.nextRunAt), asc(t.id)).limit(1);
    if (!row) break;
    const claimUntil = new Date(now.getTime() + CLAIM_MS);
    const claimed = await updatedRows(
      h,
      h.db
        .update(t)
        .set({ attempts: row.attempts + 1, nextRunAt: claimUntil })
        .where(guard(and(eq(t.id, row.id), eq(t.attempts, row.attempts), eq(t.generation, row.generation), due))),
      t.id,
    );
    if (claimed !== 1) {
      // 다른 실행기가 먼저 차지했다 (그러면 다음 select 에 이 작업이 없다). 임대를 잃었거나 같은 작업을 또 못 집으면 멈춘다
      if (opts.lease && !(await stillMine(h, opts.lease))) break;
      if (missed.has(row.id)) break;
      missed.add(row.id);
      continue;
    }
    // payload 를 못 읽거나 모르는 작업이면 다시 해도 같다. 재시도 없이 곧바로 failed 로 둔다 (K1 리뷰 #5, TC-K1.T3.h)
    let payload: JobPayload | null = null;
    let permanent: string | null = null;
    try {
      payload = JSON.parse(row.payload);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new SyntaxError("객체가 아니다");
    } catch {
      permanent = "payload JSON 아님";
    }
    // 표에 직접 있는 것만 핸들러다. "toString" 같은 프로토타입 이름이 함수로 불려 done 이 되지 않게 (K1 재검토)
    if (!permanent && !(Object.hasOwn(handlers, row.action) && typeof handlers[row.action as JobAction] === "function")) permanent = "모르는 작업";
    if (!permanent && row.interrupts >= MAX_INTERRUPTS) permanent = `임대를 ${MAX_INTERRUPTS}번 잃음`;
    // 실패 처리만 남은 작업: 재시도 다 씀(attempts = 길이 + 1) 뒤 실패 처리를 한 번 더 못 쓴 것까지 넘었다
    const failOnly = !permanent && row.attempts + 1 > RETRY_DELAYS_MS.length + 2;
    const job: QueuedJob = { id: row.id, action: row.action, payload: payload ?? { keyId: row.keyId ?? undefined }, attempts: row.attempts + 1, generation: row.generation };
    const mine = guard(and(eq(t.id, job.id), eq(t.attempts, job.attempts), eq(t.generation, job.generation), isNull(t.doneAt), isNull(t.failedAt)));
    const count = (n: number, key: "done" | "retried" | "failed") => (n === 1 ? result[key]++ : result.stale++);
    let outcome: unknown = null;
    if (!permanent && !failOnly) {
      try {
        await handlers[job.action](job.payload, { job, db: h, signal: opts.signal });
      } catch (e) {
        outcome = e ?? new Error("unknown");
      }
    }
    if (opts.signal?.aborted) {
      // 임대를 잃어 끊겼다 (K1 리뷰 #8, TC-K1.T3.i). 이 시도는 세지 않는다: 차지를 풀어 attempts·next_run_at 을 차지 전 값으로
      // 되돌린다. 펜싱하지 않는 대신 "내 차지가 그대로일 때"(attempts·next_run_at·미완료)만 바꾼다. 다른 실행기가 이 작업을
      // 다시 차지했거나 결과를 썼으면 0행이다. 끊긴 뒤에는 다음 작업을 집지 않는다
      await h.db
        .update(t)
        .set({ attempts: row.attempts, nextRunAt: row.nextRunAt, interrupts: row.interrupts + 1 })
        .where(and(eq(t.id, job.id), eq(t.attempts, job.attempts), eq(t.generation, job.generation), eq(t.nextRunAt, claimUntil), isNull(t.doneAt), isNull(t.failedAt)))
        .catch((e: unknown) => onError(job.id, e));
      break;
    }
    try {
      if (permanent) {
        count(await markFailed(h, row, job, permanent, new Date(clock()), opts.lease), "failed");
        continue;
      }
      if (failOnly) {
        try {
          count(await markFailed(h, row, job, row.lastError ?? "재시도 다 씀", new Date(clock()), opts.lease), "failed");
        } catch (e) {
          result.errors++;
          onAlarm(job.id, e);
        }
        continue;
      }
      if (outcome === null) {
        count(await updatedRows(h, h.db.update(t).set({ doneAt: new Date(clock()), lastError: null }).where(mine), t.id), "done");
        continue;
      }
      // 한 tick 안에서 앞 작업들이 오래 걸려 이 작업의 실패가 늦게 적혀도(실패 시각 = clock()) 간격은 그 시각에서 잰다.
      // 그 사이 OmniRoute 상태가 목표와 어긋난 채로 남는 시간은 다음 시도 또는 5분 정합성 점검(K3.T3)이 맞춘다
      const lastError = describeError(outcome);
      const failedTime = clock();
      if (job.attempts <= RETRY_DELAYS_MS.length) {
        count(await updatedRows(h, h.db.update(t).set({ lastError, nextRunAt: new Date(failedTime + RETRY_DELAYS_MS[job.attempts - 1]) }).where(mine), t.id), "retried");
      } else {
        // 4번째 재시도도 실패. next_run_at 은 이번 시도 전 값으로 되돌린다 (차지할 때 바꾼 값)
        count(await markFailed(h, row, job, lastError, new Date(failedTime), opts.lease), "failed");
      }
    } catch (e) {
      result.errors++;
      onError(job.id, e);
    }
  }
  return result;
}

async function stillMine(h: DbHandle, lease: Lease): Promise<boolean> {
  const t = h.schema.jobLeases;
  const rows = await h.db.select({ fence: t.fence }).from(t).where(and(eq(t.name, lease.name), eq(t.holder, lease.holder), eq(t.fence, lease.fence)));
  return rows.length === 1;
}

/**
 * 재시도를 다 쓴 작업: failed_at, 대상 키 sync_state = failed, 알림(audit_log alert.job_failed)을 한 번에 쓴다 (계획서 v5.6 Q3·Q6).
 * 셋 다 "이 작업이 내 차지(attempts·generation)이고 임대가 내 것"일 때만 바뀐다. 첫 문장이 바꾼 행 수(0 또는 1)를 돌려준다. 첫 문장이 0행이면 뒤 두 문장도 0행이다
 * (뒤 문장은 "이 차지의 failed_at 이 찍혔다"를 조건으로 둔다). sqlite·mysql·pg 는 트랜잭션, D1 은 batch(한 트랜잭션)로 돈다.
 */
async function markFailed(h: DbHandle, row: { nextRunAt: Date }, job: QueuedJob, lastError: string, at: Date, lease: Lease | undefined): Promise<number> {
  const s = h.schema;
  const t = s.omnirouteJobs;
  const fence = lease ? fenced(h, lease) : undefined;
  const claimed = and(eq(t.id, job.id), eq(t.attempts, job.attempts), eq(t.generation, job.generation), isNull(t.doneAt), isNull(t.failedAt), fence);
  const failedNow = and(eq(t.id, job.id), eq(t.attempts, job.attempts), eq(t.generation, job.generation), isNotNull(t.failedAt));
  const keyId = typeof job.payload.keyId === "string" && job.payload.keyId !== "" ? job.payload.keyId : null;
  const detail = JSON.stringify({ action: job.action, attempts: job.attempts, keyId, error: lastError });
  const statements = (db: any) => [
    db.update(t).set({ lastError, failedAt: at, nextRunAt: row.nextRunAt }).where(claimed),
    ...(keyId ? [db.update(s.apiKeys).set({ syncState: "failed" }).where(and(eq(s.apiKeys.id, keyId), exists(db.select({ one: sql`1` }).from(t).where(failedNow))))] : []),
    db.insert(s.auditLog).select(
      db
        .select({
          id: sql`${crypto.randomUUID()}`.as("id"),
          actorId: sql`null`.as("actor_id"),
          action: sql`${"alert.job_failed"}`.as("action"),
          target: t.id,
          detail: sql`${detail}`.as("detail"),
          ip: sql`null`.as("ip"),
          createdAt: t.failedAt,
        })
        .from(t)
        .where(failedNow),
    ),
  ];
  if (h.kind === "d1") {
    const res = await h.db.batch(statements(h.db));
    return Number(res[0]?.meta?.changes ?? 0);
  }
  return h.db.transaction(async (tx: any) => {
    const [first, ...rest] = statements(tx);
    const n = await updatedRows(h, first, t.id);
    for (const q of rest) await q;
    return n;
  });
}
