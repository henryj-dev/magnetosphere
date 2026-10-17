// Better Auth 1.7.7 구성 (계획서 4.1, 4.2, 4.6, 7장 "인증").
// 스키마를 바꾸는 옵션(추가 칼럼 다섯, sso 플러그인, rateLimit 저장소)은 packages/db 의 AUTH_SCHEMA_OPTIONS 를
// 그대로 펼쳐 쓴다. 스키마 생성기와 같은 객체라 테이블·칼럼이 어긋나지 않는다 (TC-S3.T1.e).
// 이 파일은 Workers 에서도 import 된다. Node 전용 모듈(nodemailer 등)을 여기서 부르지 않는다.
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { safeResetAdapter, confirmResetEmail } from "./safe-reset-adapter.ts";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { AUTH_SCHEMA_OPTIONS } from "@magnetosphere/db/src/auth-options.ts";
import { countSignup, decideSignup, loadSignupInputs, VERIFY_EMAIL_EXPIRES_S, type SignupInputs } from "@magnetosphere/db/src/signup.ts";
import { currentInvite } from "./invite-context.ts";
import { queueConfirmationMail, signupConfirmation } from "./signup-confirmation.ts";
import { bindSelfDeleteProof, type SelfDeleteCredentialProve } from "./internal.ts";
import { resetPasswordMessage } from "./mail/messages.ts";
import type { MailMessage, Mailer } from "./mail/types.ts";
import { CLIENT_IP_HEADER, ipAddressOptions, rateLimitOptions, withClientIp, type ClientIp } from "./rate-limit.ts";

export type { Mailer, MailMessage } from "./mail/types.ts";
export type { SelfDeleteCredentialProof } from "./internal.ts";
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
  /** 런타임 DbHandle 의 kind. "d1" 이면 Drizzle 어댑터의 트랜잭션을 끈다 (D1 은 BEGIN 을 받지 않는다, TC-SEC.2.a) */
  kind: "sqlite" | "mysql" | "pg" | "d1";
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
  /**
   * 가입 판정 입력(관리자 있음·설정·메일·오늘 가입 수)을 요청 하나에서 한 번만 읽게 하는 메모 (서버 apps/server/src/signup/request-memo.ts).
   * 서버 앞 판정·signUpGate·생성 훅이 같은 값으로 판정한다. 없으면 부를 때마다 읽는다. 인스턴스 캐시는 두지 않는다 (TC-M2.T5.a)
   */
  signupInputs?: (load: () => Promise<SignupInputs>) => Promise<SignupInputs>;
  /** 회원 행이 커밋된 뒤 (user.create.after). 서버는 감사 기록 member.signup 을 남긴다. 던져도 가입은 그대로이고 경고만 남는다 */
  onUserCreated?: (e: { userId: string; via: "public" | "invite"; inviteId: string | null; ip: string | null }) => Promise<void>;
}

/** 기록에 붙일 오류 꼬리: 인자 가운데 Error 마다 "(이름:code)". message·stack·params·cause 는 넣지 않는다 */
function errorTags(args: unknown[]): string {
  const tags = args
    .filter((a): a is Error => a instanceof Error)
    .map((e) => {
      const code = (e as { code?: unknown }).code;
      return `(${e.name}${typeof code === "string" ? `:${code}` : ""})`;
    });
  return tags.length ? ` ${tags.join(" ")}` : "";
}

/** 가입·로그인 요청의 이메일을 다듬는다. Better Auth 도 소문자로 바꾸지만 앞뒤 공백까지 우리가 먼저 정리한다 (V26). */
const EMAIL_PATHS = new Set(["/sign-up/email", "/sign-in/email"]);
function normalizeEmailBody(ctx: { path: string; body?: any }) {
  if (!EMAIL_PATHS.has(ctx.path)) return;
  const email = ctx.body?.email;
  if (typeof email !== "string") return;
  return { context: { body: { ...ctx.body, email: email.trim().toLowerCase() } } };
}

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

/** 판정 입력. 메모가 있으면 요청 하나에서 한 번만 읽는다 */
function inputsOf(cfg: AuthConfig): () => Promise<SignupInputs> {
  const { db, schema } = cfg.database as { db: any; schema: any };
  const load = () => loadSignupInputs(db, schema);
  return () => (cfg.signupInputs ? cfg.signupInputs(load) : load());
}

/** 가입을 만드는 엔드포인트. 이 경로가 아닌 회원 생성(OAuth·SSO JIT, internalAdapter 직접 호출)은 공개·초대 어느 줄도 아니다 */
const SIGN_UP_PATH = "/sign-up/email";

/** 생성 훅의 경로 판정. 공개 가입·초대 가입이 아니면 null */
function viaOf(ctx: { path?: string } | null | undefined): "public" | "invite" | null {
  if (ctx?.path !== SIGN_UP_PATH) return null;
  return currentInvite() ? "invite" : "public";
}

