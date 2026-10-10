// 지난 날 저장 usage_daily · 날 확정 · 하루 한 번 대조 (계획서 v5.7 5.3, K2.T7, V15).
//
// 1분 분배는 오늘(UTC) 창 하나만 분석으로 부르고, 이번 달 1일 ~ 어제 몫은 usage_daily(키·날짜별 비용)에서 더한다.
// 키는 OmniRoute 키 id 이고 매핑(api_keys, 삭제한 키 포함)에 있는 키만 둔다.
//
// 날 확정 (confirmDays)
//   - app_settings.usage_daily_confirmed 는 날 확정·대조를 마지막으로 한 날(UTC "YYYY-MM-DD", 그 실행의 오늘)이다.
//     오늘보다 이르면 그 실행이 날이 바뀐 뒤 첫 실행이다. (1) 어제 창을 한 번 불러 어제 값을 저장하고
//     (2) 이번 달 1일 ~ 어제를 한 번 다시 불러 저장값을 대조한 뒤 (3) 오늘 날짜를 쓴다. 같은 날 두 번째 실행부터는 부르지 않는다.
//   - 창 끝은 그날 23:59:59.999 다. OmniRoute 분석은 timestamp >= startDate AND timestamp <= endDate 로 거른다
//     (3.8.51 분석 경로 처리기, 양 끝 포함). 끝을 다음 날 00:00 으로 주면 자정 정각 기록이 어제 저장값과
//     오늘 창에 두 번 들어간다 (TC-K2.T7.d 가 자정 정각 00:00:00.000 기록으로 본다).
// 대조
//   - 분석 비용은 조회 시점 가격표로 계산돼, 가격표가 바뀌면 지난 날 값도 바뀐다. 그래서 하루 한 번 다시 맞춘다.
//   - 한 번 호출(이번 달 1일 ~ 어제)의 byApiKey 는 키별 합계라 날짜별 값이 없다. 키별 합계가 저장 합과
//     DRIFT_USD 보다 다르면 그 키의 저장값을 날짜 비율대로 새 합계에 맞춘다 (가격표 변경은 날마다 같은 비율로 바뀐다).
//     저장 합이 0 이면(확정 뒤 늦게 들어온 기록 등) 어제에 둔다. 회원 사용액은 이 합만 쓴다.
//   - 한 번 호출이 RECONCILE_TIMEOUT_MS 에 걸리면 그 실행은 대조를 멈추고(저장값 그대로), app_settings.usage_daily_split
//     { next, until } 에 남긴다. 다음 실행부터 하루 창을 하나씩 불러 그날 값을 정확히 덮고, until 까지 다 맞추면 지운다.
//     그 뒤 날이 바뀐 첫 실행은 다시 한 번 호출로 대조한다.
//   - 키·날마다 차이가 DRIFT_USD 보다 큰 것이 하나라도 있으면 audit_log alert.usage_drift 1행(차이 난 키·날 수, 합계 차이).
//     처음 확정(usage_daily_confirmed 없음)은 저장값이 없어 차이가 아니므로 알리지 않는다.
//   - 응답에 없는 키는 "자료 없음"이다. 그 키의 저장값을 0 으로 지우지 않는다 (K2 리뷰). OmniRoute 3.8.51 의 byApiKey 는
//     개수 제한이 없다 (V15.json evidence).
// 저장값과 분석 창의 경계 (coveredUntil, K2 리뷰 M1)
//   - 이 날 전은 usage_daily 의 정확한 저장값, 이 날부터 지금까지는 분석 창 한 번으로 센다. 분할 대조가 남아 있으면 그 다음 날
//     (split.next)이 경계다: 공백이 이틀 넘거나 처음 설치한 날 대조가 시간 초과면 저장되지 않은 날이 있기 때문이다.
//     분할이 하루씩 나아가면 경계도 따라 나아간다. 경계 뒤를 덮는 분석 창이 실패하면 그 실행은 실패다 (예산을 바꾸지 않는다).
//   - 분할 대조의 하루 창이 시간 초과면 그날만 다음 실행으로 미룬다. 그날은 여전히 경계 뒤라 분석 창으로 센다 (K2 리뷰 L3).
// 1분 분배의 임대 아래에서 돈다. 쓰기는 펜싱한다 (store.ts).
import { and, eq, gte, lt } from "drizzle-orm";
import type { Analytics } from "@magnetosphere/omniroute";
import { LeaseLostError, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { ceil6, round6 } from "./compute.ts";
import { addDays, dayKey, dayOf, monthStart } from "./month.ts";
import { deleteSetting, holds, readSetting, upsert, writeSetting } from "./store.ts";

export const CONFIRMED_KEY = "usage_daily_confirmed";
export const SPLIT_KEY = "usage_daily_split";
/** 대조 한 번 호출의 제한 시간. 측정(V15 reconcile p95 5.6초)보다 넉넉하고 1분 작업 임대(55초)보다 짧다 */
export const RECONCILE_TIMEOUT_MS = 30_000;
/** 키·날 저장값과 새 값이 이보다 다르면 차이다 (DECIMAL(12,6) 한 자리) */
export const DRIFT_USD = 0.000001;

/** 분배가 쓰는 분석 호출 하나 (어댑터 getAnalytics). apiKeyIds 를 빼면 모든 키 */
export interface AnalyticsClient {
  getAnalytics(q: { apiKeyIds?: string[]; startDate: Date; endDate: Date }): Promise<Analytics>;
}
/** 호출마다 클라이언트를 만든다. timeoutMs 를 주면 그 호출만 제한 시간을 바꾼다 (기본은 어댑터 15초) */
export type ClientFor<C> = (opts?: { timeoutMs?: number }) => C;

export interface SplitState {
  /** 다음에 맞출 날 */
  next: string;
  /** 이 날 전까지 (제외) */
  until: string;
}

export interface Drift {
  keyDays: number;
  diffUsd: number;
}

export interface ConfirmResult {
  /** 이번 실행이 확정한 날 (없으면 null) */
  confirmed: string | null;
  /** 이번 실행이 대조한 범위 [from, until) */
  reconciled: { from: string; until: string } | null;
  /** 한 번 호출 대조가 제한 시간에 걸려 날 단위로 나눴다 */
  timedOut: boolean;
  drift: Drift | null;
}

/** 그날 23:59:59.999 UTC (분석 창 끝, 양 끝 포함이라) */
export const endOfDay = (day: string): Date => new Date(dayOf(addDays(day, 1)).getTime() - 1);

/** 매핑에 있는 OmniRoute 키 id 전부 (삭제한 키 포함) */
export async function mappedKeyIds(h: DbHandle): Promise<Set<string>> {
  const k = h.schema.apiKeys;
  const rows = await h.db.select({ id: k.omnirouteKeyId }).from(k);
  return new Set(rows.map((r: { id: string }) => r.id));
}

/** 분석 응답의 매핑 키별 비용 */
export function costsOf(a: Analytics, mapped: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of a.byApiKey) if (r.apiKeyId !== null && mapped.has(r.apiKeyId)) out.set(r.apiKeyId, (out.get(r.apiKeyId) ?? 0) + r.cost);
  // 사용액은 올린다 (한도를 넘지 않는 쪽, compute.ts)
  for (const [k, v] of out) out.set(k, ceil6(v));
  return out;
}

