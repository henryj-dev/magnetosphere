// M4.T3: 승인된 새 제품 정책. 역사적 V30 라이브러리 측정값은 이 파일에서 바꾸지 않는다.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { authOptions, CLIENT_IP_HEADER, createAuth } from "../src/index.ts";
import * as authRoot from "../src/index.ts";
import { bindSelfDeleteProof, selfDeleteCredentialProofOf } from "../src/internal.ts";
import { validAuthVersion } from "../src/auth-version.ts";
import { AUTH_VERSION_MAX } from "@magnetosphere/db/src/schema/common.ts";
import { OPEN, type TestDb } from "./db.ts";
import { makeAuthConfig, randomIp } from "./helpers.ts";
import { apiReply, mail, OPS, PASSWORD } from "./signup-policy/rig.ts";

const BASE = "http://localhost:3000";
const kinds = (process.env.MG_TEST_DBS ?? "sqlite").split(",") as (keyof typeof OPEN)[];
const BARRIER_MS = 15_000;
const BOUNDARIES = ["verify", "before-insert", "after-insert", "final-response"] as const;
const timeout = (message: string, set: (timer: ReturnType<typeof setTimeout>) => void) => new Promise<never>((_, reject) => { set(setTimeout(() => reject(new Error(message)), BARRIER_MS)); });
// 경계에서 멈춘 요청은 release 또는 15초 뒤 실패로 반드시 끝난다. 시험은 finally 에서 release 한다.
function barrier() {
  let arrive!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  const wait = async () => {
    arrive();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([resumed, timeout("barrier 해제 대기 시간 초과", (t) => { timer = t; })]); }
    finally { clearTimeout(timer); }
  };
  return { reached, release, wait };
}
// 요청이 경계 전에 끝나거나 15초 안에 경계에 오지 않으면 바로 실패한다.
async function reach(pause: ReturnType<typeof barrier>, pending: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = pending.then(() => { throw new Error("요청이 경계에 닿기 전에 끝났다"); }, () => { throw new Error("요청이 경계에 닿기 전에 실패했다"); });
  try { await Promise.race([pause.reached, early, timeout("경계 도달 대기 시간 초과", (t) => { timer = t; })]); }
  finally { clearTimeout(timer); }
}
const cookie = (headers: Headers) => headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

describe("M4.T3 version 값 검증", () => {
  it("DB 값을 형변환·보정하지 않고 정수 0..상한만 허용한다", () => {
    for (const value of [null, undefined, "0", false, -1, 0.5, NaN, Infinity, AUTH_VERSION_MAX + 1, Number.MAX_SAFE_INTEGER + 1]) expect(validAuthVersion(value)).toBe(false);
    for (const value of [0, 1, AUTH_VERSION_MAX]) expect(validAuthVersion(value)).toBe(true);
  });
});

