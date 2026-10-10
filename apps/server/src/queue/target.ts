// 키 목표 상태 (계획서 5.7) — K1 의 최소 형태. 작업 큐 key.apply_state 가 실행할 때마다 이것으로 목표를 다시 계산한다
// (K1 리뷰 #1: 넣을 때의 값을 실으면 오래된 재시도가 더 새 반영을 덮는다).
// 지금 있는 칼럼(api_keys.state, user.status)만 본다. 남은 한도(5.3)와 disabled_reason 별 규칙은 K3.T1 의 목표 상태 함수가
// 이 자리를 넓힌다. 그때 이 파일은 K3 함수를 부르는 얇은 층이 된다.
import { eq } from "drizzle-orm";
import type { DbHandle } from "@magnetosphere/runtime/types";

export type KeyTarget = "on" | "off" | "deleted";

/** 입력: 키 state, 회원 status. 삭제 > 꺼짐 > 켜짐 */
export function keyTarget(key: { state: string }, user: { status: string }): KeyTarget {
  if (key.state === "deleted" || user.status === "deleted") return "deleted";
  if (key.state !== "active" || user.status !== "active") return "off";
  return "on";
}

/** api_keys.id 의 지금 목표와 OmniRoute 키 id. 키 행이 없으면 null */
export async function readKeyTarget(h: DbHandle, keyId: string): Promise<{ omnirouteKeyId: string; target: KeyTarget } | null> {
  const k = h.schema.apiKeys;
  const u = h.schema.user;
  const [row] = await h.db
    .select({ omnirouteKeyId: k.omnirouteKeyId, state: k.state, status: u.status })
    .from(k)
    .innerJoin(u, eq(u.id, k.userId))
    .where(eq(k.id, keyId));
  return row ? { omnirouteKeyId: row.omnirouteKeyId, target: keyTarget({ state: row.state }, { status: row.status }) } : null;
}