/**
 * 앞 판정 (hooks.before, 3단계 실행판 M2.T1). /sign-up/* 를 Better Auth 가 이메일을 찾기(findUserByEmail) 전에 판정한다. 그래서 같은 정책·같은 도메인이면
 * 있는 이메일·없는 이메일이 같은 403 과 사유 코드를 받는다 (Q19 (가)). 서버(app.ts)도 HTTP 요청을 같은 판정으로 먼저 막는다.
 * 1.7.7 은 서버 안 호출 auth.api.signUpEmail 에도 hooks.before 를 돌린다 (dispatch.mjs:210). 그래서 초대 문맥(runAsInvite) 안의 호출은 초대 줄로 판정한다.
 * 관리자가 없으면(설치 전) 판정하지 않는다. 그 구간의 /sign-up 은 서버가 setup_required 로 막고, 첫 관리자는 /api/setup 이 DB 에 직접 만든다.
 */
function signUpGate(cfg: AuthConfig) {
  const inputs = inputsOf(cfg);
  return async (ctx: { path: string; body?: any }) => {
    if (!ctx.path.startsWith("/sign-up")) return;
    const i = await inputs();
    if (!i.adminExists) return;
    const invite = currentInvite();
    const d = decideSignup({ inputs: i, email: ctx.body?.email, via: invite ? "invite" : "public", invite });
    if (!d.ok) throw new APIError("FORBIDDEN", { code: d.code.toUpperCase(), message: d.code });
  };
}

/**
 * Better Auth 가 만드는 모든 사용자 행의 문지기 (뒷받침, TC-SEC.1.b·TC-M2.T1.b). 이메일 가입, auth.api.signUpEmail, OAuth·SSO 콜백의 JIT 생성
 * (handleOAuthUserInfo → createOAuthUser·createUser)이 모두 databaseHooks.user.create.before 를 거친다. 앞 판정을 놓친 새 엔드포인트·플러그인도 여기서 막힌다.
 *   - 관리자가 있으면(설치 뒤) /sign-up/email 의 공개 가입·초대 가입만 decideSignup 으로 판정하고, 그 밖의 경로는 모두 거부한다.
 *     SSO JIT 는 5단계가 decideSignup 에 IdP 줄을 더할 때까지 닫혀 있다.
 *     403 을 던지면 Better Auth 가입이 "이미 있는 이메일"용 가짜 200 으로 바꾸므로(requireEmailVerification) 400 으로 던진다.
 *     /sign-up/* 는 그 전에 앞 판정이 같은 입력으로 막으므로 이 400 이 이메일 존재를 드러내는 경로는 없다.
 *   - 통과하면 새 회원 값(역할·상태·인증·기본 월 한도·max_keys NULL)을 data 로 넣는다. 같은 트랜잭션이고, input: false 칼럼이라 본문으로는 못 바꾼다.
 *   - 관리자가 없으면(설치 전) 막지 않고 기본 월 한도만 넣는다.
 * 판정 입력은 가입 트랜잭션 밖의 연결로 읽는다 (쓰기 전 읽기뿐이라 잠금을 기다리지 않는다). 하루 가입 수는 여기서 세지 않는다 (userCreated).
 */
function userCreateGuard(cfg: AuthConfig) {
  const inputs = inputsOf(cfg);
  return async (user: Record<string, unknown>, ctx?: { path?: string } | null) => {
    const i = await inputs();
    if (!i.adminExists) return { data: { ...user, signupOrigin: viaOf(ctx) ?? "legacy", monthlyLimitUsd: user.monthlyLimitUsd ?? i.settings.default_limit_usd } };
    const via = viaOf(ctx);
    const d = via ? decideSignup({ inputs: i, email: user.email, via, invite: currentInvite() }) : ({ ok: false, code: "signup_closed" } as const);
    if (!d.ok) throw new APIError("BAD_REQUEST", { code: d.code.toUpperCase(), message: d.code });
    return { data: { ...user, ...d.data, signupOrigin: via } };
  };
}

/**
 * 회원 행이 커밋된 뒤 (user.create.after, V29 createAfterRunsAfterCommit). 공개 가입이면 하루 가입 수를 센다 (Q13 (가), M2.T3).
 * 가입 트랜잭션 안에서 세지 않는 이유: SQLite 는 가입 트랜잭션이 쓰기 잠금을 쥐어 다른 연결의 쓰기가 막히고, 뒤에 되돌려진 가입이 칸만 쓴다.
 * 이 훅이 던지면 회원 행은 이미 커밋된 채 요청이 실패하므로 던지지 않고 경고만 남긴다. 다음 가입의 세기가 이어 간다.
 * 세기·감사 기록은 응답과 떼어 보낸다 (Workers 는 waitUntil, Node 는 기다리지 않는 백그라운드). 그래서 바로 다음 요청의 앞 판정은 몇 밀리초 늦은 값을 볼 수 있다.
 */
