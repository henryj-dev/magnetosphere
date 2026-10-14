// 공개 가입·이메일 없는 초대 가입의 인증은 메일 소유와 현재 가입 비밀번호를 함께 확인한다. GET은 안내만 반환한다.
// 이메일 없는 초대는 링크를 쥔 사람이 아무 이메일로나 수락할 수 있어 공개 가입과 같은 위험이다 (M3.T2 보안 리뷰 H-1).
// JWT에는 원문 해시 대신 회원·credential에 묶인 HMAC을 넣는다. DB의 조건부 UPDATE가 일회용 소비점이다.
import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { APIError, createAuthEndpoint, getAuthoritativeSessionFromCtx, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { parseUserOutput } from "better-auth/db";
import { constantTimeEqual, signJWT, verifyJWT } from "better-auth/crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { activeAuthUser, validAuthVersion } from "./auth-version.ts";
import { credentialWriter, observedAuthVersion } from "./safe-reset-adapter.ts";
import type { User } from "better-auth";
import type { AuthConfig, MailMessage } from "./index.ts";
import { VERIFY_EMAIL_EXPIRES_S } from "@magnetosphere/db/src/signup.ts";
import { verifyEmailMessage } from "./mail/messages.ts";

const PURPOSE = "public-signup-confirmation";
const MAIL_USER = Symbol("confirmation-mail-user");
const LOGIN = Symbol("login-credential");
const CHANGE = Symbol("changed-credential");
type Context = any;

const invalidProof = () => new APIError("UNAUTHORIZED", { code: "INVALID_CONFIRMATION", message: "인증 링크나 비밀번호를 확인해 주세요" });
/** H1 확인 흐름을 타는 가입 경로 */
const CONFIRMED_ORIGINS = ["public", "invite"];
const staleLogin = () => new APIError("UNAUTHORIZED", { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });

/** 요청 전용 문맥에 id만 기록한다. 가입 트랜잭션 안에서 바깥 DB 연결을 읽지 않는다. */
export function queueConfirmationMail(userId: string): void {
  const ctx = tryGetCurrentAuthEndpointContext();
  if (!ctx) throw new Error("인증 메일 요청 문맥이 없다");
  (ctx.context as any)[MAIL_USER] = userId;
}

/** core /verify-email 로 인증할 수 없는 회원: 공개 가입, 미인증 legacy, 미인증 invite (이메일 없는 초대 — H1 확인 흐름만 쓴다) */
function coreBlocked(user: any): boolean {
  return user.signupOrigin === "public" || ((user.signupOrigin === "legacy" || user.signupOrigin === "invite") && !user.emailVerified);
}

export function signupConfirmation(cfg: AuthConfig, deliver: (m: MailMessage) => Promise<void>) {
  const { db, schema, provider } = cfg.database as { db: any; schema: any; provider: string };
  const u = schema.user;
  const a = schema.account;
  const s = schema.session;
  const credentialWhere = (id: string) => and(eq(a.userId, id), eq(a.providerId, "credential"), eq(a.accountId, id));
  const load = async (id: string) => {
    const [user] = await db.select().from(u).where(eq(u.id, id)).limit(1);
    const [account] = await db.select().from(a).where(credentialWhere(id)).limit(1);
    return { user, account };
  };
  const fingerprint = async (id: string, account: any): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(cfg.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const message = JSON.stringify(["magnetosphere:credential:v1", id, account.id, account.providerId, account.accountId, account.password]);
    const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  const writeCredential = credentialWriter(cfg);
  const matches = async (id: string, expected: string | null, version: unknown) => {
    if (!validAuthVersion(version)) return false;
    const { user, account } = await load(id);
    if (!activeAuthUser(user) || user.authVersion !== version) return false;
    // OAuth・旧NULL指紋セッションにcredentialの存在は要求しない。状態と版は必ず照合する。
    return expected === null || (typeof expected === "string" && !!account?.password && constantTimeEqual(await fingerprint(id, account), expected));
  };
  const validSession = async (row: any) => !!row && validAuthVersion(row.authVersion) && row.expiresAt > new Date() && matches(row.userId, row.credentialFingerprint ?? null, row.authVersion);
  const proof = async (token: unknown) => {
    if (typeof token !== "string" || token.length > 4096) throw invalidProof();
    const p = await verifyJWT<any>(token, cfg.secret);
    if (!p || p.purpose !== PURPOSE || typeof p.uid !== "string" || typeof p.email !== "string" || typeof p.credentialFingerprint !== "string" || typeof p.exp !== "number" || p.exp <= Date.now() / 1000) throw invalidProof();
    const { user, account } = await load(p.uid);
    if (!user || user.email !== p.email || !CONFIRMED_ORIGINS.includes(user.signupOrigin) || user.emailVerified || user.deletedAt || !account?.password || !constantTimeEqual(await fingerprint(user.id, account), p.credentialFingerprint)) throw invalidProof();
    return { user, account };
  };
  const checkOrigin = (ctx: Context) => {
    // auth.api는 HTTP 요청이 없지만 같은 proof를 검증한다. HTTP는 정확한 Origin을 요구한다.
    if (!ctx.request) return;
    if ((ctx.headers ?? ctx.request.headers).get("origin") !== new URL(cfg.baseURL).origin) {
      throw new APIError("FORBIDDEN", { code: "FORBIDDEN_ORIGIN", message: "허용되지 않은 출처예요" });
    }
  };
  const getConfirmation = createAuthEndpoint("/signup-confirmation", { method: "GET" }, async (ctx) => {
    await proof(ctx.query?.token);
    ctx.setHeader("Cache-Control", "no-store");
    ctx.setHeader("Referrer-Policy", "no-referrer");
    return ctx.json({ status: "password_confirmation_required", confirmPath: "/api/auth/signup-confirmation", resetPath: "/api/auth/request-password-reset" });
  });
  const confirmEmail = createAuthEndpoint("/signup-confirmation", { method: "POST" }, async (ctx) => {
    checkOrigin(ctx);
    const { token, password } = ctx.body ?? {};
    if (typeof password !== "string" || password.length > 128) throw invalidProof();
    const { user, account } = await proof(token);
    if (!(await ctx.context.password.verify({ password, hash: account.password }))) throw invalidProof();
    const now = new Date();
    // MySQL의 password 칼럼 기본 정렬은 대소문자를 무시한다. CAS는 저장된 해시를 바이트 단위로 비교한다.
    const samePassword = provider === "mysql" ? sql`binary ${a.password} = binary ${account.password}` : eq(a.password, account.password);
    const unchanged = sql`exists (select 1 from ${a} where ${a.userId} = ${user.id} and ${a.id} = ${account.id} and ${a.providerId} = 'credential' and ${a.accountId} = ${user.id} and ${samePassword})`;
    const update = db.update(u).set({ emailVerified: true, updatedAt: now }).where(and(eq(u.id, user.id), eq(u.email, user.email), inArray(u.signupOrigin, CONFIRMED_ORIGINS), eq(u.emailVerified, false), isNull(u.deletedAt), unchanged));
    let changed: number;
    try {
      changed = provider === "mysql" ? (await update)[0].affectedRows : (await update.returning({ id: u.id })).length;
    } catch {
      // Drizzle 오류의 query/params/cause에는 원문 해시가 들어갈 수 있다. 원래 오류를 전달하지 않는다.
      throw new APIError("INTERNAL_SERVER_ERROR", { code: "CONFIRMATION_FAILED", message: "인증을 처리하지 못했어요" });
    }
    if (changed !== 1) throw invalidProof();
    return ctx.json({ status: true });
  });

  return {
    plugin: { id: "signup-confirmation", endpoints: { getSignupConfirmation: getConfirmation, confirmSignupEmail: confirmEmail } },
    /** HTTP/auth.api 엔드포인트가 아니다. createAuth가 서버 내부 self-delete proof로만 노출한다. */
    async selfDeleteCredentialProof(input: { userId: string; sessionId: string; password: string }, verify: (input: { hash: string; password: string }) => Promise<boolean>) {
      if (typeof input?.userId !== "string" || typeof input?.sessionId !== "string" || typeof input?.password !== "string" || input.password.length > 128) return null;
      const { user, account } = await load(input.userId);
      const [session] = await db.select().from(s).where(and(eq(s.id, input.sessionId), eq(s.userId, input.userId))).limit(1);
      // role member/admin 둘 다 허용한다. bootstrap·마지막 관리자 보호는 삭제 primitive가 판정한다.
      if (!activeAuthUser(user) || !["member", "admin"].includes(user.role) || !account?.password || !(await validSession(session))) return null;
      const currentCredentialFingerprint = await fingerprint(user.id, account);
      // 저장된 string fingerprint만 현재 HMAC과 비교한다. NULL은 재바인딩하지 않고 그대로 반환한다.
      if ((session.credentialFingerprint !== null && !constantTimeEqual(session.credentialFingerprint, currentCredentialFingerprint)) || !(await verify({ hash: account.password, password: input.password }))) return null;
      // passwordHash는 서버 내부 CAS proof 값이다. 호출자는 HTTP/JSON/logger/cause에 넣지 않는다.
      return { authVersion: user.authVersion, accountId: account.id, passwordHash: account.password, observedSessionFingerprint: session.credentialFingerprint, currentCredentialFingerprint };
    },
    async sendQueuedMail(ctx: Context) {
      const id = ctx.context[MAIL_USER];
      delete ctx.context[MAIL_USER];
      if (!id || ctx.context.returned instanceof Error) return;
      const { user, account } = await load(id);
      if (!user || user.emailVerified || user.deletedAt) return;
      if (CONFIRMED_ORIGINS.includes(user.signupOrigin) && account?.password) {
        const token = await signJWT({ purpose: PURPOSE, uid: user.id, email: user.email, credentialFingerprint: await fingerprint(user.id, account) }, cfg.secret, VERIFY_EMAIL_EXPIRES_S);
        const url = `${cfg.baseURL.replace(/\/$/, "")}/api/auth/signup-confirmation?token=${encodeURIComponent(token)}`;
        await deliver(verifyEmailMessage(user.email, url));
      } else if (user.signupOrigin === "legacy") {
        await deliver({ to: user.email, subject: "비밀번호를 재설정해 주세요", text: "가입 비밀번호를 재설정한 뒤 로그인해 주세요. 인증 링크만으로는 계정을 활성화하지 않아요.", html: "<p>가입 비밀번호를 재설정한 뒤 로그인해 주세요. 인증 링크만으로는 계정을 활성화하지 않아요.</p>" });
      }
    },
    async blockCoreVerification(ctx: Context) {
      if (ctx.path !== "/verify-email") return;
      const p = await verifyJWT<any>(ctx.query?.token ?? "", cfg.secret);
      if (!p || typeof p.email !== "string") throw invalidProof();
      const [user] = await db.select().from(u).where(eq(u.email, p.email)).limit(1);
      if (!user || coreBlocked(user)) throw invalidProof();
    },
    coreVerificationGuard(user: any) {
      if (coreBlocked(user)) throw invalidProof();
    },
    async loginSnapshot(ctx: Context) {
      if (ctx.path !== "/sign-in/email") return;
      const [user] = await db.select().from(u).where(eq(u.email, ctx.body?.email ?? "")).limit(1);
      if (!user) return;
      const { account } = await load(user.id);
      // 비밀번호 검증 전에는 존재/상태/잘못된 DB 버전에 따른 오류를 반환하지 않는다.
      ctx.context[LOGIN] = { id: user.id, version: user.authVersion, fingerprint: account?.password ? await fingerprint(user.id, account) : null };
    },
    async changePassword(ctx: Context) {
      if (ctx.path !== "/change-password") return;
      checkOrigin(ctx);
      const { currentPassword, newPassword, revokeOtherSessions } = ctx.body ?? {};
      const bad = (code: string) => new APIError("BAD_REQUEST", { code, message: code });
      if (typeof currentPassword !== "string" || typeof newPassword !== "string" || (revokeOtherSessions !== undefined && typeof revokeOtherSessions !== "boolean")) throw bad("VALIDATION_ERROR");
      if (newPassword.length < ctx.context.password.config.minPasswordLength) throw bad("PASSWORD_TOO_SHORT");
      if (newPassword.length > ctx.context.password.config.maxPasswordLength || currentPassword.length > ctx.context.password.config.maxPasswordLength) throw bad("PASSWORD_TOO_LONG");
      const session = await getAuthoritativeSessionFromCtx(ctx);
      if (!session?.session) throw staleLogin();
      const [currentSession] = await db.select().from(s).where(and(eq(s.token, session.session.token), eq(s.userId, session.user.id))).limit(1);
      const { user, account } = await load(session.user.id);
      // getSession의returned:false 출력에는authVersion이 없다. 원본세션을 다시 읽고검증한다.
      if (!activeAuthUser(user) || !account?.password || !(await validSession(currentSession))) throw staleLogin();
      session.session = currentSession;
      const oldFingerprint = await fingerprint(user.id, account);
      if (session.session.credentialFingerprint && !constantTimeEqual(session.session.credentialFingerprint, oldFingerprint)) throw staleLogin();
      const password = await ctx.context.password.hash(newPassword);
      if (!(await ctx.context.password.verify({ hash: account.password, password: currentPassword }))) throw bad("INVALID_PASSWORD");
      const expected = await fingerprint(user.id, { ...account, password });
      const version = await writeCredential({ userId: user.id, version: user.authVersion, password, account, session: session.session, mode: "change", fingerprint: expected, rotate: revokeOtherSessions === true });
      // absent/false도 타 세션은 항상 삭제한다. 현재 세션 하나만 새 지문·버전으로 유지한다.
      ctx.context[CHANGE] = { id: user.id, fingerprint: expected, version };
      let token = null;
      if (revokeOtherSessions) {
        const created = await ctx.context.internalAdapter.createSession(user.id);
        if (!created) throw staleLogin();
        token = created.token;
        if (!(await matches(user.id, expected, version))) {
          await db.delete(s).where(eq(s.id, created.id));
          throw staleLogin();
        }
        const versionedUser: User & { authVersion: number } = { ...session.user, authVersion: version };
        await setSessionCookie(ctx, { session: created, user: versionedUser });
      }
      if (!(await matches(user.id, expected, version))) {
        ctx.context.responseHeaders?.delete("set-cookie");
        throw staleLogin();
      }
      return ctx.json({ token, user: parseUserOutput(ctx.context.options, { ...session.user, authVersion: version }) });
    },
    async sessionBefore(session: any, ctx: Context) {
      if (ctx?.path === "/change-password") {
        const snapshot = ctx.context[CHANGE];
        if (!snapshot || snapshot.id !== session.userId || !(await matches(session.userId, snapshot.fingerprint, snapshot.version))) throw staleLogin();
        return { data: { ...session, credentialFingerprint: snapshot.fingerprint, authVersion: snapshot.version } };
      }
      if (ctx?.path === "/sign-in/email") {
        const snapshot = ctx.context[LOGIN];
        const { user, account } = await load(session.userId);
        // 설치된 core는 password.verify 성공 뒤 여기 온다. wrong password/없는 mail은 이 훅을 타지 않는다.
        if (!snapshot || snapshot.id !== session.userId || !validAuthVersion(snapshot.version) || !validAuthVersion(user?.authVersion) || user.authVersion !== snapshot.version || user.deletedAt || user.status === "deleted" || !account?.password || typeof snapshot.fingerprint !== "string" || !constantTimeEqual(await fingerprint(user.id, account), snapshot.fingerprint)) throw staleLogin();
        if (user.status === "pending" || user.status === "suspended") {
          const code = user.status === "pending" ? "ACCOUNT_PENDING" : "ACCOUNT_SUSPENDED";
          throw new APIError("FORBIDDEN", { code, message: code.toLowerCase() });
        }
        if (!activeAuthUser(user)) throw staleLogin();
        return { data: { ...session, credentialFingerprint: snapshot.fingerprint, authVersion: snapshot.version } };
      }
      // OAuth/link-account는 canonical findOne의 최초 version만 쓴다. 생성 직전 현재 version으로 다시 바인딩하지 않는다.
      const version = observedAuthVersion(session.userId);
      const { user, account } = await load(session.userId);
      if (version === undefined || !activeAuthUser(user) || user.authVersion !== version || (account?.password && typeof session.credentialFingerprint === "string" && !constantTimeEqual(await fingerprint(user.id, account), session.credentialFingerprint))) throw staleLogin();
      return { data: { ...session, authVersion: version } };
    },
    async sessionAfter(session: any, ctx: Context) {
      if (!(await validSession(session))) {
        await db.delete(s).where(eq(s.id, session.id));
        ctx?.context?.responseHeaders?.delete("set-cookie");
        throw staleLogin();
      }
    },
    async guardSession(ctx: Context) {
      if (!ctx.headers?.get("cookie") && !ctx.context.session?.session) return;
      const session = ctx.context.session ?? await getSessionFromCtx(ctx);
      if (!session?.session) return;
      const [row] = await db.select().from(s).where(eq(s.token, session.session.token)).limit(1);
      if (await validSession(row)) return;
      if (row) await db.delete(s).where(eq(s.id, row.id));
      ctx.context.session = null;
      if (ctx.path === "/get-session") return ctx.json(null);
      throw staleLogin();
    },
    async guardSessionResponse(ctx: Context) {
      const result = ctx.context.returned;
      if (!result?.session?.token) return;
      const [row] = await db.select().from(s).where(eq(s.token, result.session.token)).limit(1);
      if (await validSession(row)) return;
      if (row) await db.delete(s).where(eq(s.id, row.id));
      ctx.context.session = null;
      ctx.context.responseHeaders?.delete("set-cookie");
      if (ctx.path === "/get-session") return ctx.json(null);
      throw staleLogin();
    },
    async guardSignInResponse(ctx: Context) {
      if (!["/sign-in/email", "/change-password"].includes(ctx.path) || ctx.context.returned instanceof Error) return;
      const snapshot = ctx.context[ctx.path === "/change-password" ? CHANGE : LOGIN];
      if (!snapshot || !(await matches(snapshot.id, snapshot.fingerprint, snapshot.version))) {
        const token = ctx.context.returned?.token;
        if (token) await db.delete(s).where(eq(s.token, token));
        ctx.context.responseHeaders?.delete("set-cookie");
        throw staleLogin();
      }
    },
  };
}