/** usage_daily 의 [from, until) 날 행. D1 의 바인딩 수 한도(100) 때문에 키로 거르지 않고 날로만 고른다 */
async function storedRows(h: DbHandle, from: string, until: string): Promise<{ keyId: string; day: string; costUsd: number }[]> {
  const t = h.schema.usageDaily;
  const rows = await h.db.select({ keyId: t.keyId, day: t.day, costUsd: t.costUsd }).from(t).where(and(gte(t.day, from), lt(t.day, until)));
  return rows.map((r: { keyId: string; day: string; costUsd: number | string }) => ({ keyId: r.keyId, day: r.day, costUsd: Number(r.costUsd) }));
}

/** 키별 저장 합. 날 [from, until) (from 포함, until 제외). 1분 분배는 이번 달 1일 ~ 오늘 00:00 */
export async function storedSpent(h: DbHandle, keyIds: Iterable<string>, from: Date, until: Date): Promise<Map<string, number>> {
  const want = new Set(keyIds);
  const out = new Map<string, number>();
  for (const id of want) out.set(id, 0);
  if (dayKey(from) >= dayKey(until)) return out;
  for (const r of await storedRows(h, dayKey(from), dayKey(until))) if (want.has(r.keyId)) out.set(r.keyId, (out.get(r.keyId) ?? 0) + r.costUsd);
  for (const [k, v] of out) out.set(k, round6(v));
  return out;
}

