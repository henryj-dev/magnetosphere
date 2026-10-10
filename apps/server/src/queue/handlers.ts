// 작업 큐 핸들러 표 (K1.T3). 작업마다 OmniRoute 어댑터 호출 하나다. 클라이언트는 호출마다 그 작업의 중단 신호로 만든다. DB 의 키 상태(sync_state 등)는 반영 쪽(K3)이 맞춘다.
// payload 의 omnirouteKeyId 는 api_keys.omniroute_key_id, keyId 는 api_keys.id (재시도를 다 쓰면 runDue 가 이 키를 failed 로 둔다).
import { OmniRouteError, type OmniRouteClient } from "@magnetosphere/omniroute";
import type { Handlers, JobPayload } from "./index.ts";

function keyIdOf(p: JobPayload): string {
  if (typeof p.omnirouteKeyId !== "string" || p.omnirouteKeyId === "") throw new TypeError("payload.omnirouteKeyId 가 없다");
  return p.omnirouteKeyId;
}

/** 지우는 작업은 이미 없는 키(404)를 성공으로 본다. 앞 시도가 지운 뒤 응답만 잃었을 수 있다 */
async function deleteIgnoringMissing(client: OmniRouteClient, id: string) {
  try {
    await client.deleteKey(id);
  } catch (e) {
    if (!(e instanceof OmniRouteError && e.status === 404)) throw e;
  }
}

/** OmniRoute 클라이언트로 작업 넷을 돈다. clientFor 는 작업의 중단 신호(임대를 잃으면 끊김)로 클라이언트를 만든다 */
export function omnirouteHandlers(clientFor: (signal?: AbortSignal) => OmniRouteClient): Handlers {
  return {
    /** 키 켜기·끄기 (목표 상태 반영, 계획서 5.7). payload.active */
    async "key.apply_state"(p, { signal }) {
      if (typeof p.active !== "boolean") throw new TypeError("payload.active 는 boolean 이어야 한다");
      await clientFor(signal).setKeyActive(keyIdOf(p), p.active);
    },
    /** 끈 키 지우기 (끈 시각 + 2분 뒤, V18) */
    async "key.delete"(p, { signal }) {
      await deleteIgnoringMissing(clientFor(signal), keyIdOf(p));
    },
    /** 키별 월 예산 (계획서 5.3). payload.monthlyUsd > 0 */
    async "budget.set"(p, { signal }) {
      if (typeof p.monthlyUsd !== "number") throw new TypeError("payload.monthlyUsd 는 수여야 한다");
      await clientFor(signal).setBudget(keyIdOf(p), { monthlyUsd: p.monthlyUsd });
    },
    /** 발급 도중 실패해 남은 키 지우기 (계획서 5.2) */
    async "key.rollback"(p, { signal }) {
      await deleteIgnoringMissing(clientFor(signal), keyIdOf(p));
    },
  };
}
