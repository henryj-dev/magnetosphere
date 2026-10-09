// Better Auth 1.7.7 구성 (계획서 4.1, 4.2, 4.6, 7장 "인증").
// 스키마를 바꾸는 옵션(추가 칼럼 다섯, sso 플러그인, rateLimit 저장소)은 packages/db 의 AUTH_SCHEMA_OPTIONS 를
// 그대로 펼쳐 쓴다. 스키마 생성기와 같은 객체라 테이블·칼럼이 어긋나지 않는다 (TC-S3.T1.e).
// 이 파일은 Workers 에서도 import 된다. Node 전용 모듈(nodemailer 등)을 여기서 부르지 않는다.
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { AUTH_SCHEMA_OPTIONS } from "@magnetosphere/db/src/auth-options.ts";
import { resetPasswordMessage, verifyEmailMessage } from "./mail/messages.ts";
import type { MailMessage, Mailer } from "./mail/types.ts";
import { ipAddressOptions, rateLimitOptions, withClientIp, type ClientIp } from "./rate-limit.ts";

export type { Mailer, MailMessage } from "./mail/types.ts";
export { CLIENT_IP_HEADER, RATE_LIMIT_RULES, resolveClientIp, type ClientIp } from "./rate-limit.ts";

// @better-auth/sso 1.7.7 이 공개 경로로 여는 관리 엔드포인트 전부 (dist/index.mjs 의 createAuthEndpoint 경로).
// 기본값은 로그인한 누구나 IdP 를 등록·수정·삭제할 수 있고, 0단계에서 /sso/register 로 관리자 계정을 가로챘다
// (docs/research/phase0-better-auth.md). 도메인 검증 두 경로는 domainVerification.enabled 일 때만 생기지만
// 나중에 켜도 열리지 않게 미리 막는다. 조회 두 경로도 관리 화면용이라 같이 막는다.
// disabledPaths 는 HTTP 라우터에서만 404 를 낸다. 관리자 API(계획서 9장 5단계)는 서버 안에서
// auth.api.registerSSOProvider 등을 직접 불러 쓴다. 검사: scripts/check-sso-paths.mjs (TC-S3.T1.d).
export const SSO_DISABLED_PATHS = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
  "/sso/providers",
  "/sso/get-provider",
];

export const MIN_SECRET_LENGTH = 32;

export interface AuthDatabase {
  /** 생성 스키마(@magnetosphere/db/src/schema/{sqlite,mysql,pg}.ts)로 만든 Drizzle 연결 */
  db: any;
  provider: "sqlite" | "mysql" | "pg";
  schema: Record<string, unknown>;
}

export interface AuthConfig {
  database: AuthDatabase;
  /** 공개 기준 주소 (BETTER_AUTH_URL). 메일 링크가 이 주소로 만들어진다 */
  baseURL: string;
  secret: string;
  trustedOrigins?: string[];
  /** 인증·비밀번호 재설정 메일을 보낼 어댑터 (src/mail) */
  mailer: Mailer;
  /** 런타임 어댑터의 clientIp(req). 요청 수 제한과 세션 IP 기록이 이 값을 쓴다 (src/rate-limit.ts) */
  clientIp: ClientIp;
  /**
   * 메일 전송 약속을 요청 뒤까지 살려 둔다. Workers 는 ctx.waitUntil, Node 는 그냥 흘려보내도 된다 ((p) => void p).
   * Better Auth 의 다른 백그라운드 작업(advanced.backgroundTasks.handler, 1.7.7 이름)도 이 함수로 넘긴다.
   */
  waitUntil: (p: Promise<unknown>) => void;
  /** 메일 전송 실패. 응답과 떼어 보내므로 요청은 실패를 모른다. 메시지에는 토큰 링크가 있어 넘기지 않는다 */
  onMailError: (e: unknown, info: { to: string; subject: string }) => void;
}