/**
 * 저장값이 맞춰져 있는 경계: 이 시각 전 날은 usage_daily 에, 이 시각부터는 분석 창으로 센다.
 * 마지막 확정 날(usage_daily_confirmed, 그날 전까지 저장됨)과 오늘 중 이른 쪽, 이번 달 1일보다 이르면 이번 달 1일.
 * 1분 분배는 확정 뒤라 오늘 00:00 이다. 즉시 분배는 날이 바뀐 뒤 확정 전이면 어제 00:00 부터 창으로 센다.
 */
export async function coveredUntil(h: DbHandle, now: Date): Promise<Date> {
  const today = dayKey(now);
  const first = dayKey(monthStart(now));
  const confirmed = await readSetting<string>(h, CONFIRMED_KEY);
  let until = !confirmed || confirmed <= first ? first : confirmed < today ? confirmed : today;
  const split = await readSetting<SplitState>(h, SPLIT_KEY);
  if (split && split.next < split.until && split.next < until) until = split.next;
  return dayOf(until < first ? first : until);
}

const isTimeout = (e: unknown, signal: AbortSignal | undefined) => !signal?.aborted && e instanceof Error && e.name === "TimeoutError";

async function saveCost(h: DbHandle, lease: Lease | undefined, keyId: string, day: string, costUsd: number, now: Date) {
  const t = h.schema.usageDaily;
  await upsert(h, lease, t, t.keyId, and(eq(t.keyId, keyId), eq(t.day, day)), { costUsd, updatedAt: now }, { keyId, day, costUsd, updatedAt: now });
}

/**
 * 하루 값을 응답대로 덮는다. 응답에 없는 키는 자료 없음이라 저장값을 그대로 둔다. 바뀐 저장값을 돌려준다.
 * 새로 생긴 행은 대조(countNew)에서만 차이다 — 날 확정에서는 처음 저장하는 값이다.
 */
async function saveDay(h: DbHandle, lease: Lease | undefined, day: string, costs: Map<string, number>, now: Date, countNew: boolean): Promise<{ keyId: string; day: string; diff: number }[]> {
  const old = new Map((await storedRows(h, day, addDays(day, 1))).map((r) => [r.keyId, r.costUsd]));
  const diffs: { keyId: string; day: string; diff: number }[] = [];
  for (const [keyId, next] of costs) {
    const prev = old.get(keyId);
    if (prev === undefined ? next === 0 : Math.abs(next - prev) <= DRIFT_USD) continue;
    await saveCost(h, lease, keyId, day, next, now);
    if (prev !== undefined || countNew) diffs.push({ keyId, day, diff: next - (prev ?? 0) });
  }
  return diffs;
}

/** 키 하나의 날짜별 저장값을 새 합계에 맞춘다. 비율대로 나누고 반올림 나머지는 마지막 날에. 저장 합 0 이면 fallbackDay 에 */
export function redistribute(days: Map<string, number>, total: number, fallbackDay: string): Map<string, number> {
  const out = new Map<string, number>();
  const sum = [...days.values()].reduce((s, v) => s + v, 0);
  if (sum <= 0) {
    for (const d of days.keys()) out.set(d, 0);
    out.set(fallbackDay, round6(total));
    return out;
  }
  const sorted = [...days.keys()].sort();
  let given = 0;
  for (const d of sorted) {
    const v = round6((days.get(d) as number) * (total / sum));
    out.set(d, v);
    given += v;
  }
  const last = sorted[sorted.length - 1];
  out.set(last, round6((out.get(last) as number) + (total - given)));
  return out;
}

/** 한 번 호출 대조: 키별 합계를 저장 합과 비교해 다른 키의 날짜별 저장값을 맞춘다 */
async function reconcileTotals(h: DbHandle, lease: Lease | undefined, from: string, until: string, totals: Map<string, number>, now: Date): Promise<{ keyId: string; day: string; diff: number }[]> {
  const byKey = new Map<string, Map<string, number>>();
  for (const r of await storedRows(h, from, until)) {
    if (!byKey.has(r.keyId)) byKey.set(r.keyId, new Map());
    byKey.get(r.keyId)!.set(r.day, r.costUsd);
  }
  const fallback = addDays(until, -1);
  const diffs: { keyId: string; day: string; diff: number }[] = [];
  // 응답에 없는 키는 자료 없음: 저장값을 그대로 둔다
  for (const [keyId, total] of totals) {
    const days = byKey.get(keyId) ?? new Map<string, number>();
    if (Math.abs(total - [...days.values()].reduce((s, v) => s + v, 0)) <= DRIFT_USD) continue;
    for (const [day, v] of redistribute(days, total, fallback)) {
      const prev = days.get(day) ?? 0;
      if (Math.abs(v - prev) <= DRIFT_USD && days.has(day)) continue;
      if (!days.has(day) && v === 0) continue;
      await saveCost(h, lease, keyId, day, v, now);
      diffs.push({ keyId, day, diff: v - prev });
    }
  }
  return diffs;
}

