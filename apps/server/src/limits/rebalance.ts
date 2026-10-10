// 1분 분배 budget_rebalance (계획서 v5.7 5.3, K2.T6). jobs.ts 가 "* * * * *" 로 등록한다 (임대·하트비트 아래).
//
// 한 번 실행
//   1. 날이 바뀐 첫 실행이면 어제를 확정하고 이번 달을 대조한다 (daily.ts confirmDays).
//   2. 분배 대상: 상태 active 인 회원 중 켜진 키가 있거나 limit 으로 꺼진 키가 있는 회원. 그 회원의 키는 삭제한 키까지 모두 센다.
//   3. 분석은 오늘 창 하나만 부른다: startDate 오늘 00:00 UTC, endDate 지금, apiKeyIds 없음 (V15 decision).
//      byApiKey 를 매핑(api_keys.omniroute_key_id)으로 회원별로 묶는다. 회원 사용액 = usage_daily 이번 달 1일 ~ 어제 합 + 오늘 창.
//   4. 회원마다 computeBudgets → applyMember.
//   분석·날 확정이 OmniRouteError·OmniRouteFormatError 면 그대로 던진다. 그 실행은 예산·키를 하나도 바꾸지 않는다.
//
// 키 하나의 반영 (applyMember, 즉시 분배 member.ts 도 같이 쓴다)
//   - exhausted(남은 한도 0): 켜진 키를 state disabled·disabled_reason limit 으로 적고 setKeyActive(false) (Q1).
//     끄기가 실패하면 작업 큐 key.apply_state 에 넣는다 (키 목표가 꺼짐이라 큐가 다시 끈다, 계획서 5.7).
//   - 켜진 키: 예산이 budget_usd 와 다를 때만 setBudget (매분 키마다 보내지 않는다). 새 달 첫 실행은 같아도 다시 건다
//     (OmniRoute 월 지출이 1일 00:00 UTC 에 초기화된다, V20).
//   - limit 으로 꺼진 키: 예산을 먼저 건 뒤 setKeyActive(true), state active·disabled_reason NULL. 회원·관리자·회원 상태로 꺼진 키는
//     건드리지 않는다. 월 한도가 NULL(무제한)이면 예산 없이 켠다.
//   - 이 끄기·켜기는 K3.T2 applyKey 가 생기면 그것으로 바꾼다.
// 겹침 막기 (K2.T4)
//   - api_keys.budget_at 은 그 키의 예산·limit 끄기를 계산한 분석 시각이다. 쓰기는 budget_at 이 비었거나 내 분석 시각보다 이를 때만
//     한다. 늦게 끝난 옛 계산(분석 시각이 이른 쪽)의 쓰기는 0행이고 OmniRoute 도 부르지 않는다.
//   - 예산 쓰기 → setBudget 순서라, 그사이 더 새 계산이 끼면 내 setBudget 이 OmniRoute 에 늦게 닿을 수 있다. 부른 뒤 budget_at 이
//     바뀌었으면 budget_usd 를 비워 다음 1분 분배가 다시 건다. setBudget 이 실패해도 비운다.
//   - 1분 분배는 임대가 있으므로 모든 쓰기에 펜싱을 붙인다 (store.ts).
import { and, eq, isNull, lt, or, type SQL } from "drizzle-orm";
import { createClient } from "@magnetosphere/omniroute";
import { createCipher } from "@magnetosphere/runtime/crypto";
import { updatedRows, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle, Job, Runtime } from "@magnetosphere/runtime/types";
import { requireSecret } from "../config.ts";
import { enqueue } from "../queue/index.ts";
import { readOmniRouteToken } from "../setup/omniroute.ts";
import { computeBudgets } from "./compute.ts";
import { confirmDays, costsOf, coveredUntil, storedSpent, type AnalyticsClient, type ClientFor, type ConfirmResult } from "./daily.ts";
import { monthChanged, monthKey, monthStart, REBALANCE_MONTH_KEY } from "./month.ts";
import { guard, readSetting, writeSetting } from "./store.ts";

