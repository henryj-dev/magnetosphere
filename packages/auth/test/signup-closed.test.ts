// 설치 뒤 사용자 생성 차단과 새 회원 기본 월 한도 (보안 고침). 네 DB 에서 돈다.
// 서버의 경로 검사(apps/server, TC-SEC.1.a)와 따로 Better Auth 안에서 막는지 본다. 새 엔드포인트·플러그인이 생겨도
// 사용자 행은 모두 internalAdapter.createUser·createOAuthUser 를 거치므로 그 두 길을 직접 부른다.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { DEFAULT_SETTINGS } from "@magnetosphere/db/src/seed.ts";
import { authOptions } from "../src/index.ts";
import { client, email, PASSWORD } from "./client.ts";
import { ALL_DBS, OPEN, type TestDb } from "./db.ts";
import { makeAuth, makeAuthConfig, userRow } from "./helpers.ts";

const schema = (h: TestDb) => h.schema as any;

async function addAdmin(h: TestDb) {
  const now = new Date();
  const id = crypto.randomUUID();
  await h.db.insert(schema(h).user).values({ id, name: "admin", email: `admin-${id}@example.test`, emailVerified: true, role: "admin", createdAt: now, updatedAt: now });
}

async function setSetting(h: TestDb, key: string, value: unknown) {
  const t = schema(h).appSettings;
  await h.db.delete(t).where(eq(t.key, key));
  if (value !== undefined) await h.db.insert(t).values({ key, value: JSON.stringify(value), updatedAt: new Date(), updatedBy: null });
}

async function userCount(h: TestDb): Promise<number> {
  return (await h.db.select({ id: schema(h).user.id }).from(schema(h).user)).length;
}

const limitOf = (row: any) => (row.monthlyLimitUsd === null ? null : Number(row.monthlyLimitUsd));

describe.each(ALL_DBS)("설치 뒤 사용자 생성 차단 — %s", (kind) => {
  let h: TestDb;
  beforeAll(async () => {
    h = await OPEN[kind]();
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-SEC.1.b 관리자가 있으면 Better Auth 의 모든 사용자 생성 경로가 거부된다 (대조: 관리자 전에는 만들어진다)", async () => {
    const app = makeAuth(h);
    const ctx = await betterAuth(authOptions(makeAuthConfig(h))).$context;

    // 대조: 관리자가 없으면(설치 전, 서버가 /sign-up 을 setup_required 로 막는 구간) Better Auth 는 그대로 만든다
    const early = email("early");
    expect((await client(app.handler).post("/sign-up/email", { email: early, password: PASSWORD, name: "x" })).status).toBe(200);
    expect(await userRow(h, early)).toBeDefined();

    await addAdmin(h);
    const before = await userCount(h);
    for (const mode of [undefined, "invite_only", "open"]) {
      await setSetting(h, "signup_mode", mode);
      // 1) HTTP 가입 (서버의 경로 검사 없이 Better Auth handler 에 바로). 새 이메일과 이미 있는 이메일이 같은 응답이다 (계정 존재 숨김)
      for (const e of [email("http"), early]) {
        const r = await client(app.handler).post("/sign-up/email", { email: e, password: PASSWORD, name: "x" });
        expect({ status: r.status, code: r.json?.code }, `${mode} http ${e}`).toEqual({ status: 403, code: "SIGNUP_CLOSED" });
      }
      // 2) 서버 안 호출 auth.api.signUpEmail
      await expect(app.api.signUpEmail({ body: { email: email("api"), password: PASSWORD, name: "x" } }), `${mode} api`).rejects.toMatchObject({ body: { code: "SIGNUP_CLOSED" } });
      // 3) OAuth·SSO 콜백의 JIT 생성이 부르는 길 (handleOAuthUserInfo → createOAuthUser / link-account → createUser)
      await expect(ctx.internalAdapter.createUser({ email: email("internal"), name: "x", emailVerified: true }, { method: "email-password" }), `${mode} createUser`).rejects.toMatchObject({ body: { code: "SIGNUP_CLOSED" } });
      await expect(
        ctx.internalAdapter.createOAuthUser({ email: email("oauth"), name: "x", emailVerified: true }, { providerId: "sso-idp", accountId: crypto.randomUUID() }),
        `${mode} createOAuthUser`,
      ).rejects.toMatchObject({ body: { code: "SIGNUP_CLOSED" } });
    }
    expect(await userCount(h)).toBe(before);
  });
});

describe.each(ALL_DBS)("새 회원 기본 월 한도 — %s", (kind) => {
  let h: TestDb;
  let app: ReturnType<typeof makeAuth>;
  beforeAll(async () => {
    h = await OPEN[kind]();
    app = makeAuth(h);
  });
  beforeEach(async () => {
    await setSetting(h, "default_limit_usd", undefined);
  });
  afterAll(async () => {
    await h?.close();
  });

  const signUp = async (body: Record<string, unknown> = {}) => {
    const e = email("limit");
    expect((await client(app.handler).post("/sign-up/email", { email: e, password: PASSWORD, name: "x", ...body })).status).toBe(200);
    return limitOf(await userRow(h, e));
  };

  test("TC-SEC.1.c Better Auth 로 만든 회원의 monthly_limit_usd 는 default_limit_usd (NULL=무제한이 아님)", async () => {
    // 설정 행이 없으면(시드 전) 시드 기본값
    expect(await signUp()).toBe(DEFAULT_SETTINGS.default_limit_usd);
    // 본문의 null 로 무제한을 고를 수 없다
    expect(await signUp({ monthlyLimitUsd: null })).toBe(DEFAULT_SETTINGS.default_limit_usd);
    // 운영자가 바꾼 값을 따른다
    await setSetting(h, "default_limit_usd", 7.25);
    expect(await signUp()).toBe(7.25);
    // 서버 안 호출도 같다
    const e = email("limit-api");
    await app.api.signUpEmail({ body: { email: e, password: PASSWORD, name: "x" } });
    expect(limitOf(await userRow(h, e))).toBe(7.25);
  });
});
