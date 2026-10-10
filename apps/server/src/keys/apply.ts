// 반영 applyKey (계획서 v5.7 5.2·5.7, K3.T2). 키 하나를 목표 상태(target.ts)로 OmniRoute 에 건다.
// 요청 안(K4 회원 키 API)·1분 분배의 limit 끄기·켜기·작업 큐 key.apply_state·5분 정합성 점검이 모두 이것을 부른다.
//
// 한 번의 반영
//   1. 목표를 DB 에서 읽는다 (넣을 때 값을 싣지 않는다. 실행할 때 다시 계산한다, K1 리뷰 #1).
//   2. DB 의 키 상태를 회원 상태에 맞춘다: 회원 deleted → 키 state deleted·deleted_at, 회원이 active 가 아니면 켜진 키를
//      disabled·user_status 로, 다시 active 면 user_status 로 꺼진 키를 active 로 (5.7 "정지를 풀면 user_status 키만").
//   3. 켜기라면 먼저 예산을 건다: 즉시 분배 rebalanceMember (분석 → setBudget). 월 한도가 없고 걸린 예산도 없으면 건너뛴다.
//      분배가 남은 한도 0 을 보면 이 키를 limit 으로 끄므로 목표를 다시 읽는다 ("끄기 → 예산 → 켜기", 5.2·5.3).
//   4. setKeyActive. 끄기는 이미 없는 키(404)를 성공으로 본다. 정합성 점검처럼 OmniRoute 의 실제 값(actual)을 알면 같을 때 부르지 않는다.
//   5. 목표가 삭제됨이면 key.delete 를 끈 시각 + 2분으로 잡는다 (V18: 끈 뒤 60초가 지나야 DELETE 해도 옛 원문 키가 다시 열리지 않는다).
//      이미 기다리는 key.delete 가 있으면 새로 넣지 않고, 이번에 껐는데 그 작업이 더 이르면 끈 시각 + 2분으로 늦춘다
//      (누가 OmniRoute 에서 다시 켠 키를 방금 끈 경우).
//   6. sync_state = synced 는 "읽은 뒤로 키 state·disabled_reason·회원 status 가 그대로일 때만" 쓴다. 0행이면 그사이 목표가
//      바뀐 것이라 처음부터 다시 한다 (APPLY_ROUNDS 번까지). 걸고 나서 다시 읽으므로, 그사이 더 새 반영이 먼저 OmniRoute 에
//      닿고 내 호출이 늦게 닿았어도 다음 바퀴가 새 목표로 다시 건다.
// 실패
//   - OmniRoute(또는 켜기 전 예산) 실패: sync_state pending, 작업 큐 key.apply_state 를 지금 + 1분으로 (Q2). 큐가 같은 키 작업에 합친다.
//     작업 큐 핸들러 안(inQueue)에서는 큐에 넣지 않고 던진다 — 큐의 재시도 간격이 그대로 이어지고, 자기 작업에 합쳐 같은 tick 에서
//     끝없이 다시 집히는 일이 없다.
//   - APPLY_ROUNDS 번 모두 목표가 바뀌면 pending 으로 두고 큐(요청)·5분 점검(큐 안)에 맡긴다. 끝없이 돌지 않는다.
//   - 임대를 잃으면(signal) 아무것도 적지 않고 던진다. 임대가 있으면 DB 쓰기는 모두 펜싱한다.
// 실패해도 켜지 않는다: 목표를 읽지 못하면 OmniRoute 를 부르지 않고 던진다 (fail-closed).
import { and, eq, exists, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { OmniRouteError } from "@magnetosphere/omniroute";
import { LeaseLostError, updatedRows, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle } from "@magnetosphere/runtime/types";
import type { ClientFor } from "../limits/daily.ts";
import { rebalanceMember } from "../limits/member.ts";
import type { LimitsClient } from "../limits/rebalance.ts";
import { guard, holds } from "../limits/store.ts";
import { enqueue, KEY_DELETE_DELAY_MS, RETRY_DELAYS_MS } from "../queue/index.ts";
import { alertOnce } from "./alerts.ts";
import { readTarget, targetState, type KeyTarget, type KeyTargetRow } from "./target.ts";

/** 걸고 다시 읽기 횟수 상한 */
export const APPLY_ROUNDS = 3;

export interface ApplyOptions {
  /** 어댑터 (켜기 전 예산 때문에 분석·예산 함수도 쓴다) */
  client: ClientFor<LimitsClient>;
  /** 주기 작업의 임대. 주면 DB 쓰기를 펜싱한다 */
  lease?: Lease;
  /** 임대를 잃으면 끊긴다. 끊긴 뒤에는 OmniRoute 를 부르지 않는다 */
  signal?: AbortSignal;
  /** 반영 시각 (큐 재시도·deleted_at·즉시 분배의 분석 끝). 기본 지금 */
  now?: Date;
  /** 끈 시각을 재는 시계 (key.delete 시각). 기본: now 를 주었으면 그 값, 아니면 실제 시계 */
  clock?: () => number;
  /**
   * OmniRoute 의 실제 isActive (정합성 점검이 listKeys 로 읽은 값). 모르면 늘 건다.
   * 목록은 점검 처음에 읽은 옛 값일 수 있어, 키 sync_state 가 synced 가 아니면(반영 중·실패) 이 값을 믿지 않고 건다 (K3 리뷰 #4)
   */
  actual?: boolean;
  /** 예산을 방금 걸었다 (1분 분배의 limit 켜기). 켜기 전 즉시 분배를 건너뛴다 */
  budgetReady?: boolean;
  /** 작업 큐 핸들러 안에서 부른다. 실패하면 큐에 넣지 않고 던진다 */
  inQueue?: boolean;
}

export interface ApplyResult {
  /** 마지막으로 건 목표. 키 행이 없으면 null */
  target: KeyTarget | null;
  /**
   * synced: 목표가 OmniRoute 에 걸렸다. pending: 실패했거나 목표가 계속 바뀌어 큐·점검이 다시 건다.
   * missing: 켜려는데 OmniRoute 에 그 키가 없다(404). sync_state missing·alert.key_missing, 다시 만들지 않는다
   */
  syncState: "synced" | "pending" | "missing";
  /** setKeyActive 를 부른 횟수 */
  calls: number;
}

/** 회원·관리자가 켜기를 요청했지만 목표가 켜짐이 아니다 (회원 키 API 는 409) */
export class KeyConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "KeyConflictError";
  }
}

