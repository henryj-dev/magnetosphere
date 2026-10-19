// Hono 앱 (계획서 3.1). Node 진입점(node.ts)과 Workers 진입점(workers.ts)이 같은 앱을 쓴다.
//   /healthz       상태 확인
//   /api/auth/*    packages/auth 의 감싼 handler (clientIp 를 런타임 어댑터에서 받는다, S3 보안 리뷰 M2)
//                  관리자가 없는 동안(설치 전)은 가입을 403 setup_required 로 막는다 (TC-S4.T4.e). 설치 뒤 공개 가입은 정책 판정 decideSignup
//                  (packages/db/src/signup.ts)이 받지 않으면 403 과 사유 코드(signup_closed·domain_not_allowed·mail_required·signup_cap, Q19)다.
//                  Better Auth 안에서도 앞 판정(signUpGate)과 사용자 생성 훅이 같은 판정으로 막는다 (packages/auth, 다른 생성 경로까지)
//   /api/setup     최초 설치 (setup/). /api/setup/omniroute 는 OmniRoute 토큰 상태·붙여 넣기 (관리자 세션)
//   /api/me/keys   활성 회원 키 API (routes/keys.ts). DELETE /api/me 는 자기 탈퇴 (admin/self-delete.ts)
//   /api/admin/users 회원 목록·상태·역할·삭제 (admin/members.ts). 기존 PATCH /users/:id 는 한도·최대 개수 (routes/admin-limits.ts)
//                  회원·관리자·설치 루트와 하위의 GET·HEAD 아닌 요청은 정확한 Origin 을 요구한다 (routes/guard.ts, 7장 CSRF)
//   /api/admin/settings/{signup,mail} 가입 정책·메일 설정 API (signup/admin.ts·signup/mail.ts, M2.T5). 같은 CSRF 검사
//   /api/admin/invites 초대 만들기·목록·취소 (invites/admin.ts, M3.T1). 같은 CSRF 검사
//   /api/invites/accept 초대 수락 (invites/accept.ts, M3.T2). 공개 경로, application/json 만 받는다
//   /api/*         그 밖은 JSON 404. 모르는 API 경로가 index.html 200 이 되면 클라이언트가 오류를 성공으로 오인한다
//   나머지         SPA 정적 파일 (apps/web 빌드). 없는 경로는 index.html (TC-S4.T3.a)
// 모든 응답(SPA·API)에 보안 헤더를 단다 (TC-S4.T3.f). 스크립트·스타일 출처는 SPA 빌드가 <meta> CSP 로 건다
//   (apps/web svelte.config.js, 인라인 부트스트랩 스크립트 해시). 헤더 CSP 는 <meta> 로 못 거는 지시어만 둬서 두 정책이 겹쳐도
//   SPA 가 막히지 않게 한다. Workers 는 정적 자산도 이 Worker 를 거치게 한다 (assets.run_worker_first).
// /api/* 요청 본문은 API_BODY_LIMIT 까지만 받는다. 인증 없이 큰 본문을 보내 메모리를 채우는 것을 막는다 (TC-S4.T3.e).
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Mailer, SelfDeleteCredentialProof } from "@magnetosphere/auth";
import type { MfaRuntime } from "@magnetosphere/auth/mfa";
import type { Cipher } from "@magnetosphere/runtime/crypto";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { memberAdminRoutes } from "./admin/members.ts";
import { selfDeleteRoutes } from "./admin/self-delete.ts";
import { inviteAcceptRoutes } from "./invites/accept.ts";
import { inviteAdminRoutes } from "./invites/admin.ts";
import type { ClientFor } from "./limits/daily.ts";
import { adminLimitRoutes } from "./routes/admin-limits.ts";
import { sameOrigin } from "./routes/guard.ts";
import type { KeysClient } from "./routes/issue.ts";
import { keyRoutes } from "./routes/keys.ts";
import type { MailCapabilities } from "./setup/mail.ts";
import type { OmniRouteConfig } from "./setup/omniroute.ts";
import { setupRoutes } from "./setup/routes.ts";
import { signupSettingsRoutes } from "./signup/admin.ts";
import { publicSignupDenial } from "./signup/gate.ts";
import { mailSettingsRoutes } from "./signup/mail.ts";
import { withRequestMemo } from "./signup/request-memo.ts";
import { SIGNUP_MIN_MS, withMinDuration } from "./signup/timing.ts";

/** /api/* 요청 본문 상한. 인증·설치 요청은 1KB 안팎이다 */
export const API_BODY_LIMIT = 64 * 1024;

