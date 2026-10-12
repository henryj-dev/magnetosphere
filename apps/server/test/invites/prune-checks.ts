// 만료·취소한 초대 정리 (M3.T3) 공용 행. 네 DB(prune.db.test.ts)와 D1(prune.workers.test.ts, prune-worker.ts)이 같은 행으로 단언한다.
// 시각은 ms. TC-M3.T3.a 의 문서 행 다섯(만료 31일·만료 29일·취소 31일·사용됨 90일·유효)에 둘을 더한다 (M3.T2 보안 리뷰 L-4):
//   차지 중(used_at 31일 전·used_by 없음) — 수락 2~5단계 사이의 행, 사용·취소(used_at 있음·revoked_at 35일 전) — 사용한 초대는 취소돼도 남는다.
// 그래서 문서 단언 "지움 2·남음 3" 이 여기서는 "지움 2·남음 5" 다.
import { randomUUID } from "node:crypto";

export const T3_NOW = Date.parse("2026-10-11T00:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => T3_NOW - days * DAY;

export interface InviteRowMs {
  id: string;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
  revokedAt: number | null;
}

const row = (expiresAt: number, o: Partial<InviteRowMs> = {}): InviteRowMs => ({ id: randomUUID(), expiresAt, usedAt: null, usedBy: null, revokedAt: null, ...o });

/** TC-M3.T3.a 행: drop 은 지워질 것, keep 은 남을 것 */
export function t3aRows() {
  const drop = {
    expired31: row(ago(31)),
    revoked31: row(ago(24), { revokedAt: ago(31) }),
  };
  const keep = {
    expired29: row(ago(29)),
    used90: row(ago(83), { usedAt: ago(90), usedBy: randomUUID() }),
    valid: row(T3_NOW + 7 * DAY),
    claimed31: row(ago(31), { usedAt: ago(31) }),
    usedRevoked: row(ago(33), { usedAt: ago(40), usedBy: randomUUID(), revokedAt: ago(35) }),
  };
  return { drop, keep };
}

/** 500행 경계: 31일 지난 미사용 만료 초대 n 행 */
export const oldRows = (n: number) => Array.from({ length: n }, () => row(ago(31)));
