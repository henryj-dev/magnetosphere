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
import { LeaseLostError, updatedRows, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle, Job, Runtime } from "@magnetosphere/runtime/types";
import { requireSecret } from "../config.ts";
import { describeError, enqueue } from "../queue/index.ts";
import { readOmniRouteToken } from "../setup/omniroute.ts";
import { computeBudgets, type Budgets } from "./compute.ts";
import { confirmDays, costsOf, coveredUntil, storedSpent, type AnalyticsClient, type ClientFor, type ConfirmResult } from "./daily.ts";
import { dayKey, monthChanged, monthKey, monthStart, REBALANCE_MONTH_KEY } from "./month.ts";
import { guard, holds, readSetting, writeSetting } from "./store.ts";

/** OmniRoute 호출 하나의 제한 시간 (어댑터 기본값과 같다) */
const CALL_TIMEOUT_MS = 15_000;
/** budget_usd 와 새 예산이 이 안이면 같다 (DECIMAL(12,6) 반올림) */
const SAME_USD = 5e-7;
/** 한 실행의 시간 예산: 1분 작업 임대(55초)의 2/3. 넘기면 다음 회원을 시작하지 않고 다음 tick 에 이어 간다 (K2 리뷰 M2) */
export const TIME_BUDGET_MS = Math.floor((55_000 * 2) / 3);

/** 분배가 쓰는 어댑터 함수 */
export interface LimitsClient extends AnalyticsClient {
  setBudget(id: string, budget: { monthlyUsd: number }): Promise<void>;
  /** 무제한 전환에서만 (어댑터 clearBudget) */
  clearBudget(id: string): Promise<void>;
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
  budgetMonth: string | null;
}

export interface MemberRow {
  id: string;
  monthlyLimitUsd: number | null;
}

export interface ApplyCounts {
  setBudget: number;
  /** 무제한 전환으로 푼 예산 수 */
  cleared: number;
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
  /** 이번 달 (UTC YYYY-MM, budget_month 에 쓴다) */
  month: string;
  lease?: Lease;
  signal?: AbortSignal;
  counts: ApplyCounts;
}

export const emptyCounts = (): ApplyCounts => ({ setBudget: 0, cleared: 0, off: 0, on: 0, failed: 0, stale: 0 });

