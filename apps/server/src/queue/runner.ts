// 작업 큐 실행기 본문 (jobs.ts 의 omniroute_jobs, 1분마다, 계획서 v5.6 Q2).
// OmniRoute 연결(OMNIROUTE_URL + 설치 때 저장한 관리 토큰)이 없으면 할 일이 없다. 작업은 남겨 두고 연결된 뒤에 돈다.
// 호출마다 실행의 임대 신호(임대를 잃으면 끊김)와 15초 제한 시간 중 먼저 오는 쪽으로 끊는다.
import { createClient } from "@magnetosphere/omniroute";
import { createCipher } from "@magnetosphere/runtime/crypto";
import type { Job, Runtime } from "@magnetosphere/runtime/types";
import { requireSecret } from "../config.ts";
import { readOmniRouteToken } from "../setup/omniroute.ts";
import { omnirouteHandlers } from "./handlers.ts";
import { runDue } from "./index.ts";

/** OmniRoute 호출 하나의 제한 시간 (어댑터 기본값과 같다) */
const CALL_TIMEOUT_MS = 15_000;

export function queueJob(rt: Runtime): Job {
  return async ({ db, lease, signal }) => {
    const baseUrl = rt.secret("OMNIROUTE_URL");
    if (!baseUrl) return;
    const token = await readOmniRouteToken(db, await createCipher(requireSecret(rt, "APP_ENCRYPTION_KEY")));
    if (!token) return;
    const handlers = omnirouteHandlers((callSignal) =>
      createClient({ baseUrl, credential: { token }, signal: AbortSignal.any([callSignal ?? signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) }),
    );
    await runDue(db, handlers, new Date(), { lease, signal });
  };
}
