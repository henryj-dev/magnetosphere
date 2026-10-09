// S3.T1: Better Auth 구성. 권한 칼럼(TC-S3.T1.a)과 미인증 로그인(TC-S3.T1.b)은 DB 마다 돈다.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { client, email, PASSWORD } from "./client.ts";
import { ALL_DBS, OPEN, type TestDb } from "./db.ts";
import { betterAuth } from "better-auth";
import { authOptions } from "../src/index.ts";
import { makeAuth, makeAuthConfig, markVerified, PRIVILEGE_DEFAULTS, privileges, userRow } from "./helpers.ts";

// 공격 본문. 객체 키는 Better Auth 필드 이름(camelCase)이다. snake_case 는 DB 칼럼 이름으로 보내 보는 경우.
const SIGN_UP_CASES: { name: string; body: Record<string, unknown>; expect: 200 | 400 }[] = [
  // V17: 기본값이 있는 칼럼은 가입 때 조용히 기본값으로 바뀐다 (200), 기본값이 없는 칼럼은 400 FIELD_NOT_ALLOWED.
  { name: "role", body: { role: "admin" }, expect: 200 },
  { name: "status", body: { status: "active-admin" }, expect: 200 },
  { name: "isBootstrapAdmin", body: { isBootstrapAdmin: true }, expect: 200 },
  { name: "monthlyLimitUsd null", body: { monthlyLimitUsd: null }, expect: 200 },
  { name: "monthlyLimitUsd", body: { monthlyLimitUsd: 999999 }, expect: 400 },
  { name: "maxKeys", body: { maxKeys: 999 }, expect: 400 },
  { name: "다섯 한꺼번에", body: { role: "admin", status: "active", monthlyLimitUsd: null, maxKeys: 999, isBootstrapAdmin: 1 }, expect: 400 },
  { name: "칼럼 이름(snake_case)", body: { role: "admin", status: "active", monthly_limit_usd: 999999, max_keys: 999, is_bootstrap_admin: 1 }, expect: 200 },
];

const UPDATE_CASES: Record<string, unknown>[] = [
  { role: "admin" },
  { status: "active-admin" },
  { monthlyLimitUsd: 999999 },
  { maxKeys: 999 },
  { isBootstrapAdmin: true },
  { role: "admin", status: "active", monthlyLimitUsd: 1, maxKeys: 999, isBootstrapAdmin: 1 },
];