/** OmniRoute 호출 하나의 제한 시간 (어댑터 기본값과 같다) */
const CALL_TIMEOUT_MS = 15_000;
/** budget_usd 와 새 예산이 이 안이면 같다 (DECIMAL(12,6) 반올림) */
const SAME_USD = 5e-7;

/** 분배가 쓰는 어댑터 함수 */
export interface LimitsClient extends AnalyticsClient {
  setBudget(id: string, budget: { monthlyUsd: number }): Promise<void>;
  setKeyActive(id: string, active: boolean): Promise<void>;
}

export interface KeyRow {
  id: string;
  userId: string;
  omnirouteKeyId: string;
  state: string;
  disabledReason: string | null;
  budgetUsd: number | null;
  budgetAt: Date | null;
}

export interface MemberRow {
  id: string;
  monthlyLimitUsd: number | null;
}

export interface ApplyCounts {
  setBudget: number;
  off: number;
  on: number;
  /** OmniRoute 호출이 실패한 키 수 (끄기는 작업 큐에 넣었다) */
  failed: number;
  /** 더 새 계산이 이미 쓴 키 수 (budget_at 이 내 분석 시각 이후) */
  stale: number;
}

export interface ApplyContext {
  h: DbHandle;
  client: ClientFor<LimitsClient>;
  /** 이 계산의 분석 시각 (budget_at 에 쓴다) */
  at: Date;
  lease?: Lease;
  signal?: AbortSignal;
  /** 새 달: 예산이 같아도 다시 건다 */
  force?: boolean;
  counts: ApplyCounts;
}

export const emptyCounts = (): ApplyCounts => ({ setBudget: 0, off: 0, on: 0, failed: 0, stale: 0 });

const toKey = (r: any): KeyRow => ({
  id: r.id,
  userId: r.userId,
  omnirouteKeyId: r.omnirouteKeyId,
  state: r.state,
  disabledReason: r.disabledReason ?? null,
  budgetUsd: r.budgetUsd == null ? null : Number(r.budgetUsd),
  budgetAt: r.budgetAt ?? null,
});

/** 회원 상태 active 인 회원의 키 전부 (삭제 포함)와 월 한도. userId 를 주면 그 회원만 */
export async function loadMembers(h: DbHandle, userId?: string): Promise<{ member: MemberRow; keys: KeyRow[] }[]> {
  const k = h.schema.apiKeys;
  const u = h.schema.user;
  const where = userId ? and(eq(u.status, "active"), eq(u.id, userId)) : eq(u.status, "active");
  const rows = await h.db
    .select({
      id: k.id,
      userId: k.userId,
      omnirouteKeyId: k.omnirouteKeyId,
      state: k.state,
      disabledReason: k.disabledReason,
      budgetUsd: k.budgetUsd,
      budgetAt: k.budgetAt,
      limitUsd: u.monthlyLimitUsd,
    })
    .from(k)
    .innerJoin(u, eq(u.id, k.userId))
    .where(where);
  const byUser = new Map<string, { member: MemberRow; keys: KeyRow[] }>();
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, { member: { id: r.userId, monthlyLimitUsd: r.limitUsd == null ? null : Number(r.limitUsd) }, keys: [] });
    byUser.get(r.userId)!.keys.push(toKey(r));
  }
  return [...byUser.values()];
}

/** 분배 대상: 켜진 키나 limit 으로 꺼진 키가 있다 */
export const needsRebalance = (keys: readonly KeyRow[]) => keys.some((k) => k.state === "active" || (k.state === "disabled" && k.disabledReason === "limit"));

const olderThan = (h: DbHandle, at: Date): SQL | undefined => or(isNull(h.schema.apiKeys.budgetAt), lt(h.schema.apiKeys.budgetAt, at));