function userCreated(cfg: AuthConfig) {
  const { db, schema, provider } = cfg.database;
  return async (user: Record<string, unknown>, ctx?: { path?: string; headers?: Headers; request?: Request } | null) => {
    const via = viaOf(ctx);
    if (!via) return;
    // HTTP 요청이면 withClientIp 가 정한 IP 머리글. 서버 안 호출(초대 수락)은 없다
    const ip = (ctx?.headers ?? ctx?.request?.headers)?.get(CLIENT_IP_HEADER) ?? null;
    const inviteId = currentInvite()?.inviteId ?? null;
    // 새 가입에만 있는 쓰기라 응답 안에서 기다리면 그 시간만큼 계정 존재가 드러난다 (M2 보안 리뷰 M1). 응답과 떼어 waitUntil 로 넘긴다.
    // 커밋 뒤에만 도는 자리(create.after)라 센 값이 커밋된 가입만 센다는 성질은 그대로다
    const work = (async () => {
      if (via === "public") await countSignup(db, schema, provider, new Date());
      await cfg.onUserCreated?.({ userId: String(user.id), via, inviteId, ip });
    })().catch((e) => console.warn("[auth] 가입 뒤 하루 가입 수 세기·기록 실패 (가입은 그대로)", e));
    cfg.waitUntil(work);
  };
}

/** 가입 응답에 남기는 회원 필드. Better Auth 의 핵심 필드뿐이다 */
const SIGN_UP_USER_FIELDS = ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"] as const;

/**
 * 가입 응답을 핵심 필드로 줄인다 (hooks.after, M2.T1 TC-M2.T1.e). 이미 있는 이메일에는 Better Auth 가 스키마 기본값으로 만든 가짜 user 를 돌려준다
 * (requireEmailVerification). 그 가짜는 status active·monthly_limit_usd NULL 인데 새 가입은 생성 훅이 넣은 pending·기본 한도라, 응답의 권한 필드만 보고도
 * 계정 존재가 드러난다. 그래서 두 응답 모두 핵심 필드만 남긴다. 권한 필드는 로그인 뒤 세션·회원 API 로 본다.
 */
function trimSignUpResponse(ctx: { path: string; json: (v: unknown) => unknown; context: { returned?: unknown } }) {
  if (ctx.path !== SIGN_UP_PATH) return;
  const r = ctx.context.returned as { token?: unknown; user?: Record<string, unknown> } | null | undefined;
  if (!r || typeof r !== "object" || r instanceof Error || !r.user || typeof r.user !== "object") return;
  const user = Object.fromEntries(SIGN_UP_USER_FIELDS.map((k) => [k, r.user![k] ?? null]));
  return ctx.json({ token: r.token ?? null, user });
}

/**
 * Better Auth 옵션. 스키마 비교(TC-S3.T1.e)와 SSO 경로 검사(check-sso-paths.mjs)가 이 함수의 결과를 쓴다.
 * 서버는 이것으로 betterAuth() 를 직접 만들지 않고 createAuth 를 쓴다 (직접 만들면 handler 가 감싸지지 않는다).
 */