describe.each(ALL_DBS)("Better Auth 구성 — %s", (kind) => {
  let h: TestDb;
  let app: ReturnType<typeof makeAuth>;
  beforeAll(async () => {
    h = await OPEN[kind]();
    app = makeAuth(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-S3.T1.a 가입 요청의 권한 칼럼 값이 무시된다", async () => {
    for (const c of SIGN_UP_CASES) {
      const e = email("priv");
      const r = await client(app.handler).post("/sign-up/email", { email: e, password: PASSWORD, name: "x", ...c.body });
      const row = await userRow(h, e);
      if (c.expect === 200) {
        expect(r.status, c.name).toBe(200);
        expect(privileges(row), c.name).toEqual(PRIVILEGE_DEFAULTS);
      } else {
        expect(r.status, c.name).toBe(400);
        expect(r.json?.code, c.name).toBe("FIELD_NOT_ALLOWED");
        expect(row, `${c.name}: 계정이 만들어지면 안 된다`).toBeUndefined();
      }
    }
  });

  test("TC-S3.T1.a 회원정보 수정 요청의 권한 칼럼 값이 거부된다", async () => {
    const e = email("upd");
    const c = client(app.handler);
    expect((await c.post("/sign-up/email", { email: e, password: PASSWORD, name: "x" })).status).toBe(200);
    await markVerified(h, e);
    expect((await c.post("/sign-in/email", { email: e, password: PASSWORD })).status).toBe(200);
    // 대조: 권한 칼럼이 아닌 값은 바뀐다 (세션이 살아 있어 400 이 인증 실패 때문이 아님을 보인다)
    expect((await c.post("/update-user", { name: "renamed" })).status).toBe(200);
    for (const body of UPDATE_CASES) {
      const r = await c.post("/update-user", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json?.code, JSON.stringify(body)).toBe("FIELD_NOT_ALLOWED");
      expect(privileges(await userRow(h, e))).toEqual(PRIVILEGE_DEFAULTS);
    }
    expect((await userRow(h, e)).name).toBe("renamed");
  });

  test("TC-S3.T1.b 이메일 인증 전에는 로그인되지 않는다", async () => {
    const e = email("unverified");
    const c = client(app.handler);
    const up = await c.post("/sign-up/email", { email: e, password: PASSWORD, name: "x" });
    expect(up.status).toBe(200);
    expect(up.json?.token ?? null, "인증 전 가입 응답에 세션 토큰이 있으면 안 된다").toBeNull();
    const r = await c.post("/sign-in/email", { email: e, password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.json?.code).toBe("EMAIL_NOT_VERIFIED");
    expect(r.setCookie.some((x) => x.includes("session_token=") && !/max-age=0/i.test(x))).toBe(false);
    // 대조: 인증을 마치면 같은 자격으로 로그인된다
    await markVerified(h, e);
    expect((await c.post("/sign-in/email", { email: e, password: PASSWORD })).status).toBe(200);
  });
});

describe("세션·이메일 (SQLite)", () => {
  let h: TestDb;
  let app: ReturnType<typeof makeAuth>;
  beforeAll(async () => {
    h = await OPEN.sqlite();
    app = makeAuth(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-S3.T1.c 세션 쿠키는 HttpOnly·Secure·SameSite=Lax", async () => {
    const e = email("cookie");
    const c = client(app.handler);
    await c.post("/sign-up/email", { email: e, password: PASSWORD, name: "x" });
    await markVerified(h, e);
    const r = await c.post("/sign-in/email", { email: e, password: PASSWORD });
    expect(r.status).toBe(200);
    const session = r.setCookie.find((x) => /session_token=/.test(x));
    expect(session, "세션 쿠키 없음").toBeDefined();
    const attrs = session!.split(";").map((s) => s.trim().toLowerCase());
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("secure");
    expect(attrs).toContain("samesite=lax");
    // 로그인 응답의 쿠키는 모두 같은 속성을 가진다 (세션 데이터 캐시 쿠키 등)
    for (const ck of r.setCookie) expect(ck.toLowerCase(), ck).toMatch(/httponly.*secure|secure.*httponly/);
  });

  test("가입 전 이메일을 소문자로 다듬는다", async () => {
    const e = email("Case").replace("case", "CaSe");
    const r = await client(app.handler).post("/sign-up/email", { email: `  ${e.toUpperCase()} `, password: PASSWORD, name: "x" });
    expect(r.status).toBe(200);
    expect((await userRow(h, e))?.email).toBe(e.toLowerCase());
  });
});

const EVIL_PROVIDER = {
  providerId: "evil",
  issuer: "https://idp.evil.test",
  domain: "example.test",
  oidcConfig: { clientId: "a", clientSecret: "b", skipDiscovery: true, authorizationEndpoint: "https://idp.evil.test/a", tokenEndpoint: "https://idp.evil.test/t", jwksEndpoint: "https://idp.evil.test/j" },
};

describe("SSO 공개 관리 경로 (SQLite)", () => {
  let h: TestDb;
  let app: ReturnType<typeof makeAuth>;
  beforeAll(async () => {
    h = await OPEN.sqlite();
    app = makeAuth(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-S3.T1.d 로그인한 일반 회원에게 SSO 관리 경로는 404", async () => {
    const e = email("sso");
    const c = client(app.handler);
    await c.post("/sign-up/email", { email: e, password: PASSWORD, name: "x" });
    await markVerified(h, e);
    expect((await c.post("/sign-in/email", { email: e, password: PASSWORD })).status).toBe(200);
    const register = await c.post("/sso/register", EVIL_PROVIDER);
    expect(register.status).toBe(404);
    for (const p of ["/sso/update-provider", "/sso/delete-provider", "/sso/request-domain-verification", "/sso/verify-domain"]) {
      expect((await c.post(p, { providerId: "evil" })).status, p).toBe(404);
    }
    for (const p of ["/sso/providers", "/sso/get-provider?providerId=evil"]) expect((await c.get(p)).status, p).toBe(404);
    // 대조: 같은 세션으로 다른 경로는 열린다 (404 가 세션·기준 경로 문제 때문이 아님)
    expect((await c.get("/get-session")).status).toBe(200);

    // 대조: 차단만 뺀 같은 구성에서는 일반 회원의 /sso/register 가 404 가 아니다 (0단계 실측: 200 으로 등록됨)
    const open = betterAuth({ ...authOptions(makeAuthConfig(h)), disabledPaths: [] });
    const oc = client((r) => open.handler(r));
    expect((await oc.post("/sign-in/email", { email: e, password: PASSWORD })).status).toBe(200);
    expect((await oc.post("/sso/register", { ...EVIL_PROVIDER, providerId: "evil-open" })).status).not.toBe(404);
  });
});