/** 그 키 행을 바꾼다 (펜싱). 바꾼 행 수 */
async function updateKey(c: ApplyContext, keyId: string, set: Record<string, unknown>, cond: SQL | undefined): Promise<number> {
  const k = c.h.schema.apiKeys;
  return updatedRows(c.h, c.h.db.update(k).set(set).where(guard(c.h, c.lease, and(eq(k.id, keyId), cond))), k.id);
}

const lost = (c: ApplyContext, e: unknown) => {
  if (c.signal?.aborted) throw c.signal.reason ?? e;
};

/** 예산을 쓰고 OmniRoute 에 건다. 걸었으면 true */
async function setKeyBudget(c: ApplyContext, key: KeyRow, monthlyUsd: number): Promise<boolean> {
  const k = c.h.schema.apiKeys;
  if ((await updateKey(c, key.id, { budgetUsd: monthlyUsd, budgetAt: c.at }, olderThan(c.h, c.at))) !== 1) {
    c.counts.stale++;
    return false;
  }
  try {
    await c.client().setBudget(key.omnirouteKeyId, { monthlyUsd });
  } catch (e) {
    lost(c, e);
    // OmniRoute 에는 옛 예산이 남았다. 비워 두면 다음 1분 분배가 다시 건다
    await updateKey(c, key.id, { budgetUsd: null }, eq(k.budgetAt, c.at));
    c.counts.failed++;
    return false;
  }
  c.counts.setBudget++;
  // 부르는 사이 더 새 계산이 budget_at 을 바꿨으면 내 setBudget 이 그쪽 것을 덮었을 수 있다. 비워서 다음 분배가 다시 걸게 한다
  const [now] = await c.h.db.select({ at: k.budgetAt }).from(k).where(eq(k.id, key.id));
  if (now && (now.at === null || new Date(now.at).getTime() !== c.at.getTime())) await updateKey(c, key.id, { budgetUsd: null }, undefined);
  return true;
}

/** 켜진 키를 limit 으로 끈다 (남은 한도 0, Q1) */
async function turnOff(c: ApplyContext, key: KeyRow): Promise<void> {
  const k = c.h.schema.apiKeys;
  const claimed = await updateKey(c, key.id, { state: "disabled", disabledReason: "limit", budgetAt: c.at }, and(eq(k.state, "active"), olderThan(c.h, c.at)));
  if (claimed !== 1) {
    c.counts.stale++;
    return;
  }
  try {
    await c.client().setKeyActive(key.omnirouteKeyId, false);
    c.counts.off++;
  } catch (e) {
    lost(c, e);
    // DB 목표는 이미 꺼짐이다. 작업 큐가 1·2·10·30분 간격으로 다시 끈다 (계획서 5.7)
    await enqueue(c.h, "key.apply_state", { keyId: key.id }, { now: c.at });
    c.counts.failed++;
  }
}

/** limit 으로 꺼진 키를 켠다. budgetClaimed 면 setKeyBudget 이 이미 budget_at 을 내 분석 시각으로 썼다 */
async function turnOn(c: ApplyContext, key: KeyRow, budgetClaimed: boolean): Promise<void> {
  const k = c.h.schema.apiKeys;
  const limitOff = and(eq(k.state, "disabled"), eq(k.disabledReason, "limit"));
  if (!budgetClaimed && (await updateKey(c, key.id, { budgetAt: c.at }, and(limitOff, olderThan(c.h, c.at)))) !== 1) {
    c.counts.stale++;
    return;
  }
  try {
    await c.client().setKeyActive(key.omnirouteKeyId, true);
  } catch (e) {
    lost(c, e);
    c.counts.failed++;
    return;
  }
  if ((await updateKey(c, key.id, { state: "active", disabledReason: null }, and(limitOff, eq(k.budgetAt, c.at)))) === 1) c.counts.on++;
  else c.counts.stale++;
}

