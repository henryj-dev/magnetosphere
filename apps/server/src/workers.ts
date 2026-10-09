// Workers 진입점 (Workers + D1·Hyperdrive 조합). 배포 설정(wrangler.toml)은 S6 에서 만든다.
// 모든 요청이 이 Worker 를 먼저 거친다 (assets.run_worker_first: true). 정적 파일도 보안 헤더를 달아야 해서다 (TC-S4.T3.f).
// 정적 파일은 정적 자산 바인딩(ASSETS)에서 가져온다. 없는 경로는 바인딩의 SPA 처리(not_found_handling)가 index.html 을 준다. 요청마다 런타임·DB 연결·인증을 새로 만든다 (V27 요청 단위 연결).
import { createWorkersRuntime, type WorkersEnv } from "@magnetosphere/runtime/workers";
import { createApp, type Services } from "./app.ts";
import { buildServices } from "./config.ts";

interface Env extends WorkersEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const runtime = createWorkersRuntime(env);
    const pending: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => void pending.push(p.catch((e) => console.error("[server] 백그라운드 작업 실패", e)));
    let services: Promise<Services> | undefined;
    const app = createApp({
      services: () => (services ??= buildServices(runtime, { waitUntil })),
      // 바인딩 응답의 헤더는 바꿀 수 없어 복사한다 (보안 헤더를 덧붙인다)
      assets: async (c) => {
        const res = await env.ASSETS.fetch(c.req.raw);
        return new Response(res.body, res);
      },
      // Workers 에는 시작 시점이 없어 설치 화면이 처음 상태를 물을 때 토큰을 만든다 (wrangler tail 로그에 한 번 나온다)
      issueSetupTokenOnStatus: true,
      log: (line) => console.log(line),
    });
    try {
      return await app.fetch(req);
    } finally {
      // 응답 뒤 작업(메일·Better Auth 백그라운드 작업)이 끝난 다음 DB 연결을 닫는다
      ctx.waitUntil(Promise.allSettled(pending).then(() => runtime.close()));
    }
  },
};
