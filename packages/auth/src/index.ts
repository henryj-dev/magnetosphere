// Better Auth 1.7.7 구성 (계획서 4.1, 4.2, 4.6, 7장 "인증").
// 스키마를 바꾸는 옵션(추가 칼럼 다섯, sso 플러그인, rateLimit 저장소)은 packages/db 의 AUTH_SCHEMA_OPTIONS 를
// 그대로 펼쳐 쓴다. 스키마 생성기와 같은 객체라 테이블·칼럼이 어긋나지 않는다 (TC-S3.T1.e).
// 이 파일은 Workers 에서도 import 된다. Node 전용 모듈(nodemailer 등)을 여기서 부르지 않는다.
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { AUTH_SCHEMA_OPTIONS } from "@magnetosphere/db/src/auth-options.ts";
import { resetPasswordMessage, verifyEmailMessage } from "./mail/messages.ts";
import type { Mailer } from "./mail/types.ts";
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
}

/** 가입·로그인 요청의 이메일을 다듬는다. Better Auth 도 소문자로 바꾸지만 앞뒤 공백까지 우리가 먼저 정리한다 (V26). */
const EMAIL_PATHS = new Set(["/sign-up/email", "/sign-in/email"]);
const normalizeEmailBody = createAuthMiddleware(async (ctx) => {
  if (!EMAIL_PATHS.has(ctx.path)) return;
  const email = ctx.body?.email;
  if (typeof email !== "string") return;
  return { context: { body: { ...ctx.body, email: email.trim().toLowerCase() } } };
});

/** Better Auth 옵션. 스키마 비교(TC-S3.T1.e)도 이 함수의 결과를 쓴다. */
export function authOptions(cfg: AuthConfig) {
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
      sendResetPassword: async ({ user, url }) => cfg.mailer.send(resetPasswordMessage(user.email, url)),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => cfg.mailer.send(verifyEmailMessage(user.email, url)),
    },
    // 로그인·가입·비밀번호 재설정 요청 수 제한. 저장소는 AUTH_SCHEMA_OPTIONS 의 DB(rate_limit)
    rateLimit: rateLimitOptions(AUTH_SCHEMA_OPTIONS.rateLimit),
    disabledPaths: SSO_DISABLED_PATHS,
    hooks: { before: normalizeEmailBody },
    advanced: {
      ipAddress: ipAddressOptions,
      // 개발용 http 기준 주소에서도 Secure 를 붙인다. 쿠키 이름에 __Secure- 접두사가 붙는다.
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax" },
    },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}

export function createAuth(cfg: AuthConfig) {
  const auth = betterAuth(authOptions(cfg));
  return { auth, handler: withClientIp(auth.handler, cfg.clientIp) };
}
