import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DBS, openDb } from "./dbs.mjs";
import { makeAuth, client } from "./auth.mjs";
import { registerProvider, oidcLogin } from "./keycloak.mjs";

const DAY = 24 * 3600 * 1000;
const log = (...a) => console.log("[v26]", ...a);

describe.each(DBS)("V26 $label", ({ kind, label }) => {
  let h;
  const hooks = {};
  let auth;
  beforeAll(async () => {
    h = await openDb(kind);
    auth = makeAuth(h, hooks);
  });
  afterAll(async () => { await h?.close(); });

  it("TC-S1.T6.a 가입·로그인·세션이 같은 결과를 낸다", async () => {
    const email = `user-a-${kind}@x.test`;
    const su = await client(auth).post("/sign-up/email", { email, password: "userpass1234", name: "User A" });
    expect(su.status).toBe(200);

    const c = client(auth);
    const t1 = Date.now();
    const si = await c.post("/sign-in/email", { email, password: "userpass1234" });
    const t2 = Date.now();
    expect(si.status).toBe(200);

    const gs = await c.get("/get-session");
    expect(gs.status).toBe(200);
    expect(gs.json?.session?.token).toBeTruthy(); // 즉시 만료되지 않았다
    const apiExp = new Date(gs.json.session.expiresAt).getTime();
    const row = await h.sessionByToken(gs.json.session.token);
    const dbExp = new Date(row.expiresAt).getTime();
    const rawRows = await h.raw(kind === "pg"
      ? `select expires_at::text as raw, current_setting('TimeZone') as tz from "session" where token = '${gs.json.session.token}'`
      : kind === "sqlite"
        ? `select expires_at as raw from session where token = '${gs.json.session.token}'`
        : `select cast(expires_at as char) as raw, @@session.time_zone as tz, @@global.time_zone as gtz from \`session\` where token = '${gs.json.session.token}'`);
    log(label, "a", JSON.stringify({ apiExp: new Date(apiExp).toISOString(), dbExp: new Date(dbExp).toISOString(), raw: rawRows[0], diffApiDbMs: Math.abs(apiExp - dbExp), offsetFromSignInMs: apiExp - (t1 + 7 * DAY) }));

    expect(Math.abs(apiExp - dbExp)).toBeLessThan(1000);
    // 기본 수명 7일. 로그인 요청 전후 시각 사이에 들어와야 한다 (시간대 오차는 시간 단위로 벗어난다)
    expect(dbExp).toBeGreaterThanOrEqual(t1 + 7 * DAY - 1000);
    expect(dbExp).toBeLessThanOrEqual(t2 + 7 * DAY + 1000);

    // 저장된 세션으로 다시 읽어도 같은 사용자
    const again = await c.get("/get-session");
    expect(again.json?.user?.email).toBe(email);
  });

  it("TC-S1.T6.b resolveUser 안 예외는 사용자 생성을 되돌린다", async () => {
    const providerId = `kc-${kind}`;
    const admin = client(auth);
    expect((await admin.post("/sign-up/email", { email: `admin-${kind}@example.com`, password: "adminpass1234", name: "Admin" })).status).toBe(200);
    const reg = await registerProvider(admin, providerId);
    log(label, "b register", reg.status, reg.text.slice(0, 160));
    expect(reg.status).toBe(200);

    const tried = [];
    async function attempt(name, setup, expectOk) {
      setup();
      const before = await h.counts();
      const cb = await oidcLogin(client(auth), providerId);
      const after = await h.counts();
      hooks.resolve = undefined; hooks.accountBefore = undefined;
      const d = { user: after.user - before.user, account: after.account - before.account };
      log(label, "b", name, cb.status, cb.location, JSON.stringify(d));
      tried.push({ name, status: cb.status, location: cb.location, delta: d });
      if (expectOk) {
        expect(cb.location).not.toMatch(/error=/);
        expect(d).toEqual({ user: 1, account: 1 });
      } else {
        expect(cb.location).toMatch(/error=/);
        expect(d).toEqual({ user: 0, account: 0 });
      }
      return cb;
    }

    // (1) resolveUser 가 바로 throw
    let seen;
    await attempt("resolveUser-throws", () => {
      hooks.resolve = async (input) => { seen = input; throw new Error("deny"); };
    }, false);
    expect(seen.providerClaims.groups).toEqual(["omni-admins"]); // 실제 Keycloak 클레임이 들어왔다

    // (2) resolveUser 가 받은 트랜잭션 어댑터로 user 행을 쓰고(안에서 보이는 것까지 확인) throw
    const ghost = `ghost-${kind}@example.com`;
    let wroteInside = null;
    await attempt("resolveUser-writes-then-throws", () => {
      hooks.resolve = async (_input, { database }) => {
        const now = new Date();
        await database.create({ model: "user", data: { name: "ghost", email: ghost, emailVerified: false, createdAt: now, updatedAt: now } });
        wroteInside = !!(await database.findOne({ model: "user", where: [{ field: "email", value: ghost }] }));
        throw new Error("deny after write");
      };
    }, false);
    expect(wroteInside).toBe(true);
    expect(await h.userByEmail(ghost)).toBeUndefined();

    // (3) resolveUser 는 통과, Better Auth 가 user 를 만든 뒤 account 생성에서 실패 → user 도 되돌려져야 한다
    await attempt("account-create-fails-after-user-insert", () => {
      hooks.accountBefore = async () => { throw new Error("account insert blocked"); };
    }, false);
    expect(await h.userByEmail("alice@example.com")).toBeUndefined();

    // (4) 대조군: continue 면 실제로 user·account 가 1씩 생긴다 (0 이 우연이 아님)
    await attempt("continue-control", () => { hooks.resolve = async () => ({ action: "continue" }); }, true);
    expect(await h.userByEmail("alice@example.com")).toBeTruthy();
    log(label, "b summary", JSON.stringify(tried));
  });

  it("TC-S1.T6.c 대소문자만 다른 이메일 중복이 같게 처리된다", async () => {
    const upper = `A-${kind}@x.test`, lower = `a-${kind}@x.test`;
    const r1 = await client(auth).post("/sign-up/email", { email: upper, password: "userpass1234", name: "A" });
    expect(r1.status).toBe(200);
    const stored = (await h.userByEmail(lower))?.email;
    const r2 = await client(auth).post("/sign-up/email", { email: lower, password: "userpass1234", name: "a" });
    log(label, "c", JSON.stringify({ first: r1.status, storedEmail: stored, second: r2.status, code: r2.json?.code }));
    expect(stored).toBe(lower); // Better Auth 가 소문자로 바꿔 저장
    expect(r2.status).not.toBe(200);
    const rows = await h.raw(kind === "pg" ? `select count(*)::int as n from "user" where lower(email) = '${lower}'`
      : kind === "sqlite" ? `select count(*) as n from user where lower(email) = '${lower}'`
      : `select count(*) as n from \`user\` where lower(email) = '${lower}'`);
    expect(Number(rows[0].n)).toBe(1);

    // 참고 관찰: Better Auth 를 거치지 않고 Drizzle 로 바로 넣으면 DB 마다 다르다 (단언하지 않고 기록만)
    const now = new Date();
    const ins = (id, email) => h.db.insert(h.schema.user).values({ id, name: "raw", email, emailVerified: false, createdAt: now, updatedAt: now });
    let rawDup;
    try { await ins(`rawU-${kind}`, `B-${kind}@x.test`); await ins(`rawL-${kind}`, `b-${kind}@x.test`); rawDup = "허용(두 행)"; }
    catch (e) { rawDup = "거부: " + String(e.cause?.message ?? e.message).slice(0, 120); }
    log(label, "c direct-insert", rawDup);
  });
});