const userIs = (h: DbHandle, userId: string, cond: SQL) => exists(h.db.select({ one: sql`1` }).from(h.schema.user).where(and(eq(h.schema.user.id, userId), cond)));

/** 키 state 를 회원 상태에 맞춘다 (위 2번). 바꿨으면 true */
async function normalize(h: DbHandle, lease: Lease | undefined, cur: KeyTargetRow, now: Date): Promise<boolean> {
  const k = h.schema.apiKeys;
  const u = h.schema.user;
  let set: Record<string, unknown>;
  let cond: SQL | undefined;
  if (cur.userStatus === "deleted" && cur.keyState !== "deleted") {
    set = { state: "deleted", deletedAt: now };
    cond = and(ne(k.state, "deleted"), userIs(h, cur.userId, eq(u.status, "deleted")));
  } else if (cur.userStatus !== "active" && cur.userStatus !== "deleted" && cur.keyState === "active" && cur.disabledReason === null) {
    set = { state: "disabled", disabledReason: "user_status" };
    cond = and(eq(k.state, "active"), isNull(k.disabledReason), userIs(h, cur.userId, ne(u.status, "active")));
  } else if (cur.userStatus === "active" && cur.keyState === "disabled" && cur.disabledReason === "user_status") {
    set = { state: "active", disabledReason: null };
    cond = and(eq(k.state, "disabled"), eq(k.disabledReason, "user_status"), userIs(h, cur.userId, eq(u.status, "active")));
  } else {
    return false;
  }
  return (await updatedRows(h, h.db.update(k).set(set).where(guard(h, lease, and(eq(k.id, cur.keyId), cond))), k.id)) === 1;
}

