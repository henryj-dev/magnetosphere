// 달·날 경계 (계획서 v5.7 5.3, K2.T2). 모두 UTC 로 자른다.
// OmniRoute 월 예산도 매달 1일 00:00 UTC 에 초기화된다 (V20 answer.timezone "UTC", getBudgetWindow 가 Date.UTC).
// 달 바뀜은 1분 분배가 app_settings.budget_rebalance_month 에 남긴 마지막 실행 달과 지금 달을 비교해 안다 (Q5).
// 월간 cron 을 따로 두지 않는다 (cronIntervalMinutes 가 "0 0 1 * *" 를 받지 않는다).

export const DAY_MS = 86_400_000;
/** 1분 분배의 마지막 실행 달 (UTC "YYYY-MM") */
export const REBALANCE_MONTH_KEY = "budget_rebalance_month";

/** 이번 달 1일 00:00 UTC */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** 그날 00:00 UTC */
export function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** 이번 달 사용액 창 [이번 달 1일 00:00 UTC, now] */
export function monthWindow(now: Date): { start: Date; end: Date } {
  return { start: monthStart(now), end: now };
}

/** UTC "YYYY-MM" */
export const monthKey = (now: Date): string => now.toISOString().slice(0, 7);
/** UTC "YYYY-MM-DD" */
export const dayKey = (t: Date): string => t.toISOString().slice(0, 10);
/** "YYYY-MM-DD" 의 00:00 UTC */
export const dayOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
/** "YYYY-MM-DD" 에서 n 일 뒤 */
export const addDays = (day: string, n: number): string => dayKey(new Date(dayOf(day).getTime() + n * DAY_MS));

/** 마지막 실행 달(없으면 첫 실행)과 지금 달이 다르면 참 */
export function monthChanged(lastMonth: string | null | undefined, now: Date): boolean {
  return lastMonth !== monthKey(now);
}