async function alertDrift(h: DbHandle, lease: Lease | undefined, diffs: { diff: number }[], range: { from: string; until: string }, now: Date): Promise<Drift | null> {
  if (diffs.length === 0) return null;
  const drift = { keyDays: diffs.length, diffUsd: round6(diffs.reduce((s, d) => s + d.diff, 0)) };
  if (lease && !(await holds(h, lease))) throw new LeaseLostError(lease);
  await h.db.insert(h.schema.auditLog).values({
    id: crypto.randomUUID(),
    actorId: null,
    action: "alert.usage_drift",
    target: null,
    detail: JSON.stringify({ ...drift, from: range.from, until: range.until }),
    ip: null,
    createdAt: now,
  });
  return drift;
}

/**
 * 날이 바뀐 첫 실행이면 어제를 확정 저장하고 이번 달을 대조한다. 같은 날 두 번째 실행부터는 나눠 둔 대조(있으면)를 하루씩 한다.
 * 분석 오류(OmniRouteError·OmniRouteFormatError·임대 상실)는 그대로 던진다. 부르는 쪽(1분 분배)은 그 실행에서 예산을 바꾸지 않는다.
 */
export async function confirmDays(h: DbHandle, now: Date, client: ClientFor<AnalyticsClient>, opts: { lease?: Lease; signal?: AbortSignal } = {}): Promise<ConfirmResult> {
  const { lease, signal } = opts;
  const today = dayKey(now);
  const result: ConfirmResult = { confirmed: null, reconciled: null, timedOut: false, drift: null };
  const confirmed = await readSetting<string>(h, CONFIRMED_KEY);
  const mapped = await mappedKeyIds(h);

  if (!confirmed || confirmed < today) {
    // 지난달 분할 대조는 새 달에 할 일이 없다 (K2 재검토 L-b)
    const old = await readSetting<SplitState>(h, SPLIT_KEY);
    if (old && old.until <= dayKey(monthStart(now))) await deleteSetting(h, SPLIT_KEY, lease);
    const yesterday = addDays(today, -1);
    const a = await client().getAnalytics({ startDate: dayOf(yesterday), endDate: endOfDay(yesterday) });
    const rewritten = await saveDay(h, lease, yesterday, costsOf(a, mapped), now, false);
    result.confirmed = yesterday;
    const from = dayKey(monthStart(now));
    const diffs = [...rewritten];
    if (from < today) {
      try {
        const r = await client({ timeoutMs: RECONCILE_TIMEOUT_MS }).getAnalytics({ startDate: dayOf(from), endDate: endOfDay(yesterday) });
        diffs.push(...(await reconcileTotals(h, lease, from, today, costsOf(r, mapped), now)));
        result.reconciled = { from, until: today };
        await deleteSetting(h, SPLIT_KEY, lease);
      } catch (e) {
        if (!isTimeout(e, signal)) throw e;
        result.timedOut = true;
        await writeSetting(h, SPLIT_KEY, { next: from, until: today } satisfies SplitState, now, lease);
      }
    }
    if (confirmed) result.drift = await alertDrift(h, lease, diffs, { from, until: today }, now);
    await writeSetting(h, CONFIRMED_KEY, today, now, lease);
    return result;
  }

  const split = await readSetting<SplitState>(h, SPLIT_KEY);
  if (split && split.next < split.until) {
    const day = split.next;
    let a: Analytics;
    try {
      a = await client({ timeoutMs: RECONCILE_TIMEOUT_MS }).getAnalytics({ startDate: dayOf(day), endDate: endOfDay(day) });
    } catch (e) {
      // 그날만 다음 실행으로 미룬다. 경계(coveredUntil)가 그날이라 분배는 그날부터 분석 창으로 센다
      if (!isTimeout(e, signal)) throw e;
      result.timedOut = true;
      return result;
    }
    const diffs = await saveDay(h, lease, day, costsOf(a, mapped), now, true);
    result.reconciled = { from: day, until: addDays(day, 1) };
    result.drift = await alertDrift(h, lease, diffs, result.reconciled, now);
    const next = addDays(day, 1);
    if (next >= split.until) await deleteSetting(h, SPLIT_KEY, lease);
    else await writeSetting(h, SPLIT_KEY, { next, until: split.until } satisfies SplitState, now, lease);
  }
  return result;
}