/** 읽은 뒤로 키 state·disabled_reason·회원 status 가 그대로일 때만 synced. 적었으면 true */
async function markSynced(h: DbHandle, lease: Lease | undefined, cur: KeyTargetRow): Promise<boolean> {
  const k = h.schema.apiKeys;
  const same = and(
    eq(k.id, cur.keyId),
    eq(k.state, cur.keyState),
    cur.disabledReason === null ? isNull(k.disabledReason) : eq(k.disabledReason, cur.disabledReason),
    userIs(h, cur.userId, eq(h.schema.user.status, cur.userStatus)),
  );
  return (await updatedRows(h, h.db.update(k).set({ syncState: "synced" }).where(guard(h, lease, same)), k.id)) === 1;
}

/** OmniRoute 에서 404 인가 (키가 없다) */
export const isMissing = (e: unknown) => e instanceof OmniRouteError && e.status === 404;

/**
 * OmniRoute 에서 사라진 키 (켜기·예산이 404, K3 리뷰 #6). 매핑에 sync_state missing 을 적고 alert.key_missing 을 하루 한 번 남긴다.
 * 키를 다시 만들지 않는다 (원문 키가 바뀌어 회원 도구가 깨진다. 관리자가 본다). 다른 키의 반영은 계속한다
 */
export async function markMissing(h: DbHandle, lease: Lease | undefined, key: { keyId: string; omnirouteKeyId: string }, now: Date): Promise<void> {
  const k = h.schema.apiKeys;
  await h.db.update(k).set({ syncState: "missing" }).where(guard(h, lease, eq(k.id, key.keyId)));
  await alertOnce(h, lease, "key_missing", key.omnirouteKeyId, { keyId: key.keyId }, now);
}

async function markPending(h: DbHandle, lease: Lease | undefined, keyId: string): Promise<void> {
  const k = h.schema.apiKeys;
  await h.db.update(k).set({ syncState: "pending" }).where(guard(h, lease, eq(k.id, keyId)));
}

/** 켜기·끄기. 끄기는 이미 없는 키(404)를 성공으로 본다 (지운 뒤 늦게 온 반영) */
async function setActive(client: LimitsClient, id: string, active: boolean): Promise<void> {
  try {
    await client.setKeyActive(id, active);
  } catch (e) {
    if (!(!active && e instanceof OmniRouteError && e.status === 404)) throw e;
  }
}

/** 끈 뒤 2분에 지운다 (위 5번). 이번에 끄지 않았으면(이미 꺼짐) 기다리는 작업의 시각을 늦추지 않는다 */
async function scheduleDelete(h: DbHandle, lease: Lease | undefined, cur: KeyTargetRow, offAt: number, turnedOff: boolean): Promise<void> {
  const j = h.schema.omnirouteJobs;
  const runAt = new Date(offAt + KEY_DELETE_DELAY_MS);
  const [pending] = await h.db
    .select({ id: j.id, nextRunAt: j.nextRunAt })
    .from(j)
    .where(and(eq(j.keyId, cur.keyId), eq(j.action, "key.delete"), isNull(j.doneAt), isNull(j.failedAt)))
    .limit(1);
  if (pending) {
    if (turnedOff && pending.nextRunAt < runAt) {
      await h.db.update(j).set({ nextRunAt: runAt }).where(guard(h, lease, and(eq(j.id, pending.id), isNull(j.doneAt), isNull(j.failedAt), lt(j.nextRunAt, runAt))));
    }
    return;
  }
  if (lease && !(await holds(h, lease))) throw new LeaseLostError(lease);
  await enqueue(h, "key.delete", { keyId: cur.keyId, omnirouteKeyId: cur.omnirouteKeyId }, { runAt });
}

/** 켜기 전에 예산을 걸어야 하는가: 월 한도가 있거나, 예산이 걸려 있을 수 있다 (값을 앎 또는 걸다가 모르게 됨) */
const needsBudget = (cur: KeyTargetRow) => cur.monthlyLimitUsd !== null || cur.budgetUsd !== null || (cur.budgetMonth === null && cur.budgetAt !== null);