/** 회원 하나의 키에 계산 결과를 건다. spent 는 OmniRoute 키 id → 이번 달 사용액 */
export async function applyMember(c: ApplyContext, member: MemberRow, keys: readonly KeyRow[], spent: ReadonlyMap<string, number>): Promise<void> {
  const r = computeBudgets({ limitUsd: member.monthlyLimitUsd, keys: keys.map((k) => ({ id: k.id, state: k.state, spentUsd: spent.get(k.omnirouteKeyId) ?? 0 })) });
  for (const key of keys) {
    if (c.signal?.aborted) throw c.signal.reason;
    if (r.exhausted) {
      if (key.state === "active") await turnOff(c, key);
      continue;
    }
    const want = r.budgets.get(key.id);
    if (key.state === "active") {
      if (want === undefined) continue;
      if (!c.force && key.budgetUsd !== null && Math.abs(key.budgetUsd - want) < SAME_USD) continue;
      await setKeyBudget(c, key, want);
    } else if (key.state === "disabled" && key.disabledReason === "limit") {
      // 예산을 먼저 건 뒤 켠다. 예산 없이 먼저 켜면 다음 분배까지 한도 밖 사용이 열린다
      if (want !== undefined && !(await setKeyBudget(c, key, want))) continue;
      await turnOn(c, key, want !== undefined);
    }
  }
}

export interface RebalanceDeps {
  db: DbHandle;
  now: Date;
  client: ClientFor<LimitsClient>;
  lease?: Lease;
  signal?: AbortSignal;
}

export interface RebalanceResult extends ApplyCounts {
  members: number;
  monthChanged: boolean;
  confirm: ConfirmResult;
}

/** 1분 분배 한 번 */
export async function rebalanceAll(d: RebalanceDeps): Promise<RebalanceResult> {
  const h = d.db;
  const confirm = await confirmDays(h, d.now, d.client, { lease: d.lease, signal: d.signal });
  const changed = monthChanged(await readSetting<string>(h, REBALANCE_MONTH_KEY), d.now);
  const members = (await loadMembers(h)).filter((m) => needsRebalance(m.keys));
  const counts = emptyCounts();
  if (members.length > 0) {
    const from = await coveredUntil(h, d.now);
    const ids = members.flatMap((m) => m.keys.map((k) => k.omnirouteKeyId));
    const today = costsOf(await d.client().getAnalytics({ startDate: from, endDate: d.now }), new Set(ids));
    const stored = await storedSpent(h, ids, monthStart(d.now), from);
    const spent = new Map(ids.map((id) => [id, (stored.get(id) ?? 0) + (today.get(id) ?? 0)]));
    const c: ApplyContext = { h, client: d.client, at: d.now, lease: d.lease, signal: d.signal, force: changed, counts };
    for (const m of members) await applyMember(c, m.member, m.keys, spent);
  }
  if (changed) await writeSetting(h, REBALANCE_MONTH_KEY, monthKey(d.now), d.now, d.lease);
  return { ...counts, members: members.length, monthChanged: changed, confirm };
}

/** jobs.ts 의 budget_rebalance 본문. OmniRoute 연결(주소 + 설치 때 저장한 관리 토큰)이 없으면 할 일이 없다 */
export function rebalanceJob(rt: Runtime): Job {
  return async ({ db, lease, signal }) => {
    const baseUrl = rt.secret("OMNIROUTE_URL");
    if (!baseUrl) return;
    const token = await readOmniRouteToken(db, await createCipher(requireSecret(rt, "APP_ENCRYPTION_KEY")));
    if (!token) return;
    // 호출마다 임대 신호(임대를 잃으면 끊김)와 제한 시간 중 먼저 오는 쪽으로 끊는다. 대조는 제한 시간을 따로 준다 (daily.ts)
    const client: ClientFor<LimitsClient> = (o) =>
      createClient({ baseUrl, credential: { token }, signal: AbortSignal.any([signal, AbortSignal.timeout(o?.timeoutMs ?? CALL_TIMEOUT_MS)]) });
    await rebalanceAll({ db, now: new Date(), client, lease, signal });
  };
}
