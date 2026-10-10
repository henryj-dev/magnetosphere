// 즉시 분배 (계획서 v5.7 5.3, K2.T4). 키 발급·재발급 직후와 관리자가 한도를 바꾼 직후(K4)에 그 회원만 다시 계산한다.
//   회원 사용액 = 그 회원 키 전부(삭제 포함)의 usage_daily 저장 합 + 그 키 id 로 부른 오늘 창 분석 한 번.
//   날이 바뀐 뒤 1분 분배가 아직 어제를 확정하지 않았으면 창을 마지막 확정 날부터 잡는다 (daily.ts coveredUntil).
// 1분 분배와 같은 임대를 잡지 않는다. 겹침은 api_keys.budget_at(분석 시각) 조건이 막는다: 더 늦은 분석으로 이미 쓴 키는
// 0행이고, 늦게 끝난 1분 분배가 이 계산을 옛 사용액으로 덮지 못한다 (rebalance.ts applyMember).
import type { DbHandle } from "@magnetosphere/runtime/types";
import { costsOf, coveredUntil, storedSpent, type ClientFor } from "./daily.ts";
import { monthStart } from "./month.ts";
import { applyMember, emptyCounts, loadMembers, type ApplyCounts, type LimitsClient } from "./rebalance.ts";

export async function rebalanceMember(h: DbHandle, userId: string, opts: { now?: Date; client: ClientFor<LimitsClient> }): Promise<ApplyCounts> {
  const now = opts.now ?? new Date();
  const counts = emptyCounts();
  const [m] = await loadMembers(h, userId);
  if (!m || m.keys.length === 0) return counts;
  const ids = m.keys.map((k) => k.omnirouteKeyId);
  const from = await coveredUntil(h, now);
  const today = costsOf(await opts.client().getAnalytics({ apiKeyIds: ids, startDate: from, endDate: now }), new Set(ids));
  const stored = await storedSpent(h, ids, monthStart(now), from);
  const spent = new Map(ids.map((id) => [id, (stored.get(id) ?? 0) + (today.get(id) ?? 0)]));
  await applyMember({ h, client: opts.client, at: now, counts }, m.member, m.keys, spent);
  return counts;
}
