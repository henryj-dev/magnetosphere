// 작업 큐 핸들러 표 (K1.T3). 작업마다 OmniRoute 어댑터 호출 하나다. 클라이언트는 호출마다 그 작업의 중단 신호로 만든다.
// key.apply_state 는 payload { keyId }(api_keys.id)만 받고, 실행할 때 목표를 다시 계산한다 (target.ts, K1 리뷰 #1).
// 나머지 payload 의 omnirouteKeyId 는 api_keys.omniroute_key_id 다. DB 의 키 상태(sync_state 등)는 반영 쪽(K3)이 맞춘다.
import { and, eq, isNull } from "drizzle-orm";
import { OmniRouteError, type OmniRouteClient } from "@magnetosphere/omniroute";
import type { DbHandle } from "@magnetosphere/runtime/types";
import type { Handlers, JobPayload } from "./index.ts";
import { readKeyTarget } from "./target.ts";

/** 같은 키에 아직 안 끝난 key.delete 가 있는가 (delete 가 이긴다) */
async function deletePending(h: DbHandle, keyId: string): Promise<boolean> {
  const t = h.schema.omnirouteJobs;
  const rows = await h.db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.keyId, keyId), eq(t.action, "key.delete"), isNull(t.doneAt), isNull(t.failedAt)))
    .limit(1);
  return rows.length > 0;
}

/** 켜짐·꺼짐을 건다. 끄는 쪽은 이미 없는 키(404)를 성공으로 본다 (지운 뒤 늦게 온 반영) */
async function applyActive(client: OmniRouteClient, id: string, active: boolean) {
  try {
    await client.setKeyActive(id, active);
  } catch (e) {
    if (!(!active && e instanceof OmniRouteError && e.status === 404)) throw e;
  }
}

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
     * 키 켜기·끄기 (목표 상태 반영, 계획서 5.7). 실행할 때 목표를 읽고, 건 뒤 다시 읽어 그사이 바뀌었으면 한 번 더 건다
     * (요청 안의 즉시 반영과 겹친 경우). 그래도 남는 어긋남은 정합성 점검(K3.T3)이 맞춘다.
     */
    async "key.apply_state"(p, { db, signal }) {
      if (typeof p.keyId !== "string" || p.keyId === "") throw new TypeError("payload.keyId 가 없다");
      const read = async () => {
        const cur = await readKeyTarget(db, p.keyId as string);
        if (!cur) return null;
        const active = cur.target === "on" && !(await deletePending(db, p.keyId as string));
        return { id: cur.omnirouteKeyId, active };
      };
      let want = await read();
      for (let i = 0; want && i < 2; i++) {
        await applyActive(clientFor(signal), want.id, want.active);
        const after = await read();
        if (!after || after.active === want.active) break;
        want = after;
      }
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