export async function applyKey(h: DbHandle, keyId: string, opts: ApplyOptions): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? (() => (opts.now ? opts.now.getTime() : Date.now()));
  const stopIfLost = () => {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("임대를 잃었다");
  };
  let actual = opts.actual;
  let budgeted = opts.budgetReady === true;
  let calls = 0;
  let last: KeyTarget | null = null;
  try {
    for (let round = 0; round < APPLY_ROUNDS; round++) {
      stopIfLost();
      let cur = await readTarget(h, keyId);
      // 반영 중·실패한 키는 목록의 옛 값을 믿지 않는다 (예산 단계도 실제 값을 모르는 것으로 본다)
      if (round === 0 && cur && cur.syncState !== "synced") actual = undefined;
      if (cur && (await normalize(h, opts.lease, cur, now))) cur = await readTarget(h, keyId);
      if (cur && cur.target === "on" && !cur.deletePending && actual !== true && !budgeted && needsBudget(cur)) {
        stopIfLost();
        await rebalanceMember(h, cur.userId, { now, client: opts.client });
        budgeted = true;
        // 남은 한도 0 이면 분배가 이 키를 limit 으로 껐다
        cur = await readTarget(h, keyId);
      }
      if (!cur) return { target: null, syncState: "synced", calls };
      last = cur.target;
      const active = cur.target === "on" && !cur.deletePending;
      const call = actual !== active;
      if (call) {
        stopIfLost();
        calls++;
        try {
          await setActive(opts.client(), cur.omnirouteKeyId, active);
        } catch (e) {
          if (!(active && isMissing(e))) throw e;
          await markMissing(h, opts.lease, cur, now);
          return { target: cur.target, syncState: "missing", calls };
        }
      }
      actual = active;
      if (cur.target === "deleted") await scheduleDelete(h, opts.lease, cur, clock(), call);
      if (await markSynced(h, opts.lease, cur)) return { target: cur.target, syncState: "synced", calls };
    }
  } catch (e) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? e;
    if (e instanceof LeaseLostError) throw e;
    await markPending(h, opts.lease, keyId);
    if (opts.inQueue) throw e;
    await enqueue(h, "key.apply_state", { keyId }, { runAt: new Date(now.getTime() + RETRY_DELAYS_MS[0]), now });
    return { target: last, syncState: "pending", calls };
  }
  // 걸 때마다 목표가 바뀌었다. 요청 쪽은 큐가 1분 뒤에, 큐 안이면 5분 점검이 맞춘다
  await markPending(h, opts.lease, keyId);
  if (!opts.inQueue) await enqueue(h, "key.apply_state", { keyId }, { runAt: new Date(now.getTime() + RETRY_DELAYS_MS[0]), now });
  return { target: last, syncState: "pending", calls };
}

/**
 * 회원(member)·관리자(admin)가 자기가 끈 키를 켜 달라는 요청 (K4 회원 키 API 가 부른다).
 * 그 이유를 지웠을 때 목표가 켜짐이 아니면(회원 정지, 남이 끈 키, 삭제한 키) KeyConflictError(409) — DB 도 OmniRoute 도 건드리지 않는다.
 * 켜짐이면 state active·disabled_reason NULL 로 적고 applyKey (켜기 전에 예산을 건다).
 */
export async function requestEnable(h: DbHandle, keyId: string, by: "member" | "admin", opts: ApplyOptions): Promise<ApplyResult> {
  const cur = await readTarget(h, keyId);
  if (!cur) throw new KeyConflictError("키가 없다");
  const mine = cur.keyState === "active" || (cur.keyState === "disabled" && cur.disabledReason === by);
  const after = targetState({ keyState: "active", disabledReason: null, userStatus: cur.userStatus, remaining: null });
  if (!mine || after !== "on" || cur.deletePending) throw new KeyConflictError(`키를 켤 수 없다 (키 ${cur.keyState}/${cur.disabledReason ?? "-"}, 회원 ${cur.userStatus})`);
  if (cur.keyState === "disabled") {
    const k = h.schema.apiKeys;
    const n = await updatedRows(
      h,
      h.db
        .update(k)
        .set({ state: "active", disabledReason: null })
        .where(guard(h, opts.lease, and(eq(k.id, keyId), eq(k.state, "disabled"), eq(k.disabledReason, by), userIs(h, cur.userId, eq(h.schema.user.status, "active"))))),
      k.id,
    );
    if (n !== 1) throw new KeyConflictError("키 상태가 그사이 바뀌었다");
  }
  return applyKey(h, keyId, opts);
}