/** 가입·로그인 요청의 이메일을 다듬는다. Better Auth 도 소문자로 바꾸지만 앞뒤 공백까지 우리가 먼저 정리한다 (V26). */
const EMAIL_PATHS = new Set(["/sign-up/email", "/sign-in/email"]);
const normalizeEmailBody = createAuthMiddleware(async (ctx) => {
  if (!EMAIL_PATHS.has(ctx.path)) return;
  const email = ctx.body?.email;
  if (typeof email !== "string") return;
  return { context: { body: { ...ctx.body, email: email.trim().toLowerCase() } } };
});

/**
 * 메일을 응답과 떼어 보낸다. Better Auth 는 sendVerificationEmail·sendResetPassword 를 기다리므로(runInBackgroundOrAwait),
 * 기다리면 메일을 보내는 경우(있는 계정의 재설정, 없는 계정의 가입)만 응답이 느려져 계정 존재 여부가 드러난다.
 * 그래서 전송 약속을 waitUntil 에 넘기고 곧바로 돌아온다. 실패는 onMailError 로 넘긴다.
 */
function deliverer(cfg: AuthConfig) {
  return async (msg: MailMessage) => {
    const sending = cfg.mailer.send(msg).catch((e) => cfg.onMailError(e, { to: msg.to, subject: msg.subject }));
    cfg.waitUntil(sending);
  };
}

/**
 * Better Auth 옵션. 스키마 비교(TC-S3.T1.e)와 SSO 경로 검사(check-sso-paths.mjs)가 이 함수의 결과를 쓴다.
 * 서버는 이것으로 betterAuth() 를 직접 만들지 않고 createAuth 를 쓴다 (직접 만들면 handler 가 감싸지지 않는다).
 */
export function authOptions(cfg: AuthConfig) {
  // 세션·토큰 서명 키. 짧으면 추측·무차별 대입에 약하므로 시작을 거부한다 (S3 보안 리뷰 L1)
  if (typeof cfg.secret !== "string" || cfg.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BETTER_AUTH_SECRET 은 ${MIN_SECRET_LENGTH}자 이상이어야 한다 (지금 ${cfg.secret?.length ?? 0}자)`);
  }
  const deliver = deliverer(cfg);
  return {
    ...AUTH_SCHEMA_OPTIONS,
    baseURL: cfg.baseURL,
    secret: cfg.secret,
    trustedOrigins: cfg.trustedOrigins,
    // 네 DB 모두 트랜잭션을 켠다. 끄면 resolveUser 를 쓰는 SSO 로그인이 거부된다 (V26).
    database: drizzleAdapter(cfg.database.db, { provider: cfg.database.provider, schema: cfg.database.schema, transaction: true }),
    emailAndPassword: {
      ...AUTH_SCHEMA_OPTIONS.emailAndPassword,
      // 인증 전에는 로그인되지 않는다 (계획서 4.2 "인증 후 키 발급"의 전제)
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => deliver(resetPasswordMessage(user.email, url)),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => deliver(verifyEmailMessage(user.email, url)),
    },
    // 로그인·가입·비밀번호 재설정 요청 수 제한. 저장소는 AUTH_SCHEMA_OPTIONS 의 DB(rate_limit)
    rateLimit: rateLimitOptions(AUTH_SCHEMA_OPTIONS.rateLimit),
    disabledPaths: SSO_DISABLED_PATHS,
    hooks: { before: normalizeEmailBody },
    advanced: {
      ipAddress: ipAddressOptions,
      backgroundTasks: { handler: cfg.waitUntil },
      // 개발용 http 기준 주소에서도 Secure 를 붙인다. 쿠키 이름에 __Secure- 접두사가 붙는다.
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax" },
    },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}

/**
 * 인증 인스턴스. HTTP 요청은 handler 로만 받는다 (S3 보안 리뷰 M2).
 * Better Auth 의 auth.handler 는 내보내지 않는다. 그것을 서버에 바로 붙이면(toNodeHandler(auth) 등) 클라이언트가
 * x-magnetosphere-client-ip 를 지어 넣어 요청 수 제한을 통째로 우회한다. api 는 서버 안 호출용(auth.api)이다.
 */
export function createAuth(cfg: AuthConfig) {
  const auth = betterAuth(authOptions(cfg));
  return { handler: withClientIp(auth.handler, cfg.clientIp), api: auth.api };
}
