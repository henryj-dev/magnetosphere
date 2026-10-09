// Hono 앱 (계획서 3.1). Node 진입점(node.ts)과 Workers 진입점(workers.ts)이 같은 앱을 쓴다.
//   /healthz       상태 확인
//   /api/auth/*    packages/auth 의 감싼 handler (clientIp 를 런타임 어댑터에서 받는다, S3 보안 리뷰 M2)
//   /api/setup     최초 설치 (setup/)
//   /api/*         그 밖은 JSON 404. 모르는 API 경로가 index.html 200 이 되면 클라이언트가 오류를 성공으로 오인한다
//   나머지         SPA 정적 파일 (apps/web 빌드). 없는 경로는 index.html (TC-S4.T3.a)
// /api/* 요청 본문은 API_BODY_LIMIT 까지만 받는다. 인증 없이 큰 본문을 보내 메모리를 채우는 것을 막는다 (TC-S4.T3.e).
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Cipher } from "@magnetosphere/runtime/crypto";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { setupRoutes } from "./setup/routes.ts";

/** /api/* 요청 본문 상한. 인증·설치 요청은 1KB 안팎이다 */
export const API_BODY_LIMIT = 64 * 1024;

export interface Services {
  db: DbHandle;
  auth: { handler(req: Request): Promise<Response> };
  /** APP_ENCRYPTION_KEY 로 만든 암호화 유틸 */
  cipher: Cipher;
}

export interface AppDeps {
  /** 요청에 쓸 DB·인증. Node 는 프로세스에 하나, Workers 는 요청마다 만든다 */
  services(): Promise<Services>;
  /** SPA 정적 파일. 없는 경로는 index.html 을 돌려준다 (Node 는 파일, Workers 는 정적 자산 바인딩) */
  assets: MiddlewareHandler;
  /** GET /api/setup 에서 설치 토큰이 없으면 만든다. Node 는 시작할 때 만들므로 false, Workers 는 true */
  issueSetupTokenOnStatus: boolean;
  log: (line: string) => void;
  /**
   * 본문 상한 검사가 요청을 새 Request 로 바꿨을 때 부른다 (Content-Length 없는 chunked 본문을 읽어 다시 담는다).
   * Node 런타임은 소켓 주소를 원래 Request 에 묶어 두므로 새 Request 로 옮겨야 clientIp 가 null 이 되지 않는다.
   */
  carryRequest?: (from: Request, to: Request) => void;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  const limit = bodyLimit({ maxSize: API_BODY_LIMIT, onError: (c) => c.json({ error: "payload_too_large" }, 413) });
  app.use("/api/*", async (c, next) => {
    const original = c.req.raw;
    return limit(c, async () => {
      if (c.req.raw !== original) deps.carryRequest?.(original, c.req.raw);
      await next();
    });
  });
  app.all("/api/auth/*", async (c) => (await deps.services()).auth.handler(c.req.raw));
  app.route("/api/setup", setupRoutes(deps.services, { issueTokenOnStatus: deps.issueSetupTokenOnStatus, log: deps.log }));
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  app.get("*", deps.assets);
  app.onError((e, c) => {
    console.error("[server] 처리하지 못한 오류", e);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
