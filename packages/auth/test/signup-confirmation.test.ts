// handler와 auth.api 양쪽의 H1 증거. 비밀값은 단언 메시지나 로그로 출력하지 않는다.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createAuth } from "../src/index.ts";
import { signJWT, verifyJWT, hashPassword } from "better-auth/crypto";
import { OPEN, type TestDb } from "./db.ts";
import { makeAuthConfig, SECRET } from "./helpers.ts";
import { apiReply, body, mail, OPS, PASSWORD } from "./signup-policy/rig.ts";

const BASE = "http://localhost:3000";
const kinds = (process.env.MG_TEST_DBS ?? "sqlite").split(",") as (keyof typeof OPEN)[];
function barrier() {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => { arrive = r; });
  const resumed = new Promise<void>((r) => { release = r; });
  return { reached, release, wait: async () => { arrive(); await resumed; } };
}

describe.each(kinds)("%s H1 auth.api", (kind) => {
  let h: TestDb;
  let cfg: ReturnType<typeof makeAuthConfig>;
  let auth: ReturnType<typeof createAuth>;
  const settle = async () => { while (cfg.pending.length) await Promise.all(cfg.pending.splice(0)); };
  const api = () => auth.api as any;
  const setup = async () => {
    await OPS.addAdmin(h.db, h.schema);
    await OPS.setMail(h.db, h.schema, true);
    await OPS.setSetting(h.db, h.schema, "signup_mode", "open");
  };
  const signup = async (tag: string) => {
    const email = mail(tag);
    await api().signUpEmail({ body: body(email) });
    await settle();
    const message = cfg.outbox.filter((m) => m.to === email).at(-1)!;
    const url = new URL(message.text.match(/https?:\/\/\S+/)![0]);
    return { email, token: url.searchParams.get("token")!, id: (await OPS.user(h.db, h.schema, email))!.id };
  };
  const reset = async (email: string, newPassword: string) => {
    await api().requestPasswordReset({ body: { email, redirectTo: "/" } });
    await settle();
    const message = cfg.outbox.filter((m) => m.to === email && m.text.includes("/reset-password/")).at(-1)!;
    const token = new URL(message.text.match(/https?:\/\/\S+/)![0]).pathname.split("/").at(-1);
    return api().resetPassword({ body: { token, newPassword } });
  };
  const credential = async (id: string) => (await h.db.select().from((h.schema as any).account).where(eq((h.schema as any).account.userId, id)))[0];
  beforeAll(async () => {
    h = await OPEN[kind]();
    cfg = makeAuthConfig(h);
    auth = createAuth(cfg);
    await setup();
  });
  afterAll(async () => { await settle(); await h?.close(); vi.restoreAllMocks(); });

  it("H1.RATE: 같은 IP의 비밀번호 확인 실패는 여섯 번째부터 429다", async () => {
    const x = await signup("confirmation-rate");
    const instance = createAuth({ ...cfg, clientIp: () => "192.0.2.233" });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await instance.handler(new Request(`${BASE}/api/auth/signup-confirmation`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ token: x.token, password: "wrong-password-123" }) }));
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await OPS.user(h.db, h.schema, x.email))?.emailVerified).toBe(false);
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
  });

  it("H1.API: core verifyEmail 직접 호출·purpose/uid/expiry 위조·필드 주입은 인증하지 못한다", async () => {
    const x = await signup("api-binding");
    const core = await signJWT({ email: x.email }, SECRET, 3600);
    expect((await apiReply(api().verifyEmail({ query: { token: core } }))).status).toBe(401);
    const p = await verifyJWT<any>(x.token, SECRET);
    for (const modified of [{ ...p, purpose: "other" }, { ...p, uid: crypto.randomUUID() }]) {
      const token = await signJWT(modified, SECRET);
      expect((await apiReply(api().confirmSignupEmail({ body: { token, password: PASSWORD } }))).status).toBe(401);
    }
    const expired = await signJWT(p, SECRET, -1);
    expect((await apiReply(api().confirmSignupEmail({ body: { token: expired, password: PASSWORD } }))).status).toBe(401);
    expect((await OPS.user(h.db, h.schema, x.email))?.emailVerified).toBe(false);
    const forged = await apiReply(api().signUpEmail({ body: body(mail("forged-origin"), { signupOrigin: "invite", credentialFingerprint: "forged" }) }));
    if (forged.status === 200) {
      const user = JSON.parse(forged.body).user;
      const current = await OPS.user(h.db, h.schema, user.email);
      const [stored] = await h.db.select().from((h.schema as any).user).where(eq((h.schema as any).user.id, current!.id));
      expect(stored.signupOrigin).toBe("public");
    } else expect(forged.status).toBe(400);
    expect((await apiReply(api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } }))).status).toBe(200);
    const signedIn = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    expect(JSON.stringify(signedIn.response)).not.toContain("credentialFingerprint");
    expect(JSON.stringify(signedIn.response)).not.toContain("signupOrigin");
  });

  it("H1.MAIL: 인증·재설정 전송 실패는 미인증 상태를 유지하고 재발송으로 복구한다", async () => {
    const sender = vi.spyOn(cfg.mailer, "send").mockRejectedValue(new Error("mail delivery failed"));
    const email = mail("failed-mail");
    await api().signUpEmail({ body: body(email) });
    await settle();
    expect(cfg.mailErrors.length).toBeGreaterThan(0);
    expect((await OPS.user(h.db, h.schema, email))?.emailVerified).toBe(false);
    await api().requestPasswordReset({ body: { email } });
    await settle();
    expect((await OPS.user(h.db, h.schema, email))?.emailVerified).toBe(false);
    sender.mockRestore();
    await api().sendVerificationEmail({ body: { email } });
    await settle();
    const message = cfg.outbox.filter((m) => m.to === email).at(-1)!;
    const token = new URL(message.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token");
    expect((await apiReply(api().confirmSignupEmail({ body: { token, password: PASSWORD } }))).status).toBe(200);
  });

  it("H1.RACE.verify-reset: 비밀번호 검증 뒤 재설정이 끝나면 옛 인증 CAS가 실패한다", async () => {
    const x = await signup("verify-reset");
    const original = await credential(x.id);
    const pause = barrier();
    // 실제 저장된 hash로 시작한 password.verify만 지연시킨다. 운영 DB와 비밀번호 경로는 그대로다.
    const optionsAuth = await import("better-auth");
    const { authOptions } = await import("../src/index.ts");
    const options = authOptions(cfg);
    const passwordCrypto = await import("better-auth/crypto");
    (options.emailAndPassword as any).password = { hash: hashPassword, verify: async (input: any) => {
      const valid = await passwordCrypto.verifyPassword(input);
      if (input.hash === original.password) await pause.wait();
      return valid;
    } };
    const instance = optionsAuth.betterAuth(options);
    const pending = apiReply((instance.api as any).confirmSignupEmail({ body: { token: x.token, password: PASSWORD } }));
    await pause.reached;
    await reset(x.email, "verify-reset-new-password-123");
    pause.release();
    expect((await pending).status).toBe(401);
    expect((await OPS.user(h.db, h.schema, x.email))?.emailVerified).toBe(true);
  });

  it("H1.RACE.login-reset: 검증 중 재설정은 오래된 로그인 세션·쿠키를 만들지 않는다", async () => {
    const x = await signup("login-reset");
    await api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } });
    const original = await credential(x.id);
    const pause = barrier();
    const { betterAuth } = await import("better-auth");
    const { authOptions } = await import("../src/index.ts");
    const { verifyPassword } = await import("better-auth/crypto");
    const options = authOptions(cfg);
    (options.emailAndPassword as any).password = { hash: hashPassword, verify: async (input: any) => {
      const valid = await verifyPassword(input);
      if (input.hash === original.password) await pause.wait();
      return valid;
    } };
    const instance = betterAuth(options);
    const pending = instance.handler(new Request(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ email: x.email, password: PASSWORD }) }));
    await pause.reached;
    await reset(x.email, "login-reset-new-password-123");
    pause.release();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
  });

  it("H1.RACE.insert-reset: 생성 전 검증 뒤 재설정·세션 삭제가 끝나도 뒤늦은 insert는 제거된다", async () => {
    const x = await signup("insert-reset");
    await api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } });
    const pause = barrier();
    const { betterAuth } = await import("better-auth");
    const { authOptions } = await import("../src/index.ts");
    const options = authOptions(cfg);
    const before = options.databaseHooks.session.create.before;
    options.databaseHooks.session.create.before = async (session: any, ctx: any) => {
      const checked = await before(session, ctx);
      if (ctx?.path === "/sign-in/email") await pause.wait();
      return checked;
    };
    const instance = betterAuth(options);
    const pending = apiReply((instance.api as any).signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true }));
    await pause.reached;
    await reset(x.email, "insert-reset-new-password-123");
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
    pause.release();
    expect((await pending).status).toBe(401);
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
  });

  it("H1.RACE.change-verify-reset: 현재 비밀번호 검증 중 재설정은 뒤늦은 변경으로 덮어쓰지 못한다", async () => {
    const x = await signup("change-verify-reset");
    await api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } });
    const login = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    const cookie = login.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ");
    const original = await credential(x.id);
    const pause = barrier();
    const { betterAuth } = await import("better-auth");
    const { authOptions } = await import("../src/index.ts");
    const { verifyPassword } = await import("better-auth/crypto");
    const options = authOptions(cfg);
    (options.emailAndPassword as any).password = { hash: hashPassword, verify: async (input: any) => {
      const valid = await verifyPassword(input);
      if (input.hash === original.password) await pause.wait();
      return valid;
    } };
    const instance = betterAuth(options);
    const pending = apiReply((instance.api as any).changePassword({ headers: new Headers({ cookie }), body: { currentPassword: PASSWORD, newPassword: "attacker-change-password-123", revokeOtherSessions: true } }));
    await pause.reached;
    await reset(x.email, "owner-reset-password-123");
    pause.release();
    expect((await pending).status).toBe(401);
    expect(await verifyPassword({ hash: (await credential(x.id)).password, password: "owner-reset-password-123" })).toBe(true);
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
  });

  it("H1.RACE.change-insert-reset: 변경 직후 재설정은 새 credential에 옛 요청 세션을 재바인딩하지 않는다", async () => {
    const x = await signup("change-insert-reset");
    await api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } });
    const login = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    const cookie = login.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ");
    const pause = barrier();
    const { betterAuth } = await import("better-auth");
    const { authOptions } = await import("../src/index.ts");
    const options = authOptions(cfg);
    const before = options.databaseHooks.session.create.before;
    options.databaseHooks.session.create.before = async (session: any, ctx: any) => {
      if (ctx?.path === "/change-password") await pause.wait();
      return before(session, ctx);
    };
    const instance = betterAuth(options);
    const pending = instance.handler(new Request(`${BASE}/api/auth/change-password`, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "before-reset-password-123", revokeOtherSessions: true }) }));
    await pause.reached;
    await reset(x.email, "owner-final-password-123");
    pause.release();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
  });

  it("H1.CHANGE: 본문 검증·CSRF·기존 세션 유지·새 세션 응답 계약을 보존한다", async () => {
    const x = await signup("change-contract");
    await api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } });
    const login = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    const cookie = login.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ");
    const headers = new Headers({ cookie });
    for (const b of [
      { currentPassword: PASSWORD, newPassword: "short" },
      { currentPassword: PASSWORD, newPassword: "a".repeat(129) },
      { currentPassword: 123, newPassword: PASSWORD },
      { currentPassword: "wrong-password-123", newPassword: PASSWORD },
      { currentPassword: PASSWORD, newPassword: PASSWORD, revokeOtherSessions: "true" },
    ]) expect((await apiReply(api().changePassword({ headers, body: b }))).status).toBe(400);
    const csrf = await auth.handler(new Request(`${BASE}/api/auth/change-password`, { method: "POST", headers: { cookie, origin: "https://attacker.example", "content-type": "application/json" }, body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "changed-password-123" }) }));
    expect(csrf.status).toBe(403);
    const kept = await api().changePassword({ headers, body: { currentPassword: PASSWORD, newPassword: "kept-password-123", revokeOtherSessions: false } });
    expect(kept).toMatchObject({ token: null, user: { id: x.id } });
    expect(await api().getSession({ headers })).not.toBeNull();
    const rotated = await api().changePassword({ headers, body: { currentPassword: "kept-password-123", newPassword: "rotated-password-123", revokeOtherSessions: true }, returnHeaders: true });
    expect(typeof rotated.response.token).toBe("string");
    expect(rotated.response.user.id).toBe(x.id);
    expect(rotated.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(await api().getSession({ headers })).toBeNull();
    const next = new Headers({ cookie: rotated.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ") });
    expect(await api().getSession({ headers: next })).not.toBeNull();
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(1);
  });

  // invite 의 의미가 바뀌었다 (M3.T2 보안 리뷰 H-1): 이메일 없는 초대는 링크를 쥔 사람이 남의 이메일로 수락할 수 있어 공개 가입과 같은 위험이다.
  // 그래서 미인증 invite 는 core /verify-email 을 거부하고(H1 확인 흐름만), 메일 주인이 재설정으로 되찾도록 재설정이 인증한다.
  // 예전 단언(invite 재설정 → 미인증 유지, invite-core → 200 인증)은 공격자 비밀번호 계정을 메일 클릭 한 번으로 인증해 주는 동작을 고정하고 있었다.
  it("H1.ORIGIN: legacy·invite 미인증은 core verify 거부·재설정으로 인증, setup은 재설정으로 자동 인증하지 않는다", async () => {
    for (const origin of ["legacy", "invite", "setup"]) {
      const email = mail(`origin-${origin}`);
      const id = await OPS.addPasswordUser(h.db, h.schema, email, PASSWORD, origin === "setup" ? "admin" : "member");
      await h.db.update((h.schema as any).user).set({ emailVerified: false, signupOrigin: origin }).where(eq((h.schema as any).user.id, id));
      const core = await signJWT({ email }, SECRET, 3600);
      if (origin === "legacy") {
        expect((await apiReply(api().verifyEmail({ query: { token: core } }))).status).toBe(401);
        await api().sendVerificationEmail({ body: { email } });
        await settle();
        expect(cfg.outbox.filter((m) => m.to === email).at(-1)!.text).not.toMatch(/https?:\/\//);
      }
      await reset(email, "origin-reset-password-123");
      expect((await OPS.user(h.db, h.schema, email))?.emailVerified).toBe(origin === "legacy" || origin === "invite");
      expect(await OPS.sessionsOf(h.db, h.schema, email)).toBe(0);
    }
    const email = mail("invite-core");
    const id = await OPS.addPasswordUser(h.db, h.schema, email, PASSWORD, "member");
    await h.db.update((h.schema as any).user).set({ emailVerified: false, signupOrigin: "invite" }).where(eq((h.schema as any).user.id, id));
    expect((await apiReply(api().verifyEmail({ query: { token: await signJWT({ email }, SECRET, 3600) } }))).status).toBe(401);
    expect((await OPS.user(h.db, h.schema, email))?.emailVerified).toBe(false);
  });

  it("H1.ERROR: 해시가 담긴 DB 오류는 인증·변경 오류나 응답에 전달하지 않는다", async () => {
    const x = await signup("safe-error");
    const hash = (await credential(x.id)).password;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const update = vi.spyOn(h.db, "update").mockImplementation(() => {
      const error = Object.assign(new Error(`query failed ${hash}`), { params: [hash], cause: new Error(hash) });
      return { set: () => ({ where: () => ({ then: (_ok: any, fail: any) => fail(error), returning: () => Promise.reject(error) }) }) };
    });
    try {
      let caught: any;
      try { await api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } }); }
      catch (e) { caught = e; }
      expect(caught?.statusCode).toBe(500);
      expect(String(caught)).not.toContain(hash);
      expect(JSON.stringify(caught)).not.toContain(hash);
      expect(caught?.cause).toBeUndefined();
      const response = await auth.handler(new Request(`${BASE}/api/auth/signup-confirmation`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ token: x.token, password: PASSWORD }) }));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(hash);
      expect(JSON.stringify(log.mock.calls)).not.toContain(hash);
    } finally { update.mockRestore(); log.mockRestore(); }
    await api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } });
    const login = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    const cookie = login.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ");
    const changeLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = vi.spyOn(h.db, "update").mockImplementation(() => {
      const error = Object.assign(new Error(hash), { query: hash, params: [hash], cause: new Error(hash) });
      return { set: () => ({ where: () => ({ then: (_ok: any, fail: any) => fail(error), returning: () => Promise.reject(error) }) }) };
    });
    try {
      let caught: any;
      try { await api().changePassword({ headers: new Headers({ cookie }), body: { currentPassword: PASSWORD, newPassword: "safe-new-password-123" } }); }
      catch (e) { caught = e; }
      expect(caught?.statusCode).toBe(500);
      expect(String(caught)).not.toContain(hash);
      expect(JSON.stringify(caught)).not.toContain(hash);
      expect(caught?.cause).toBeUndefined();
      const response = await auth.handler(new Request(`${BASE}/api/auth/change-password`, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "safe-new-password-123" }) }));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(hash);
      expect(JSON.stringify(changeLog.mock.calls)).not.toContain(hash);
    } finally { failed.mockRestore(); changeLog.mockRestore(); }
  });

  it("H1.NULL: 검증된 legacy·비credential 세션은 유지하고 미인증·삭제 회원의 NULL 세션은 거부한다", async () => {
    for (const state of ["legacy", "oauth", "unverified", "deleted"]) {
      const email = mail(`null-${state}`);
      const id = await OPS.addPasswordUser(h.db, h.schema, email, PASSWORD, "member");
      const login = await api().signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
      const headers = new Headers({ cookie: login.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ") });
      await h.db.update((h.schema as any).session).set({ credentialFingerprint: null }).where(eq((h.schema as any).session.userId, id));
      if (state === "oauth") await h.db.delete((h.schema as any).account).where(eq((h.schema as any).account.userId, id));
      if (state === "unverified") await h.db.update((h.schema as any).user).set({ emailVerified: false }).where(eq((h.schema as any).user.id, id));
      if (state === "deleted") await h.db.update((h.schema as any).user).set({ deletedAt: new Date() }).where(eq((h.schema as any).user.id, id));
      if (["legacy", "oauth"].includes(state)) {
        expect(await api().getSession({ headers })).not.toBeNull();
        expect((await apiReply(api().listUserAccounts({ headers }))).status).toBe(200);
      } else {
        expect((await apiReply(api().listUserAccounts({ headers }))).status).toBe(401);
        expect(await api().getSession({ headers })).toBeNull();
        expect(await (await auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers }))).json()).toBeNull();
        expect(await OPS.sessionsOf(h.db, h.schema, email)).toBe(0);
      }
    }
  });

  it("H1.CHANGE.concurrent: 같은 현재 비밀번호의 동시 변경은 하나만 성공한다", async () => {
    const x = await signup("change-concurrent");
    await api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } });
    const login = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    const headers = new Headers({ cookie: login.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ") });
    let n = 0;
    const pause = barrier();
    const { betterAuth } = await import("better-auth");
    const { authOptions } = await import("../src/index.ts");
    const { verifyPassword } = await import("better-auth/crypto");
    const options = authOptions(cfg);
    (options.emailAndPassword as any).password = { hash: hashPassword, verify: async (input: any) => {
      const valid = await verifyPassword(input);
      if (++n === 2) pause.release();
      await pause.wait();
      return valid;
    } };
    const instance = betterAuth(options);
    const replies = await Promise.all(["one", "two"].map((tag) => apiReply((instance.api as any).changePassword({ headers, body: { currentPassword: PASSWORD, newPassword: `concurrent-${tag}-password-123`, revokeOtherSessions: false } }))));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await api().getSession({ headers })).not.toBeNull();
  });

  it("H1.ERROR.keep: 유지 세션 UPDATE 오류도 HTTP·로그·cause에 해시를 전달하지 않는다", async () => {
    const x = await signup("keep-error");
    await api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } });
    const login = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    const cookie = login.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ");
    const hash = (await credential(x.id)).password;
    const originalUpdate = h.db.update.bind(h.db);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const hashes = [hash];
    const mock = vi.spyOn(h.db, "update").mockImplementation((table: any) => {
      if (table !== (h.schema as any).session) return { set: (values: any) => {
        if (typeof values.password === "string") hashes.push(values.password);
        return originalUpdate(table).set(values);
      } };
      return { set: () => ({ where: () => Promise.reject(Object.assign(new Error(hashes.join(" ")), { params: hashes, cause: new Error(hashes.join(" ")) })) }) };
    });
    try {
      const response = await auth.handler(new Request(`${BASE}/api/auth/change-password`, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "keep-error-password-123", revokeOtherSessions: false }) }));
      expect(response.status).toBe(500);
      const text = await response.text();
      for (const value of hashes) {
        expect(text.includes(value)).toBe(false);
        expect(JSON.stringify(errors.mock.calls).includes(value)).toBe(false);
      }
      await originalUpdate((h.schema as any).account).set({ password: hash }).where(eq((h.schema as any).account.userId, x.id));
      let caught: any;
      try { await api().changePassword({ headers: new Headers({ cookie }), body: { currentPassword: PASSWORD, newPassword: "keep-api-error-password-123", revokeOtherSessions: false } }); }
      catch (e) { caught = e; }
      expect(caught?.statusCode).toBe(500);
      expect(caught?.cause).toBeUndefined();
      for (const value of hashes) {
        expect(String(caught).includes(value)).toBe(false);
        expect(JSON.stringify(caught).includes(value)).toBe(false);
        expect(JSON.stringify(errors.mock.calls).includes(value)).toBe(false);
      }
    } finally { mock.mockRestore(); errors.mockRestore(); }
  });

  it("H1.SESSION: 변경된 credential의 남은 세션은 getSession과 내부 보호 API에서 삭제·거부한다", async () => {
    const x = await signup("stale-session");
    await api().confirmSignupEmail({ body: { token: x.token, password: PASSWORD } });
    const login = await api().signInEmail({ body: { email: x.email, password: PASSWORD }, returnHeaders: true });
    const cookie = login.headers.getSetCookie().map((v: string) => v.split(";")[0]).join("; ");
    const account = await credential(x.id);
    await h.db.update((h.schema as any).account).set({ password: await hashPassword("changed-password-456") }).where(eq((h.schema as any).account.id, account.id));
    const headers = new Headers({ cookie });
    expect((await apiReply(api().listUserAccounts({ headers }))).status).toBe(401);
    expect(await api().getSession({ headers })).toBeNull();
    const response = await auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers }));
    expect(await response.json()).toBeNull();
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
  });
});
