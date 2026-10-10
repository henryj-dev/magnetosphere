// Hono 앱 (계획서 3.1). Node 진입점(node.ts)과 Workers 진입점(workers.ts)이 같은 앱을 쓴다.
//   /healthz       상태 확인
//   /api/auth/*    packages/auth 의 감싼 handler (clientIp 를 런타임 어댑터에서 받는다, S3 보안 리뷰 M2)
//                  관리자가 없는 동안(설치 전)은 가입을 403 으로 막는다 (TC-S4.T4.e). 기본 가입 정책이 invite_only 다 (계획서 4.2)
//   /api/setup     최초 설치 (setup/). /api/setup/omniroute 는 OmniRoute 토큰 상태·붙여 넣기 (관리자 세션)
//   /api/me/keys   회원 키 API (routes/keys.ts)
//   /api/*         그 밖은 JSON 404. 모르는 API 경로가 index.html 200 이 되면 클라이언트가 오류를 성공으로 오인한다
//   나머지         SPA 정적 파일 (apps/web 빌드). 없는 경로는 index.html (TC-S4.T3.a)
// 모든 응답(SPA·API)에 보안 헤더를 단다 (TC-S4.T3.f). 스크립트·스타일 출처는 SPA 빌드가 <meta> CSP 로 건다
//   (apps/web svelte.config.js, 인라인 부트스트랩 스크립트 해시). 헤더 CSP 는 <meta> 로 못 거는 지시어만 둬서 두 정책이 겹쳐도
//   SPA 가 막히지 않게 한다. Workers 는 정적 자산도 이 Worker 를 거치게 한다 (assets.run_worker_first).
// /api/* 요청 본문은 API_BODY_LIMIT 까지만 받는다. 인증 없이 큰 본문을 보내 메모리를 채우는 것을 막는다 (TC-S4.T3.e).
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Cipher } from "@magnetosphere/runtime/crypto";
import type { DbHandle } from "@magnetosphere/runtime/types";
import type { ClientFor } from "./limits/daily.ts";
import type { KeysClient } from "./routes/issue.ts";
import { keyRoutes } from "./routes/keys.ts";
import { adminExists } from "./setup/index.ts";
import type { OmniRouteConfig } from "./setup/omniroute.ts";
import { setupRoutes } from "./setup/routes.ts";

/** /api/* 요청 본문 상한. 인증·설치 요청은 1KB 안팎이다 */
export const API_BODY_LIMIT = 64 * 1024;

export interface Services {
  db: DbHandle;
  auth: { handler(req: Request): Promise<Response> };
  /** APP_ENCRYPTION_KEY 로 만든 암호화 유틸 */
  cipher: Cipher;
  /** OmniRoute 주소와 부트스트랩 비밀번호 (OMNIROUTE_URL, OMNIROUTE_INITIAL_PASSWORD). 없으면 null */
  omniroute: OmniRouteConfig;
  /** 운영자가 정한 설치 토큰 (SETUP_TOKEN 시크릿). 없으면 무작위로 만들어 로그에 한 번 낸다 (setup/index.ts) */
  setupToken?: string | null;
  /** 요청의 클라이언트 IP (런타임 어댑터). 설치 시도 횟수 제한이 쓴다. 못 정하면 null */
  clientIp?: (req: Request) => string | null | Promise<string | null>;
  /** BETTER_AUTH_URL 의 출처. 회원·관리자 변경 API 의 CSRF 검사가 쓴다. 없으면 그 변경 요청을 모두 막는다 */
  appOrigin?: string;
  /** OmniRoute 어댑터 (주소 + 설치 때 저장한 관리 토큰). 연결이 없으면 null */
  keysClient?: () => Promise<ClientFor<KeysClient> | null>;
}

export interface AppDeps {
  /** 요청에 쓸 DB·인증. Node 는 프로세스에 하나, Workers 는 요청마다 만든다 */
  services(): Promise<Services>;
  /** SPA 정적 파일. 없는 경로는 index.html 을 돌려준다 (Node 는 파일, Workers 는 정적 자산 바인딩) */
  assets: MiddlewareHandler;
  /**
   * 설치 토큰을 SETUP_TOKEN 시크릿에서만 받는다 (Workers, S6 보안 리뷰 M2). 시크릿이 없으면 관리자가 생기기 전 /api/setup 이 503
   * setup_token_required 다. 있으면 GET /api/setup 때 그 해시를 둔다. Node 는 false: 시작할 때 토큰을 만들어 출력한다
   */
  setupTokenFromSecret: boolean;
  log: (line: string) => void;
  /**
   * 본문 상한 검사가 요청을 새 Request 로 바꿨을 때 부른다 (Content-Length 없는 chunked 본문을 읽어 다시 담는다).
   * Node 런타임은 소켓 주소를 원래 Request 에 묶어 두므로 새 Request 로 옮겨야 clientIp 가 null 이 되지 않는다.
   */
  carryRequest?: (from: Request, to: Request) => void;
}

/**
 * Better Auth 가입 경로인지. 대소문자·겹친 슬래시·끝 슬래시·%인코딩을 정리한 뒤 본다.
 * Better Auth 라우터가 같은 엔드포인트로 받아 주는 변형으로 검사를 비켜 가지 못하게 한다.
 */
export function isSignUpPath(path: string): boolean {
  let p = path;
  try {
    p = decodeURIComponent(path);
  } catch {
    // 잘못된 %인코딩은 그대로 본다
  }
  p = p.toLowerCase().replace(/\/+/g, "/").replace(/\/$/, "");
  return p === "/api/auth/sign-up" || p.startsWith("/api/auth/sign-up/");
}

/** 응답 헤더 CSP. script-src·style-src 는 SPA 의 <meta> CSP 가 맡는다 */
export const HEADER_CSP = {
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  formAction: ["'self'"],
};

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: HEADER_CSP,
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );
  app.get("/healthz", (c) => c.json({ ok: true }));
  const limit = bodyLimit({ maxSize: API_BODY_LIMIT, onError: (c) => c.json({ error: "payload_too_large" }, 413) });
  app.use("/api/*", async (c, next) => {
    const original = c.req.raw;
    return limit(c, async () => {
      if (c.req.raw !== original) deps.carryRequest?.(original, c.req.raw);
      await next();
    });
  });
  app.use("/api/auth/*", async (c, next) => {
    if (isSignUpPath(c.req.path) && !(await adminExists((await deps.services()).db))) return c.json({ error: "setup_required" }, 403);
    await next();
  });
  app.all("/api/auth/*", async (c) => (await deps.services()).auth.handler(c.req.raw));
  app.route("/api/setup", setupRoutes(deps.services, { setupTokenFromSecret: deps.setupTokenFromSecret, log: deps.log }));
  app.route("/api/me/keys", keyRoutes(deps.services));
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  app.get("*", deps.assets);
  app.onError((e, c) => {
    console.error("[server] 처리하지 못한 오류", e);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
