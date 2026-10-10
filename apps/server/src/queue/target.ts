// 작업 큐 쪽 키 목표 (K1 리뷰 #1). K3.T1 부터는 목표 상태 함수(keys/target.ts)를 부르는 얇은 층이다.
// key.apply_state 는 넣을 때의 값을 싣지 않고 실행할 때마다 목표를 다시 계산한다 (오래된 재시도가 더 새 반영을 덮지 않게).
import type { DbHandle } from "@magnetosphere/runtime/types";
import { readTarget, type KeyTarget } from "../keys/target.ts";

export type { KeyTarget };

/** api_keys.id 의 지금 목표와 OmniRoute 키 id. 키 행이 없으면 null */
export async function readKeyTarget(h: DbHandle, keyId: string): Promise<{ omnirouteKeyId: string; target: KeyTarget } | null> {
  const cur = await readTarget(h, keyId);
  return cur ? { omnirouteKeyId: cur.omnirouteKeyId, target: cur.target } : null;
}