export interface Services {
  db: DbHandle;
  auth: {
    handler(req: Request): Promise<Response>;
    /** 서버 안 호출. 초대 수락(invites/accept.ts)이 초대 문맥(runAsInvite) 안에서 부른다. 시험의 가짜 인증에는 없다 */
    api?: { signUpEmail(o: { body: { email: string; name: string; password: string } }): Promise<unknown> };
    /** 서버 전용 자기 탈퇴 proof. HTTP·auth.api·응답 DTO 로 내보내지 않는다 */
    selfDeleteCredentialProof?(input: { userId: string; sessionId: string; password: string }): Promise<SelfDeleteCredentialProof | null>;
  };
  /** APP_ENCRYPTION_KEY 로 만든 암호화 유틸 */
  cipher: Cipher;
  /**
   * 관리자 MFA 런타임 (A1, config.ts buildMfaRuntime). 없거나 정책이 unavailable 이면 관리자 가드는 503 mfa_policy_unavailable,
   * 최초 설치는 토큰을 쓰기 전에 503 mfa_policy_required 다
   */
  mfa?: MfaRuntime;
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
  /** 메일 어댑터 (인증 메일과 같은 것, 보낼 때마다 메일 설정을 읽는다). 설정 API 의 테스트 메일이 쓴다 */
  mailer?: Mailer;
  /** 런타임에서 쓸 수 있는 메일 전송 방식. 생략하면 SMTP 를 받지 않는다 */
  mailCapabilities?: MailCapabilities;
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
  // 인증 요청 하나가 요청 문맥 메모 하나다 (가입 판정 입력을 한 번만 읽는다, signup/request-memo.ts).
  // 가입 경로는 응답(앞 판정 거부·Better Auth 의 429·오류 포함)을 SIGNUP_MIN_MS 까지 채운다 (signup/timing.ts, TC-M2.T4.a·c)
  app.use("/api/auth/*", (c, next) =>
    withRequestMemo(async () => {
      if (!isSignUpPath(c.req.path)) return next();
      return withMinDuration(SIGNUP_MIN_MS, async () => {
        const denied = await publicSignupDenial((await deps.services()).db, c.req.raw);
        if (denied) return c.json({ error: denied.error }, denied.status);
        await next();
      });
    }),
  );
  app.all("/api/auth/*", async (c) => (await deps.services()).auth.handler(c.req.raw));
  // 최초 설치도 세션·설치 토큰 판정보다 먼저 Origin 을 검사한다. services 는 설치 완료를 기다리지 않는다.
  app.use("/api/setup", sameOrigin(deps.services));
  app.use("/api/setup/*", sameOrigin(deps.services));
  app.route("/api/setup", setupRoutes(deps.services, { setupTokenFromSecret: deps.setupTokenFromSecret, log: deps.log }));
  // /api/me/* 에만 기대지 않고 자기 탈퇴의 exact root 를 명시해 보호한다.
  app.use("/api/me", sameOrigin(deps.services));
  app.use("/api/me/*", sameOrigin(deps.services));
  app.use("/api/admin/*", sameOrigin(deps.services));
  app.route("/api/me/keys", keyRoutes(deps.services));
  app.route("/api/me", selfDeleteRoutes(deps.services));
  app.route("/api/admin/settings/signup", signupSettingsRoutes(deps.services));
  app.route("/api/admin/settings/mail", mailSettingsRoutes(deps.services));
  app.route("/api/admin/invites", inviteAdminRoutes(deps.services));
  app.route("/api/admin", adminLimitRoutes(deps.services));
  app.route("/api/admin", memberAdminRoutes(deps.services));
  app.route("/api/invites", inviteAcceptRoutes(deps.services));
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  app.get("*", deps.assets);
  app.onError((e, c) => {
    // drizzle 쿼리 오류(DrizzleQueryError)는 메시지·params 에 이메일·token_hash 같은 값이 들어 있다. 쿼리 문과 원인 메시지만 남긴다.
    // 원인 메시지도 값을 따옴표로 싸서 담을 수 있다 (MySQL ER_DUP_ENTRY "Duplicate entry 'a@x.com' for key …"). 따옴표 안은 ? 로 가린다.
    // 패키지 사본마다 클래스가 달라 instanceof 대신 모양(query 문자열·params 배열)으로 가린다
    const q = e as { query?: unknown; params?: unknown; cause?: { message?: unknown } };
    if (typeof q.query === "string" && Array.isArray(q.params)) {
      const cause = String(q.cause?.message ?? "알 수 없음")
        // MySQL ER_DUP_ENTRY 는 값 안에 작은따옴표가 들어 있을 수 있어(o'brien@…) 꼴 전체를 가린다
        .replace(/Duplicate entry '[\s\S]*' for key '[\s\S]*'/g, "Duplicate entry '?' for key '?'")
        .replace(/'(?:[^'\\]|\\.)*'/g, "'?'")
        .replace(/"(?:[^"\\]|\\.)*"/g, '"?"');
      console.error(`[server] 처리하지 못한 DB 오류: ${q.query} (원인: ${cause})`);
      return c.json({ error: "internal_error" }, 500);
    }
    console.error("[server] 처리하지 못한 오류", e);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
