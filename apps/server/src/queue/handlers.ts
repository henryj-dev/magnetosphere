// 작업 큐 핸들러 표 (K1.T3). 작업마다 OmniRoute 어댑터 호출 하나다. 클라이언트는 호출마다 그 작업의 중단 신호로 만든다.
// key.apply_state 는 payload { keyId }(api_keys.id)만 받고, 실행할 때 목표를 다시 계산해 반영한다 (K1 리뷰 #1).
// K3.T2 부터는 요청 안의 즉시 반영과 같은 applyKey(keys/apply.ts)다: 켜기 전에 예산을 걸고, 목표가 삭제됨이면 끈 뒤 key.delete 를
// 끈 시각 + 2분으로 잡고, sync_state 를 맞춘다. 실패는 던져 큐의 재시도 간격을 따른다(inQueue).
// 나머지 payload 의 omnirouteKeyId 는 api_keys.omniroute_key_id 다.
import { OmniRouteError, type OmniRouteClient } from "@magnetosphere/omniroute";
import { applyKey } from "../keys/apply.ts";
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
    /**
     * 키 켜기·끄기·삭제의 끄기 (목표 상태 반영, 계획서 5.7). 걸고 다시 읽기는 APPLY_ROUNDS 번까지다. 그 뒤에도 목표가 바뀌는
     * (요청이 계속 바꾸는) 드문 경우는 그 요청이 넣은 반영 작업이 합쳐져 세대가 바뀌므로 이 작업이 다시 돈다.
     * 그래도 남는 어긋남은 5분 정합성 점검(keys/reconcile.ts)이 목표 상태로 맞춘다
     */
    async "key.apply_state"(p, { db, signal, lease, clock }) {
      if (typeof p.keyId !== "string" || p.keyId === "") throw new TypeError("payload.keyId 가 없다");
      await applyKey(db, p.keyId, { client: () => clientFor(signal), signal, lease, now: new Date(clock()), clock, inQueue: true });
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
