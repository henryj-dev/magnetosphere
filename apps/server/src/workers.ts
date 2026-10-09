// Workers 진입점 (Workers + D1·Hyperdrive 조합). 배포 설정(wrangler.toml)은 S6 에서 만든다.
// 정적 파일은 Workers 정적 자산(ASSETS)이 먼저 내주고, /api/* 와 /healthz 만 이 Worker 로 온다
// (assets.run_worker_first). 요청마다 런타임·DB 연결·인증을 새로 만든다 (V27 요청 단위 연결).
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
      assets: (c) => env.ASSETS.fetch(c.req.raw),
    });
    try {
      return await app.fetch(req);
    } finally {
      // 응답 뒤 작업(메일·Better Auth 백그라운드 작업)이 끝난 다음 DB 연결을 닫는다
      ctx.waitUntil(Promise.allSettled(pending).then(() => runtime.close()));
    }
  },
};