const toKey = (r: any): KeyRow => ({
  id: r.id,
  userId: r.userId,
  omnirouteKeyId: r.omnirouteKeyId,
  state: r.state,
  disabledReason: r.disabledReason ?? null,
  budgetUsd: r.budgetUsd == null ? null : Number(r.budgetUsd),
  budgetAt: r.budgetAt ?? null,
  budgetMonth: r.budgetMonth ?? null,
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
      budgetMonth: k.budgetMonth,
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

/**
 * 예산을 OmniRoute 에 걸고 적는다. 걸었으면 true.
 * 잡을 때 budget_usd 를 비운다(NULL = OmniRoute 값을 모름). setBudget 이 성공한 뒤에만 budget_at 이 내 것일 때 값을 쓴다.
 * 그래서 도중에 임대를 잃거나 실패해도 DB 에 새 값이 남지 않고, 다음 분배가 같은 값이라고 건너뛰지 않는다 (K2 리뷰 L1).
 */
async function setKeyBudget(c: ApplyContext, key: KeyRow, monthlyUsd: number): Promise<boolean> {
  const k = c.h.schema.apiKeys;
  if ((await updateKey(c, key.id, { budgetUsd: null, budgetMonth: null, budgetAt: c.at }, olderThan(c.h, c.at))) !== 1) {
    c.counts.stale++;
    return false;
  }
  try {
    await c.client().setBudget(key.omnirouteKeyId, { monthlyUsd });
  } catch (e) {
    lost(c, e);
    c.counts.failed++;
    return false;
  }
  c.counts.setBudget++;
  // 부르는 사이 더 새 계산이 budget_at 을 가져갔으면 내 setBudget 이 늦게 도착해 그쪽 것(예산·해제)을 덮었을 수 있다.
  // 값과 달을 모두 비워 다음 분배가 반드시 다시 건다 (K2 재검토 H1)
  if ((await updateKey(c, key.id, { budgetUsd: monthlyUsd, budgetMonth: c.month }, eq(k.budgetAt, c.at))) !== 1) await updateKey(c, key.id, { budgetUsd: null, budgetMonth: null }, undefined);
  return true;
}

/**
 * 무제한(월 한도 NULL)으로 바뀐 회원 키의 옛 예산을 푼다 (K2 리뷰 M3). 성공한 뒤에만 budget_usd 를 비운다 —
 * 실패하면 옛 예산 값이 남아 다음 분배가 다시 푼다. 풀었으면 true
 */
async function clearKeyBudget(c: ApplyContext, key: KeyRow): Promise<boolean> {
  const k = c.h.schema.apiKeys;
  if ((await updateKey(c, key.id, { budgetAt: c.at }, olderThan(c.h, c.at))) !== 1) {
    c.counts.stale++;
    return false;
  }
  try {
    await c.client().clearBudget(key.omnirouteKeyId);
  } catch (e) {
    lost(c, e);
    c.counts.failed++;
    return false;
  }
  c.counts.cleared++;
  // 풀린 상태 = budget_usd NULL·budget_month 이번 달. 더 새 계산이 budget_at 을 가져갔으면 내 해제가 늦게 도착해 그쪽 예산을
  // 덮었을 수 있다. 값과 달을 모두 비워 다음 분배가 다시 건다 (K2 재검토 H1)
  if ((await updateKey(c, key.id, { budgetUsd: null, budgetMonth: c.month }, eq(k.budgetAt, c.at))) !== 1) await updateKey(c, key.id, { budgetUsd: null, budgetMonth: null }, undefined);
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

/** limit 으로 꺼진 키를 켠다. budgetClaimed 면 setKeyBudget·clearKeyBudget 이 이미 budget_at 을 내 분석 시각으로 썼다 */
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

/** 회원 하나의 계산 (키 사용액 → 남은 한도·예산). 깨진 값(음수 사용액·한도)이면 TypeError */
export function planMember(member: MemberRow, keys: readonly KeyRow[], spent: ReadonlyMap<string, number>): Budgets {
  return computeBudgets({ limitUsd: member.monthlyLimitUsd, keys: keys.map((k) => ({ id: k.id, state: k.state, spentUsd: spent.get(k.omnirouteKeyId) ?? 0 })) });
}

/** 이번 달 예산을 아직 받지 못한 (켜졌거나 limit 으로 꺼진) 키가 있는가 */
const behind = (keys: readonly KeyRow[], month: string) =>
  keys.some((k) => (k.state === "active" || (k.state === "disabled" && k.disabledReason === "limit")) && k.budgetMonth !== month);

/** 회원 하나의 키에 계산 결과를 건다 */
export async function applyPlan(c: ApplyContext, keys: readonly KeyRow[], r: Budgets): Promise<void> {
  for (const key of keys) {
    if (c.signal?.aborted) throw c.signal.reason;
    if (r.exhausted) {
      if (key.state === "active") await turnOff(c, key);
      continue;
    }
    const limitOff = key.state === "disabled" && key.disabledReason === "limit";
    if (key.state !== "active" && !limitOff) continue;
    if (r.remaining === null) {
      // 무제한: 옛 예산이 남아 있으면 풀고, limit 으로 꺼진 키는 그 뒤에 켠다
      // 예산 값을 알면(budget_usd) 풀고, 모르면(budget_usd·budget_month NULL 인데 budget_at 이 있음 = 걸다가 실패·임대 상실·경합)
      // 걸려 있을 수 있으니 푼다 (K2 재검토 M-a). 풀린 키는 budget_month 가 있어 다시 부르지 않는다
      const hadBudget = key.budgetUsd !== null || (key.budgetMonth === null && key.budgetAt !== null);
      if (hadBudget && !(await clearKeyBudget(c, key))) continue;
      if (limitOff) await turnOn(c, key, hadBudget);
      continue;
    }
    const want = r.budgets.get(key.id) as number;
    if (key.state === "active") {
      // 같은 달에 같은 예산을 이미 걸었으면 보내지 않는다. 새 달이면(budget_month 가 다르면) 같아도 다시 건다 (OmniRoute 월 지출이 0 이 됐다, V20)
      if (key.budgetMonth === c.month && key.budgetUsd !== null && Math.abs(key.budgetUsd - want) < SAME_USD) continue;
      await setKeyBudget(c, key, want);
    } else {
      // 예산을 먼저 건 뒤 켠다. 예산 없이 먼저 켜면 다음 분배까지 한도 밖 사용이 열린다
      if (!(await setKeyBudget(c, key, want))) continue;
      await turnOn(c, key, true);
    }
  }
}

/** 회원 하나: 계산하고 건다 (즉시 분배 member.ts) */
export async function applyMember(c: ApplyContext, member: MemberRow, keys: readonly KeyRow[], spent: ReadonlyMap<string, number>): Promise<void> {
  await applyPlan(c, keys, planMember(member, keys, spent));
}

export interface RebalanceDeps {
  db: DbHandle;
  now: Date;
  client: ClientFor<LimitsClient>;
  lease?: Lease;
  signal?: AbortSignal;
  /** 시간 예산을 재는 시계 (기본 실제 시계) */
  clock?: () => number;
  /** 이 시간이 지나면 다음 회원을 시작하지 않고 멈춘다 (기본 TIME_BUDGET_MS) */
  budgetMs?: number;
}

export interface RebalanceResult extends ApplyCounts {
  members: number;
  /** 예외로 건너뛴 회원 수 (alert.rebalance_failed) */
  failedMembers: number;
  /** 시간 예산을 넘겨 일부 회원을 다음 실행으로 미뤘다 */
  stopped: boolean;
  monthChanged: boolean;
  confirm: ConfirmResult;
}

/** 최근 분배에서 실패한 회원 { 회원 id: 실패 시각 }. 다음 실행 정렬에서 뒤로 보낸다 (K2 재검토 M-b) */
export const FAILED_MEMBERS_KEY = "budget_rebalance_failed";
/** 오늘 남긴 실패 알림 { day, keys: ["회원 id|오류"] }. 같은 회원·같은 오류는 하루(UTC) 한 번 (K2 재검토 M-c) */
export const ALERTED_KEY = "budget_rebalance_alerted";
/** 연속 실패 { count, alertedDay } (K2 재검토 L-a) */
export const STALLED_KEY = "budget_rebalance_stalled";
/** 이만큼 연속으로 실패하면 alert.rebalance_stalled (1분 주기라 10분) */
export const STALL_RUNS = 10;

/**
 * 1분 분배 한 번 (K2 리뷰 M2, 재검토 M-b·M-c·L-a).
 *   1단계: 남은 한도 0 인 회원과 계산이 깨진 회원(computeBudgets 예외, fail-closed)의 켜진 키를 limit 으로 끈다.
 *     계산이 다시 되면 limit 으로 꺼진 키는 정상 경로로 다시 켜진다.
 *   2단계: 예산·켜기. 이번 달 예산을 아직 받지 못한 키가 있는 회원부터, 최근 실패한 회원은 맨 뒤.
 *   회원 하나의 예외·OmniRoute 실패는 그 회원만 실패로 세고 다음 회원으로 간다. alert.rebalance_failed 는 같은 회원·같은 오류를
 *   하루 한 번만 남긴다. 임대를 잃으면 곧바로 멈춘다. 시간 예산(임대의 2/3)이 지나면 다음 회원을 시작하지 않고 멈춘다.
 *   다음 실행은 budget_month 가 이번 달인 키를 건너뛰므로 멈춘 자리 뒤 회원부터 이어 간다.
 *   실행 전체가 실패(분석·날 확정 오류)하면 예산을 바꾸지 않는다(fail-closed). STALL_RUNS 번 연속이면 alert.rebalance_stalled 를 하루 한 번.
 */
export async function rebalanceAll(d: RebalanceDeps): Promise<RebalanceResult> {
  try {
    const r = await rebalanceOnce(d);
    const s = await readSetting<{ count: number; alertedDay?: string }>(d.db, STALLED_KEY);
    if (s && s.count > 0) await writeSetting(d.db, STALLED_KEY, { ...s, count: 0 }, d.now, d.lease);
    return r;
  } catch (e) {
    if (!d.signal?.aborted && !(e instanceof LeaseLostError)) await noteStall(d, e).catch(() => undefined);
    throw e;
  }
}

async function noteStall(d: RebalanceDeps, e: unknown): Promise<void> {
  const h = d.db;
  const today = dayKey(d.now);
  const s = (await readSetting<{ count: number; alertedDay?: string }>(h, STALLED_KEY)) ?? { count: 0 };
  const next = { count: s.count + 1, alertedDay: s.alertedDay };
  if (next.count >= STALL_RUNS && s.alertedDay !== today) {
    if (d.lease && !(await holds(h, d.lease))) return;
    await h.db.insert(h.schema.auditLog).values({
      id: crypto.randomUUID(),
      actorId: null,
      action: "alert.rebalance_stalled",
      target: null,
      detail: JSON.stringify({ runs: next.count, error: describeError(e) }),
      ip: null,
      createdAt: d.now,
    });
    next.alertedDay = today;
  }
  await writeSetting(h, STALLED_KEY, next, d.now, d.lease);
}

type Item = { m: { member: MemberRow; keys: KeyRow[] }; r: Budgets | null; error?: string };

async function rebalanceOnce(d: RebalanceDeps): Promise<RebalanceResult> {
  const h = d.db;
  const clock = d.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = d.budgetMs ?? TIME_BUDGET_MS;
  const month = monthKey(d.now);
  const confirm = await confirmDays(h, d.now, d.client, { lease: d.lease, signal: d.signal });
  const changed = monthChanged(await readSetting<string>(h, REBALANCE_MONTH_KEY), d.now);
  const members = (await loadMembers(h)).filter((m) => needsRebalance(m.keys));
  const counts = emptyCounts();
  const failed: { userId: string; error: string }[] = [];
  const recent = (await readSetting<Record<string, string>>(h, FAILED_MEMBERS_KEY)) ?? {};
  const nextRecent = { ...recent };
  let stopped = false;
  if (members.length > 0) {
    const from = await coveredUntil(h, d.now);
    const ids = members.flatMap((m) => m.keys.map((k) => k.omnirouteKeyId));
    const today = costsOf(await d.client().getAnalytics({ startDate: from, endDate: d.now }), new Set(ids));
    const stored = await storedSpent(h, ids, monthStart(d.now), from);
    const spent = new Map(ids.map((id) => [id, (stored.get(id) ?? 0) + (today.get(id) ?? 0)]));
    const c: ApplyContext = { h, client: d.client, at: d.now, month, lease: d.lease, signal: d.signal, counts };
    const items: Item[] = members.map((m) => {
      try {
        return { m, r: planMember(m.member, m.keys, spent) };
      } catch (e) {
        return { m, r: null, error: describeError(e) };
      }
    });
    const late = (i: Item) => Object.hasOwn(recent, i.m.member.id);
    const offFirst = items.filter((i) => i.r === null || i.r.exhausted);
    const rest = items.filter((i) => i.r !== null && !i.r.exhausted);
    const order = [
      ...offFirst,
      ...rest.filter((i) => !late(i) && behind(i.m.keys, month)),
      ...rest.filter((i) => !late(i) && !behind(i.m.keys, month)),
      ...rest.filter((i) => late(i)),
    ];
    for (const i of order) {
      if (clock() - startedAt >= budgetMs) {
        stopped = true;
        break;
      }
      const before = counts.failed;
      let error = i.error ?? null;
      try {
        // 계산이 깨진 회원은 켜진 키를 끈다 (fail-closed). 지난달 예산을 단 채 켜 두지 않는다
        if (i.r === null) {
          for (const key of i.m.keys) if (key.state === "active") await turnOff(c, key);
        } else {
          await applyPlan(c, i.m.keys, i.r);
        }
      } catch (e) {
        if (d.signal?.aborted) throw d.signal.reason ?? e;
        error ??= describeError(e);
      }
      if (error === null && counts.failed > before) error = "OmniRoute 반영 실패";
      if (error === null) delete nextRecent[i.m.member.id];
      else {
        failed.push({ userId: i.m.member.id, error });
        nextRecent[i.m.member.id] = d.now.toISOString();
      }
    }
  }
  if (JSON.stringify(nextRecent) !== JSON.stringify(recent)) await writeSetting(h, FAILED_MEMBERS_KEY, nextRecent, d.now, d.lease);
  if (failed.length > 0) await alertFailed(h, d.lease, failed, d.now);
  if (changed && !stopped) await writeSetting(h, REBALANCE_MONTH_KEY, month, d.now, d.lease);
  return { ...counts, members: members.length, failedMembers: failed.length, stopped, monthChanged: changed, confirm };
}

/**
 * 분배하지 못한 회원 (관리자 알림, 계획서 v5.6 Q6). 같은 회원·같은 오류는 하루(UTC) 한 번. 새로 알릴 것이 있으면 한 실행에 1행,
 * 회원 id 와 오류는 앞 20개만
 */
async function alertFailed(h: DbHandle, lease: Lease | undefined, failed: { userId: string; error: string }[], now: Date): Promise<void> {
  const day = dayKey(now);
  const seen = await readSetting<{ day: string; keys: string[] }>(h, ALERTED_KEY);
  const keys = new Set(seen?.day === day ? seen.keys : []);
  const fresh = failed.filter((f) => !keys.has(`${f.userId}|${f.error}`));
  if (fresh.length === 0) return;
  if (lease && !(await holds(h, lease))) throw new LeaseLostError(lease);
  await h.db.insert(h.schema.auditLog).values({
    id: crypto.randomUUID(),
    actorId: null,
    action: "alert.rebalance_failed",
    target: null,
    detail: JSON.stringify({ members: fresh.length, userIds: fresh.slice(0, 20).map((f) => f.userId), errors: fresh.slice(0, 20).map((f) => f.error) }),
    ip: null,
    createdAt: now,
  });
  for (const f of fresh) keys.add(`${f.userId}|${f.error}`);
  await writeSetting(h, ALERTED_KEY, { day, keys: [...keys] }, now, lease);
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
