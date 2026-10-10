// 회원 남은 한도와 키별 월 예산 (계획서 v5.7 5.3, K2.T1). DB·OmniRoute 를 모르는 순수 계산이다.
//
//   회원 사용액 = 회원의 모든 키(삭제한 키 포함) 이번 달 사용액 합
//   남은 한도   = max(월 한도 − 회원 사용액, 0)
//   남은 한도 > 0 이면 키별 예산 = 그 키 사용액 + 남은 한도 (삭제한 키는 예산을 걸지 않는다)
//   남은 한도 = 0 이면 exhausted: 예산이 아니라 키를 끈다 (disabled_reason limit, 계획서 v5.6 Q1).
//     OmniRoute 는 예산 0 을 무제한으로 보고, 사용액 > 예산일 때만 막는다 (V20 zeroIsUnlimited·equalBlocks false).
//   월 한도가 NULL 이면 무제한: 예산도 끄기도 없다 (5.9).
// 금액은 DECIMAL(12,6) 이라 소수 6자리로 반올림한다. 합을 먼저 반올림해 0.1 + 0.2 같은 부동소수 꼬리로 남은 한도가 생기지 않게 한다.

export interface KeySpend {
  /** api_keys.id */
  id: string;
  /** api_keys.state: active | disabled | deleted */
  state: string;
  /** 이 키의 이번 달 사용액 (USD) */
  spentUsd: number;
}

export interface Budgets {
  memberSpent: number;
  /** 남은 한도. 월 한도가 NULL(무제한)이면 null */
  remaining: number | null;
  /** 남은 한도가 0 이다. 켜진 키를 limit 으로 끈다 */
  exhausted: boolean;
  /** 키 id → 월 예산 (> 0). exhausted 이거나 무제한이면 비어 있다 */
  budgets: Map<string, number>;
}

/** 소수 6자리 반올림 (DECIMAL(12,6)) */
export const round6 = (usd: number): number => Math.round(usd * 1e6) / 1e6;

export function computeBudgets(input: { limitUsd: number | null; keys: readonly KeySpend[] }): Budgets {
  for (const k of input.keys) {
    // 음수·NaN 사용액은 남은 한도를 늘린다. 어댑터 스키마가 막지만 여기서도 받지 않는다
    if (!Number.isFinite(k.spentUsd) || k.spentUsd < 0) throw new TypeError(`키 ${k.id} 사용액이 0 이상의 유한한 수가 아니다`);
  }
  const memberSpent = round6(input.keys.reduce((s, k) => s + k.spentUsd, 0));
  if (input.limitUsd === null) return { memberSpent, remaining: null, exhausted: false, budgets: new Map() };
  const remaining = Math.max(round6(input.limitUsd - memberSpent), 0);
  if (remaining === 0) return { memberSpent, remaining, exhausted: true, budgets: new Map() };
  const budgets = new Map<string, number>();
  for (const k of input.keys) if (k.state !== "deleted") budgets.set(k.id, round6(k.spentUsd + remaining));
  return { memberSpent, remaining, exhausted: false, budgets };
}