describe.each(kinds)("%s M4.T3 session status/version", (kind) => {
  let h: TestDb, cfg: ReturnType<typeof makeAuthConfig>, auth: ReturnType<typeof createAuth>;
  const api = () => auth.api as any;
  const add = async (tag: string, status: "active" | "pending" | "suspended" = "active") => {
    const email = mail(`m4-${tag}`);
    const id = await OPS.addPasswordUser(h.db, h.schema, email, PASSWORD, "member", status);
    return { id, email };
  };
  const signIn = (email: string, password = PASSWORD) => api().signInEmail({ body: { email, password }, returnHeaders: true });
  const user = async (id: string) => (await h.db.select().from((h.schema as any).user).where(eq((h.schema as any).user.id, id)))[0];
  const transition = async (id: string, values: Record<string, any>) => {
    const s = h.schema as any;
    await h.db.transaction(async (tx: any) => {
      await tx.update(s.user).set({ ...values, authVersion: sql`${s.user.authVersion} + 1` }).where(eq(s.user.id, id));
      await tx.delete(s.session).where(eq(s.session.userId, id));
    });
  };
  beforeAll(async () => { h = await OPEN[kind](); cfg = makeAuthConfig(h); auth = createAuth(cfg); });
  afterAll(async () => { while (cfg.pending.length) await Promise.all(cfg.pending.splice(0)); await h?.close(); });

  it("M4.T3.a: pending/suspended는 올바른 비밀번호 뒤에만 상태 오류, deleted/없는 메일/틀린 비밀번호는 같은 응답", async () => {
    const responses: Awaited<ReturnType<typeof apiReply>>[] = [];
    const httpResponses: { status: number; body: string }[] = [];
    for (const status of ["active", "pending", "suspended"] as const) {
      const x = await add(`state-${status}`, status);
      responses.push(await apiReply(signIn(x.email, "wrong-password-123")));
      const wrong = await auth.handler(new Request(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ email: x.email, password: "wrong-password-123" }) }));
      expect(wrong.headers.getSetCookie()).toEqual([]);
      httpResponses.push({ status: wrong.status, body: await wrong.text() });
      const signing = signIn(x.email);
      const result = await apiReply(signing);
      if (status === "suspended") {
        expect(result.status).toBe(403);
        expect(result.code).toBe("account_suspended");
        const rejected = await auth.handler(new Request(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ email: x.email, password: PASSWORD }) }));
        expect(rejected.status).toBe(403);
        expect((await rejected.json() as any).code).toBe("ACCOUNT_SUSPENDED");
        expect(rejected.headers.getSetCookie()).toEqual([]);
        expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
      }
      else {
        expect(result.status).toBe(200);
        const signed = await signing;
        expect(typeof signed.response.token).toBe("string");
        expect(signed.headers.getSetCookie()).toHaveLength(1);
        expect((await api().getSession({ headers: new Headers({ cookie: cookie(signed.headers) }) }))?.user.id).toBe(x.id);
        expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(1);
        const http = await auth.handler(new Request(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ email: x.email, password: PASSWORD }) }));
        expect(http.status).toBe(200);
        expect(typeof (await http.json() as any).token).toBe("string");
        expect(http.headers.getSetCookie()).toHaveLength(1);
        const headers = new Headers({ cookie: cookie(http.headers) });
        expect((await api().getSession({ headers }))?.user.id).toBe(x.id);
        const httpSession = await auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers }));
        expect(httpSession.status).toBe(200);
        expect((await httpSession.json() as any)?.user.id).toBe(x.id);
        expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(2);
      }
    }
    const removed = await add("deleted");
    await transition(removed.id, { status: "deleted", deletedAt: new Date() });
    const missing = mail("missing");
    responses.push(await apiReply(signIn(removed.email)), await apiReply(signIn(missing)));
    for (const email of [removed.email, missing]) {
      const rejected = await auth.handler(new Request(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) }));
      expect(rejected.headers.getSetCookie()).toEqual([]);
      httpResponses.push({ status: rejected.status, body: await rejected.text() });
    }
    expect(responses.map((value) => ({ status: value.status, body: value.body }))).toEqual(Array.from({ length: responses.length }, () => ({ status: 401, body: responses[0].body })));
    expect(httpResponses).toEqual(Array.from({ length: httpResponses.length }, () => ({ status: 401, body: httpResponses[0].body })));
  });

  it("M4.T3.b: 정상 로그인 둘과 다른 회원 변경은 오탐 없이 성공한다", async () => {
    const x = await add("normal-two"), other = await add("unrelated");
    const results = await Promise.all([signIn(x.email), signIn(x.email)]);
    await transition(other.id, { status: "suspended" });
    for (const result of results) expect(await api().getSession({ headers: new Headers({ cookie: cookie(result.headers) }) })).not.toBeNull();
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(2);
  });

  /** 운영 createAuth 와 같은 authOptions(cfg)의 원본 handler 로그인을 boundary 에서 멈춘다. 해제는 호출한 시험의 finally 에서 한다 */
  const raceSignIn = (email: string, boundary: (typeof BOUNDARIES)[number], pause: ReturnType<typeof barrier>) => {
    const options = authOptions(cfg);
    if (boundary === "verify") (options.emailAndPassword as any).password = { hash: hashPassword, verify: async (input: any) => { const valid = await verifyPassword(input); await pause.wait(); return valid; } };
    if (boundary === "before-insert") {
      const before = options.databaseHooks.session.create.before;
      options.databaseHooks.session.create.before = async (session: any, ctx: any) => { const checked = await before(session, ctx); await pause.wait(); return checked; };
    }
    if (boundary === "after-insert") {
      const after = options.databaseHooks.session.create.after;
      options.databaseHooks.session.create.after = async (session: any, ctx: any) => { await pause.wait(); await after(session, ctx); };
    }
    if (boundary === "final-response") {
      const after = options.hooks.after;
      options.hooks.after = Object.assign(async (ctx: any) => { await pause.wait(); return after(ctx); }, after);
    }
    const instance = betterAuth(options);
    // withClientIp를 거치지 않는 원본 handler라 IP를 직접 싣는다. 없으면 경계 시험들이 한 칸(/sign-in/* 60초 5회)을 나눠 429로 경계 전에 끝난다.
    return instance.handler(new Request(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { origin: BASE, "content-type": "application/json", [CLIENT_IP_HEADER]: randomIp() }, body: JSON.stringify({ email, password: PASSWORD }) }));
  };

  for (const boundary of BOUNDARIES) {
    it(`M4.T3.c/e/g: ${boundary} 경계 중 정지가 유지되면 쿠키·세션 없이 거부하고 다시 로그인해도 정지 응답이다`, async () => {
      const x = await add(`${boundary}-held`), pause = barrier();
      const pending = raceSignIn(x.email, boundary, pause);
      try {
        await reach(pause, pending);
        await transition(x.id, { status: "suspended" });
      } finally { pause.release(); }
      const response = await pending;
      // 경계 전 관찰 version 이 바뀌었으므로 정지 여부와 상관없이 같은 401 로 닫힌다
      expect(response.status).toBe(401);
      expect(((await response.json()) as any).code).toBe("INVALID_EMAIL_OR_PASSWORD");
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
      expect(await user(x.id)).toMatchObject({ status: "suspended", authVersion: 1 });
      const again = await apiReply(signIn(x.email));
      expect([again.status, again.code]).toEqual([403, "account_suspended"]);
      expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
    });

    for (const aba of ["status", "role"] as const) {
      it(`M4.T3.c/e/g: ${boundary} 경계 ${aba} ABA도 옛 세션/쿠키를 거부한다`, async () => {
        const x = await add(`${boundary}-${aba}`), pause = barrier();
        const pending = raceSignIn(x.email, boundary, pause);
        try {
          await reach(pause, pending);
          await transition(x.id, aba === "status" ? { status: "suspended" } : { role: "admin" });
          await transition(x.id, aba === "status" ? { status: "active" } : { role: "member" });
        } finally { pause.release(); }
        const response = await pending;
        expect(response.status).toBe(401);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
        expect((await user(x.id)).authVersion).toBe(2);
      });
    }
  }

  it("M4.T3.pending: 인증된 pending 은 로그인·세션만 되고 비밀번호 변경·자기 탈퇴 증명은 거부하며 NULL 지문 세션은 무효다", async () => {
    const x = await add("pending", "pending"), signed = await signIn(x.email);
    expect(signed.headers.getSetCookie()).toHaveLength(1);
    const headers = new Headers({ cookie: cookie(signed.headers) });
    expect((await api().getSession({ headers }))?.user.id).toBe(x.id);
    for (const revokeOtherSessions of [undefined, false, true]) {
      const res = await auth.handler(new Request(`${BASE}/api/auth/change-password`, { method: "POST", headers: { cookie: cookie(signed.headers), origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "m4-pending-password-123", ...(revokeOtherSessions === undefined ? {} : { revokeOtherSessions }) }) }));
      expect(res.status).toBe(401);
      expect(((await res.json()) as any).code).toBe("INVALID_EMAIL_OR_PASSWORD");
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    const s = h.schema as any;
    const [account] = await h.db.select().from(s.account).where(eq(s.account.userId, x.id));
    expect(await verifyPassword({ hash: account.password, password: PASSWORD })).toBe(true);
    expect(await user(x.id)).toMatchObject({ status: "pending", authVersion: 0 });
    const [row] = await h.db.select().from(s.session).where(eq(s.session.userId, x.id));
    expect(await selfDeleteCredentialProofOf(auth)({ userId: x.id, sessionId: row.id, password: PASSWORD })).toBeNull();
    // 거부는 현재 pending 세션을 지우지 않는다
    expect((await api().getSession({ headers }))?.user.id).toBe(x.id);
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(1);
    // pending 은 credential 문자열 지문만 허용한다. 기존 NULL 지문·OAuth 꼴 세션은 active 와 달리 무효다
    for (const state of ["legacy", "oauth"] as const) {
      const y = await add(`pending-${state}`, "pending"), other = await signIn(y.email);
      const otherHeaders = new Headers({ cookie: cookie(other.headers) });
      await h.db.update(s.session).set({ credentialFingerprint: null }).where(eq(s.session.userId, y.id));
      if (state === "oauth") await h.db.delete(s.account).where(eq(s.account.userId, y.id));
      expect((await apiReply(api().listUserAccounts({ headers: otherHeaders }))).status).toBe(401);
      expect(await api().getSession({ headers: otherHeaders })).toBeNull();
      expect(await OPS.sessionsOf(h.db, h.schema, y.email)).toBe(0);
    }
  });

  it("M4.T3.f: NULL 지문/OAuth도 상태와 version을 authoritative getSession/core 보호 API에서 검사한다", async () => {
    for (const state of ["normal", "suspended", "version", "invalid-session"] as const) {
      const x = await add(`null-${state}`), signed = await signIn(x.email);
      const headers = new Headers({ cookie: cookie(signed.headers) });
      const s = h.schema as any;
      await h.db.update(s.session).set({ credentialFingerprint: null }).where(eq(s.session.userId, x.id));
      await h.db.delete(s.account).where(eq(s.account.userId, x.id));
      if (state === "suspended") await h.db.update(s.user).set({ status: "suspended" }).where(eq(s.user.id, x.id));
      if (state === "version") await h.db.update(s.user).set({ authVersion: 1 }).where(eq(s.user.id, x.id));
      if (state === "invalid-session") await h.db.update(s.session).set({ authVersion: -1 }).where(eq(s.session.userId, x.id));
      if (state === "normal") { expect(await api().getSession({ headers })).not.toBeNull(); expect((await apiReply(api().listUserAccounts({ headers }))).status).toBe(200); }
      else { expect((await apiReply(api().listUserAccounts({ headers }))).status).toBe(401); expect(await api().getSession({ headers })).toBeNull(); expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0); }
    }
  });

  it("M4.T3.input: authVersion은 가입/세션 응답에 없고 client 입력으로 갱신되지 않는다", async () => {
    const x = await add("hidden"), signed = await signIn(x.email);
    expect(JSON.stringify(signed.response)).not.toContain("authVersion");
    const headers = new Headers({ cookie: cookie(signed.headers) });
    expect(JSON.stringify(await api().getSession({ headers }))).not.toContain("authVersion");
    expect((await apiReply(api().updateUser({ headers, body: { authVersion: 123 } }))).status).toBe(400);
    expect((await user(x.id)).authVersion).toBe(0);
  });

  it("M4.T3.invalid: DB user version이 잘못되면 성공 로그인/세션은 없다", async () => {
    for (const version of [-1, ...(kind === "sqlite" ? [0.5, AUTH_VERSION_MAX + 1] : [])]) {
      const x = await add(`invalid-${version}`), s = h.schema as any;
      await h.db.update(s.user).set({ authVersion: version }).where(eq(s.user.id, x.id));
      const correct = await apiReply(signIn(x.email));
      const wrong = await apiReply(signIn(x.email, "wrong-password-123"));
      const missing = await apiReply(signIn(mail(`invalid-missing-${version}`)));
      expect(correct.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(missing.status).toBe(401);
      expect(correct.code).toBe("invalid_email_or_password");
      expect(wrong.body).toBe(missing.body);
      expect(correct.body).toBe(missing.body);
      expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(0);
    }
  });

  for (const revokeOtherSessions of [undefined, false, true]) {
    it(`M4.T3.d: revokeOtherSessions=${revokeOtherSessions}도 타 세션 해제/현재 쿠키 계약을 지킨다`, async () => {
      const x = await add(`change-${revokeOtherSessions}`);
      const first = await signIn(x.email), other = await signIn(x.email);
      const headers = new Headers({ cookie: cookie(first.headers) });
      const changed = await api().changePassword({ headers, body: { currentPassword: PASSWORD, newPassword: "m4-changed-password-123", ...(revokeOtherSessions === undefined ? {} : { revokeOtherSessions }) }, returnHeaders: true });
      expect(changed.response.user.id).toBe(x.id);
      expect(JSON.stringify(changed.response)).not.toContain("authVersion");
      expect(await api().getSession({ headers: new Headers({ cookie: cookie(other.headers) }) })).toBeNull();
      expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(1);
      expect((await user(x.id)).authVersion).toBe(1);
      if (revokeOtherSessions) {
        expect(typeof changed.response.token).toBe("string");
        expect(changed.headers.getSetCookie()).toHaveLength(1);
        expect(await api().getSession({ headers })).toBeNull();
        expect(await api().getSession({ headers: new Headers({ cookie: cookie(changed.headers) }) })).not.toBeNull();
      } else {
        expect(changed.response.token).toBeNull();
        // before 훅이 응답을 대신하고 쿠키를 쓰지 않으면 core는 headers를 undefined로 돌려준다 (dispatch: responseHeaders 미생성).
        expect(changed.headers?.getSetCookie() ?? []).toEqual([]);
        expect(await api().getSession({ headers })).not.toBeNull();
      }
    });
  }

  it("M4.T3.oauth-aba: SDK helper의 최초 join 조회 뒤 ABA는 sessionBefore에서 401로 닫힌다", async () => {
    const { handleOAuthUserInfo } = await import("better-auth/oauth2");
    const { runWithEndpointContext } = await import("@better-auth/core/context");
    const s = h.schema as any;
    const fixture = async (tag: string, pause?: ReturnType<typeof barrier>) => {
      const x = await add(tag);
      const accountId = `fixture-${x.id}`;
      await h.db.insert(s.account).values({ id: crypto.randomUUID(), accountId, providerId: "github", userId: x.id, createdAt: new Date(), updatedAt: new Date() });
      const options = authOptions(cfg);
      const reached = { joinRead: 0, sessionBefore: 0 };
      const database = options.database;
      options.database = (input: any) => {
        const wrap = (adapter: any): any => ({
          ...adapter,
          transaction: (callback: any) => adapter.transaction((child: any) => callback(wrap(child))),
          findMany: async (query: any) => {
            const rows = await adapter.findMany(query);
            if (query.model === "account" && query.join?.user && rows.some((row: any) => row.user?.id === x.id)) {
              reached.joinRead++;
              if (pause && reached.joinRead === 1) await pause.wait();
            }
            return rows;
          },
        });
        return wrap(database(input));
      };
      const before = options.databaseHooks.session.create.before;
      options.databaseHooks.session.create.before = async (session: any, context: any) => { reached.sessionBefore++; return before(session, context); };
      const instance = betterAuth(options);
      // provider는 시험 요청 문맥에만 공급한다. factory socialProviders 옵션/운영 IdP 설정은 바꾸지 않는다.
      const endpoint: any = {
        path: "/callback/github", headers: new Headers(), responseHeaders: new Headers(),
        context: { ...await instance.$context, socialProviders: [{ id: "github", options: {} }] },
        redirect: () => { throw new Error("예상하지 않은 SDK redirect 경계"); },
      };
      const invoke = () => runWithEndpointContext(endpoint, () => handleOAuthUserInfo(endpoint, {
        userInfo: { id: accountId, email: x.email, emailVerified: true, name: "회원" },
        account: { providerId: "github", accountId }, callbackURL: BASE, disableSignUp: true,
      }));
      return { x, reached, invoke };
    };
    const positive = await fixture("oauth-positive");
    const accepted = await positive.invoke();
    expect(accepted.error).toBeNull();
    expect(accepted.data?.user.id).toBe(positive.x.id);
    expect(accepted.data?.session.userId).toBe(positive.x.id);
    expect(positive.reached).toEqual({ joinRead: 1, sessionBefore: 1 });
    expect(await OPS.sessionsOf(h.db, h.schema, positive.x.email)).toBe(1);

    for (const aba of ["role", "status"] as const) {
      const pause = barrier(), raced = await fixture(`oauth-aba-${aba}`, pause);
      // helper 자체는 쿠키를 발급하지 않는다. 이 시험은 생성 경계 증거이며 callback 응답 쿠키 방어 증거가 아니다.
      const pending = apiReply(raced.invoke());
      try {
        await reach(pause, pending);
        await transition(raced.x.id, aba === "role" ? { role: "admin" } : { status: "suspended" });
        await transition(raced.x.id, aba === "role" ? { role: "member" } : { status: "active" });
      } finally { pause.release(); }
      const result = await pending;
      expect(result.status).toBe(401);
      expect(result.code).toBe("invalid_email_or_password");
      expect(raced.reached).toEqual({ joinRead: 1, sessionBefore: 1 });
      expect(await OPS.sessionsOf(h.db, h.schema, raced.x.email)).toBe(0);
      expect((await user(raced.x.id)).authVersion).toBe(2);
    }
  });

  it("M4.T3.proof: selfDeleteCredentialProof는 내부 반환만 하고 HTTP/API/오류/로그에 비밀을 노출하지 않는다", async () => {
    const x = await add("proof"), signed = await signIn(x.email);
    const session = (await h.db.select().from((h.schema as any).session).where(eq((h.schema as any).session.userId, x.id)))[0];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(Object.keys(authRoot).sort()).toEqual(["CLIENT_IP_HEADER", "MIN_SECRET_LENGTH", "RATE_LIMIT_RULES", "SSO_DISABLED_PATHS", "authOptions", "createAuth", "resolveClientIp"].sort());
      expect(Reflect.ownKeys(auth).sort()).toEqual(["api", "handler"]);
      const prove = selfDeleteCredentialProofOf(auth);
      expect(() => selfDeleteCredentialProofOf({})).toThrowError(new Error("Self-delete proof is not registered"));
      expect(() => selfDeleteCredentialProofOf({ ...auth })).toThrowError(new Error("Self-delete proof is not registered"));
      const replacement = vi.fn(prove);
      expect(() => bindSelfDeleteProof(auth, replacement)).toThrowError(new Error("Self-delete proof is already registered"));
      expect(selfDeleteCredentialProofOf(auth)).toBe(prove);
      expect(replacement).not.toHaveBeenCalled();
      const proof = await prove({ userId: x.id, sessionId: session.id, password: PASSWORD });
      expect(proof?.authVersion).toBe(0);
      expect(proof?.observedSessionFingerprint).toBe(session.credentialFingerprint);
      expect(proof?.currentCredentialFingerprint).toBe(session.credentialFingerprint);
      expect(typeof proof?.passwordHash).toBe("string");
      expect(await api().getSession({ headers: new Headers({ cookie: cookie(signed.headers) }) })).not.toBeNull();
      expect(JSON.stringify(signed.response)).not.toContain(proof!.passwordHash);
      expect(JSON.stringify(errors.mock.calls)).not.toContain(proof!.passwordHash);
      expect(Object.keys(auth.api).some((name) => name.toLowerCase().includes("selfdelete"))).toBe(false);
      expect((await auth.handler(new Request(`${BASE}/api/auth/self-delete-credential-proof`, { method: "POST", headers: { cookie: cookie(signed.headers), origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ userId: x.id, sessionId: session.id, password: PASSWORD }) }))).status).toBe(404);
      for (const bad of [{ userId: x.id, sessionId: session.id, password: "wrong-password-123" }, { userId: "missing", sessionId: session.id, password: PASSWORD }]) expect(await prove(bad)).toBeNull();
    } finally { errors.mockRestore(); }
  });

  it("M4.T3.max: 상한은 순환하지 않고 credential/session/version을 바꾸지 않는다", async () => {
    const x = await add("max"), s = h.schema as any;
    await h.db.update(s.user).set({ authVersion: AUTH_VERSION_MAX }).where(eq(s.user.id, x.id));
    const signed = await signIn(x.email);
    const result = await apiReply(api().changePassword({ headers: new Headers({ cookie: cookie(signed.headers) }), body: { currentPassword: PASSWORD, newPassword: "max-new-password-123" } }));
    expect(result.status).toBe(401);
    expect((await user(x.id)).authVersion).toBe(AUTH_VERSION_MAX);
    const [account] = await h.db.select().from(s.account).where(eq(s.account.userId, x.id));
    expect(await verifyPassword({ hash: account.password, password: PASSWORD })).toBe(true);
    expect(await OPS.sessionsOf(h.db, h.schema, x.email)).toBe(1);
  });
});
