// 공개 가입 인증은 메일 소유와 현재 가입 비밀번호를 함께 확인한다. GET은 안내만 반환한다.
// JWT에는 원문 해시 대신 회원·credential에 묶인 HMAC을 넣는다. DB의 조건부 UPDATE가 일회용 소비점이다.
import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { APIError, createAuthEndpoint, getAuthoritativeSessionFromCtx, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { parseUserOutput } from "better-auth/db";
import { constantTimeEqual, signJWT, verifyJWT } from "better-auth/crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { AuthConfig, MailMessage } from "./index.ts";
import { VERIFY_EMAIL_EXPIRES_S } from "@magnetosphere/db/src/signup.ts";
import { verifyEmailMessage } from "./mail/messages.ts";

const PURPOSE = "public-signup-confirmation";
const MAIL_USER = Symbol("confirmation-mail-user");
const LOGIN = Symbol("login-credential");
const CHANGE = Symbol("changed-credential");
type Context = any;

const invalidProof = () => new APIError("UNAUTHORIZED", { code: "INVALID_CONFIRMATION", message: "인증 링크나 비밀번호를 확인해 주세요" });
const staleLogin = () => new APIError("UNAUTHORIZED", { code: "INVALID_EMAIL_OR_PASSWORD", message: "다시 로그인해 주세요" });

/** 요청 전용 문맥에 id만 기록한다. 가입 트랜잭션 안에서 바깥 DB 연결을 읽지 않는다. */
export function queueConfirmationMail(userId: string): void {
  const ctx = tryGetCurrentAuthEndpointContext();
  if (!ctx) throw new Error("인증 메일 요청 문맥이 없다");
  (ctx.context as any)[MAIL_USER] = userId;
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
  const activeUser = async (id: string) => {
    const [user] = await db.select().from(u).where(eq(u.id, id)).limit(1);
    return !!user && user.emailVerified && !user.deletedAt;
  };
  const validSession = async (row: any) => !!row && (row.credentialFingerprint ? matches(row.userId, row.credentialFingerprint) : activeUser(row.userId));
  const matches = async (id: string, expected: string) => {
    const { user, account } = await load(id);
    return !!user && user.emailVerified && !user.deletedAt && !!account?.password && constantTimeEqual(await fingerprint(id, account), expected);
  };
  const proof = async (token: unknown) => {
    if (typeof token !== "string" || token.length > 4096) throw invalidProof();
    const p = await verifyJWT<any>(token, cfg.secret);
    if (!p || p.purpose !== PURPOSE || typeof p.uid !== "string" || typeof p.email !== "string" || typeof p.credentialFingerprint !== "string" || typeof p.exp !== "number" || p.exp <= Date.now() / 1000) throw invalidProof();
    const { user, account } = await load(p.uid);
    if (!user || user.email !== p.email || user.signupOrigin !== "public" || user.emailVerified || user.deletedAt || !account?.password || !constantTimeEqual(await fingerprint(user.id, account), p.credentialFingerprint)) throw invalidProof();
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
    const update = db.update(u).set({ emailVerified: true, updatedAt: now }).where(and(eq(u.id, user.id), eq(u.email, user.email), eq(u.signupOrigin, "public"), eq(u.emailVerified, false), isNull(u.deletedAt), unchanged));
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
    async sendQueuedMail(ctx: Context) {
      const id = ctx.context[MAIL_USER];
      delete ctx.context[MAIL_USER];
      if (!id || ctx.context.returned instanceof Error) return;
      const { user, account } = await load(id);
      if (!user || user.emailVerified || user.deletedAt) return;
      if (user.signupOrigin === "public" && account?.password) {
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
      if (!user || user.signupOrigin === "public" || (user.signupOrigin === "legacy" && !user.emailVerified)) throw invalidProof();
    },
    coreVerificationGuard(user: any) {
      if (user.signupOrigin === "public" || (user.signupOrigin === "legacy" && !user.emailVerified)) throw invalidProof();
    },
    async loginSnapshot(ctx: Context) {
      if (ctx.path !== "/sign-in/email") return;
      const [user] = await db.select().from(u).where(eq(u.email, ctx.body?.email ?? "")).limit(1);
      if (!user) return;
      const { account } = await load(user.id);
      if (account?.password) ctx.context[LOGIN] = { id: user.id, fingerprint: await fingerprint(user.id, account) };
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
      const { user, account } = await load(session.user.id);
      if (!user?.emailVerified || user.deletedAt || !account?.password) throw staleLogin();
      const oldFingerprint = await fingerprint(user.id, account);
      if (session.session.credentialFingerprint && !constantTimeEqual(session.session.credentialFingerprint, oldFingerprint)) throw staleLogin();
      const keptSessions = revokeOtherSessions ? [] : await db.select({ id: s.id, fingerprint: s.credentialFingerprint }).from(s).where(and(eq(s.userId, user.id), or(eq(s.credentialFingerprint, oldFingerprint), isNull(s.credentialFingerprint))));
      const password = await ctx.context.password.hash(newPassword);
      if (!(await ctx.context.password.verify({ hash: account.password, password: currentPassword }))) throw bad("INVALID_PASSWORD");
      const samePassword = provider === "mysql" ? sql`binary ${a.password} = binary ${account.password}` : eq(a.password, account.password);
      // reset이 세션을 지우거나 credential을 바꾼 뒤에는 오래된 검증 결과로 덮어쓰지 않는다.
      const alive = sql`exists (select 1 from ${s} where ${s.id} = ${session.session.id} and ${s.userId} = ${user.id})`;
      const update = db.update(a).set({ password, updatedAt: new Date() }).where(and(credentialWhere(user.id), eq(a.id, account.id), samePassword, alive));
      let changed: number;
      try {
        changed = provider === "mysql" ? (await update)[0].affectedRows : (await update.returning({ id: a.id })).length;
      } catch {
        throw new APIError("INTERNAL_SERVER_ERROR", { code: "PASSWORD_CHANGE_FAILED", message: "비밀번호를 바꾸지 못했어요" });
      }
      if (changed !== 1) throw staleLogin();
      const expected = await fingerprint(user.id, { ...account, password });
      ctx.context[CHANGE] = { id: user.id, fingerprint: expected };
      let token = null;
      if (revokeOtherSessions) {
        await ctx.context.internalAdapter.deleteUserSessions(user.id);
        const created = await ctx.context.internalAdapter.createSession(user.id);
        if (!created) throw staleLogin();
        token = created.token;
        if (!(await matches(user.id, expected))) {
          await db.delete(s).where(eq(s.id, created.id));
          throw staleLogin();
        }
        await setSessionCookie(ctx, { session: created, user: session.user });
      } else {
        try {
          // 변경 전에 존재했고 옛 credential에 속한 세션만 유지한다. 늦은 로그인이나 다른 변경의 세션은 재바인딩하지 않는다.
          if (keptSessions.length) await db.update(s).set({ credentialFingerprint: expected }).where(and(or(...keptSessions.map((row: any) => and(eq(s.id, row.id), row.fingerprint === null ? isNull(s.credentialFingerprint) : eq(s.credentialFingerprint, row.fingerprint)))), eq(s.userId, user.id), sql`exists (select 1 from ${a} where ${a.id} = ${account.id} and ${provider === "mysql" ? sql`binary ${a.password} = binary ${password}` : eq(a.password, password)})`));
        } catch {
          throw new APIError("INTERNAL_SERVER_ERROR", { code: "PASSWORD_CHANGE_FAILED", message: "비밀번호를 바꾸지 못했어요" });
        }
      }
      if (!(await matches(user.id, expected))) throw staleLogin();
      return ctx.json({ token, user: parseUserOutput(ctx.context.options, session.user) });
    },
    async sessionBefore(session: any, ctx: Context) {
      if (ctx?.path === "/change-password") {
        const snapshot = ctx.context[CHANGE];
        if (!snapshot || snapshot.id !== session.userId || !(await matches(session.userId, snapshot.fingerprint))) throw staleLogin();
        return { data: { ...session, credentialFingerprint: snapshot.fingerprint } };
      }
      if (ctx?.path !== "/sign-in/email") return;
      const snapshot = ctx.context[LOGIN];
      if (!snapshot || snapshot.id !== session.userId || !(await matches(session.userId, snapshot.fingerprint))) throw staleLogin();
      return { data: { ...session, credentialFingerprint: snapshot.fingerprint } };
    },
    async sessionAfter(session: any) {
      if (!session?.credentialFingerprint) return;
      if (!(await matches(session.userId, session.credentialFingerprint))) {
        await db.delete(s).where(eq(s.id, session.id));
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
      if (ctx.path !== "/sign-in/email" || ctx.context.returned instanceof Error) return;
      const snapshot = ctx.context[LOGIN];
      if (!snapshot || !(await matches(snapshot.id, snapshot.fingerprint))) {
        const token = ctx.context.returned?.token;
        if (token) await db.delete(s).where(eq(s.token, token));
        ctx.context.responseHeaders?.delete("set-cookie");
        throw staleLogin();
      }
    },
  };
}