export function authOptions(cfg: AuthConfig, confirmation = signupConfirmation(cfg, deliverer(cfg))) {
  // 세션·토큰 서명 키. 짧으면 추측·무차별 대입에 약하므로 시작을 거부한다 (S3 보안 리뷰 L1)
  if (typeof cfg.secret !== "string" || cfg.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BETTER_AUTH_SECRET 은 ${MIN_SECRET_LENGTH}자 이상이어야 한다 (지금 ${cfg.secret?.length ?? 0}자)`);
  }
  const deliver = deliverer(cfg);
  const { db, schema } = cfg.database as { db: any; schema: any };
  return {
    ...AUTH_SCHEMA_OPTIONS,
    baseURL: cfg.baseURL,
    secret: cfg.secret,
    trustedOrigins: cfg.trustedOrigins,
    // Node 네 DB·Hyperdrive 는 트랜잭션을 켠다. 끄면 resolveUser 를 쓰는 SSO 로그인이 거부된다 (V26).
    // D1 만 끈다. 켜면 drizzle 이 begin 을 보내 D1 이 거부하고, runWithTransaction 을 쓰는 경로(/reset-password·가입 등)가 늘 500 이다 (TC-SEC.2.a).
    // 꺼도 재설정 토큰 소비는 한 번뿐이다: sqlite 어댑터의 consumeOne 이 DELETE … RETURNING 한 문장이라 행을 지운 요청 하나만 토큰을 얻는다.
    // 대신 D1 에서 SSO 사용자 확인은 SSO_USER_RESOLUTION_REQUIRES_NATIVE_TRANSACTIONS 로 거부되고, 여러 문장 쓰기(가입의 user·account)는 원자적이지 않다.
    // Better Auth 내부 기록은 메시지와, 덧붙은 오류의 이름·문자열 code 만 남긴다 (M3.T2 보안 리뷰 L-1).
    // 오류의 message·stack·params·cause 에는 이메일·이름·해시가 들 수 있어 버린다. 이름·code 는 500 의 원인을 가리기에 충분하다
    logger: {
      log: (level: string, message: string, ...args: unknown[]) =>
        (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(`[auth] ${message}${errorTags(args)}`),
    },
    database: safeResetAdapter(cfg),
    emailAndPassword: {
      ...AUTH_SCHEMA_OPTIONS.emailAndPassword,
      // 인증 전에는 로그인되지 않는다 (계획서 4.2 "인증 후 키 발급"의 전제)
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => deliver(resetPasswordMessage(user.email, url)),
      // 재설정은 그 회원의 세션을 모두 끊는다 (계획서 4.5, 실행판 M4 몫을 M2 보안 리뷰 H1 로 당겨 옴)
      revokeSessionsOnPasswordReset: true,
      // 성공한 재설정은 메일 소유와 새 비밀번호 설정을 함께 증명한다. 초대·관리자의 인증 정책은 바꾸지 않는다.
      onPasswordReset: async ({ user }) => confirmResetEmail(cfg, user.id),
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: VERIFY_EMAIL_EXPIRES_S,
      sendVerificationEmail: async ({ user }) => {
        // 이메일 지정 초대로 가입한 회원은 수락이 인증을 대신해 이미 인증됐다 (M3.T2, Q5). 쓸모없는 인증 메일을 보내지 않는다
        if ((user as any).signupOrigin === "invite" && user.emailVerified) return;
        // 공개 가입과 이메일 없는 초대 가입은 같은 H1 확인 흐름(메일 링크 + 가입 비밀번호)을 탄다. core /verify-email 링크는 보내지 않는다.
        // 이메일 없는 초대 링크를 쥔 사람이 남의 이메일로 수락해도, 메일 주인이 링크를 누르는 것만으로 그 계정이 인증되지 않는다 (M3.T2 보안 리뷰 H-1)
        queueConfirmationMail(user.id);
      },
      beforeEmailVerification: async (user) => confirmation.coreVerificationGuard(user),
    },
    // 로그인·가입·비밀번호 재설정 요청 수 제한. 저장소는 AUTH_SCHEMA_OPTIONS 의 DB(rate_limit)
    rateLimit: rateLimitOptions(AUTH_SCHEMA_OPTIONS.rateLimit),
    // AUTH_SCHEMA_OPTIONS 는 as const 라 plugins 가 읽기 전용 튜플이다. BetterAuthOptions 는 바꿀 수 있는 배열을 받으므로 복사한다 (같은 플러그인 객체)
    plugins: [...AUTH_SCHEMA_OPTIONS.plugins, confirmation.plugin],
    disabledPaths: SSO_DISABLED_PATHS,
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        await signUpGate(cfg)(ctx);
        const normalized = normalizeEmailBody(ctx);
        if (normalized) ctx.body = normalized.context.body;
        await confirmation.blockCoreVerification(ctx);
        const blocked = await confirmation.guardSession(ctx);
        if (blocked) return blocked;
        await confirmation.loginSnapshot(ctx);
        const changed = await confirmation.changePassword(ctx);
        if (changed) return changed;
        return normalized;
      }),
      after: createAuthMiddleware(async (ctx) => {
        await confirmation.guardSignInResponse(ctx);
        const blocked = await confirmation.guardSessionResponse(ctx);
        if (blocked) return blocked;
        await confirmation.sendQueuedMail(ctx);
        return trimSignUpResponse(ctx as any);
      }),
    },
    databaseHooks: {
      user: { create: { before: userCreateGuard(cfg), after: userCreated(cfg) } },
      session: { create: { before: confirmation.sessionBefore, after: confirmation.sessionAfter } },
    },
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
  const confirmation = signupConfirmation(cfg, deliverer(cfg));
  const auth = betterAuth(authOptions(cfg, confirmation));
  const result = { handler: withClientIp(auth.handler, cfg.clientIp), api: auth.api };
  // 서버 내부 proof는 같은 인스턴스의 문맥을 쓰고 원본 반환 객체에만 등록한다.
  const prove: SelfDeleteCredentialProve = async (input) => {
    const context = await auth.$context;
    return confirmation.selfDeleteCredentialProof(input, context.password.verify.bind(context.password));
  };
  bindSelfDeleteProof(result, prove);
  return result;
}
