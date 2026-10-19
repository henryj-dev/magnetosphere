// M4 운영 앱 연결 계약 소스. 독립 Hono 가 아니라 createApp 에 실제 등록된 라우트를 app.request 로 호출한다.
// 가짜 인증·가짜 proof·가짜 OmniRoute 로 HTTP 연결만 확인한다. 실제 SDK 인증/credential 증거가 아니며 실행 승인은 별도다.
// 공용 env 는 읽기·재사용만 한다. DB fixture 생성은 beforeEach 안에서만 시작한다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_BODY_LIMIT, createApp, type Services } from "../../src/app.ts";
import { addUser, call, fakeAuth, fakeMfa, mfaAdminSession, openRoutes, ORIGIN, seedKey, type RouteEnv } from "../routes/env.ts";

const PASSWORD_HASH = "server-only-password-hash-m4";
const AUTH_SECRET = "server-only-auth-payload-m4";
const CIPHER_SECRET = "server-only-cipher-payload-m4";
let e: RouteEnv;
let s: Services;
let proof: ReturnType<typeof vi.fn<NonNullable<Services["auth"]["selfDeleteCredentialProof"]>>>;
beforeEach(async () => {
  e = await openRoutes();
  proof = vi.fn<NonNullable<Services["auth"]["selfDeleteCredentialProof"]>>().mockResolvedValue(null);
  const auth = fakeAuth();
  s = {
    db: e.h,
    auth: {
      async handler(req) {
        const res = await auth.handler(req);
        const body = await res.clone().json().catch(() => null) as { user?: { id?: string } } | null;
        if (!body?.user?.id) return res;
        // 과한 가짜 auth payload 를 반환해도 회원 API 는 허용 목록만 응답한다.
        return Response.json({ user: { ...body.user, password: PASSWORD_HASH, secret: AUTH_SECRET }, session: { id: body.user.id, token: AUTH_SECRET } });
      },
      selfDeleteCredentialProof: proof,
    },
    cipher: { encrypt: vi.fn().mockResolvedValue(CIPHER_SECRET), decrypt: vi.fn().mockResolvedValue(CIPHER_SECRET) } as Services["cipher"],
    mfa: await fakeMfa(e.h),
    omniroute: { baseUrl: null, initialPassword: null }, appOrigin: ORIGIN,
    keysClient: async () => () => e.om.client(),
  };
  e.app = createApp({ services: async () => s, assets: async (c) => c.text("spa"), setupTokenFromSecret: false, log: (line) => e.logs.push(line) });
});
afterEach(async () => { vi.restoreAllMocks(); await e?.close(); });

async function sessionFor(userId: string) {
  const [u] = await e.h.db.select({ role: e.h.schema.user.role }).from(e.h.schema.user).where(eq(e.h.schema.user.id, userId));
  // 관리자 세션은 관리자 MFA 를 마친 세션이다 (A1, routes/env.ts mfaAdminSession)
  if (u?.role === "admin") return mfaAdminSession(e.h, userId);
  await e.h.db.insert(e.h.schema.session).values({ id: userId, userId, authVersion: 0, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date() });
}
const noSecrets = (text: string) => {
  for (const value of [PASSWORD_HASH, AUTH_SECRET, CIPHER_SECRET]) expect(text).not.toContain(value);
  expect(text).not.toMatch(/"(?:password|passwordHash|credentialFingerprint|authVersion|accountId|token|cipher)"\s*:/);
};
const USER_FIELDS = ["createdAt", "email", "emailVerified", "id", "isBootstrapAdmin", "name", "role", "status"];

describe("M4 full createApp 등록 경로", () => {
  it("목록·승인·역할·정식 DELETE 와 기존 한도 PATCH 가 각각 연결되고 DTO 에 내부 비밀이 없다", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    await sessionFor(admin);
    const target = await addUser(e.h, { status: "pending" });
    await e.h.db.insert(e.h.schema.account).values({ id: randomUUID(), accountId: target, providerId: "credential", userId: target, password: PASSWORD_HASH, createdAt: new Date(), updatedAt: new Date() });
    const list = await call(e, "GET", "/api/admin/users", { user: admin });
    expect(list.status).toBe(200);
    expect(Object.keys(list.json).sort()).toEqual(["nextCursor", "users"]);
    for (const user of list.json.users) expect(Object.keys(user).sort()).toEqual(USER_FIELDS);
    noSecrets(list.text);

    const approve = await call(e, "POST", `/api/admin/users/${target}/approve`, { user: admin });
    expect(approve.status).toBe(200);
    expect(approve.json.user.status).toBe("active");
    expect(Object.keys(approve.json.user).sort()).toEqual(USER_FIELDS);
    noSecrets(approve.text);
    const role = await call(e, "PATCH", `/api/admin/users/${target}/role`, { user: admin, body: { role: "admin" } });
    expect(role.status).toBe(200);
    expect(role.json.user.role).toBe("admin");
    noSecrets(role.text);
    const limits = await call(e, "PATCH", `/api/admin/users/${target}`, { user: admin, body: { maxKeys: 4 } });
    expect(limits.status).toBe(200);
    expect(limits.json.user.maxKeys).toBe(4);
    expect(Object.keys(limits.json.user).sort()).toEqual(["id", "maxKeys", "monthlyLimitUsd"]);
    noSecrets(limits.text);

    const deleted = await call(e, "DELETE", `/api/admin/users/${target}`, { user: admin });
    expect([deleted.status, deleted.json]).toEqual([200, { deleted: true, sync: "none" }]);
    noSecrets(deleted.text);
    const [row] = await e.h.db.select().from(e.h.schema.user).where(eq(e.h.schema.user.id, target));
    expect(row.status).toBe("deleted");
    expect(await e.h.db.select().from(e.h.schema.account).where(eq(e.h.schema.account.userId, target))).toEqual([]);
    expect(e.om.calls).toEqual([]);
  });

  it("정식 삭제를 포함한 관리자 변경은 기존 Origin 보호 안에 있고 잘못된 출처는 외부 호출·행 변경 없이 거부한다", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    const target = await addUser(e.h);
    const before = await e.h.db.select().from(e.h.schema.user);
    for (const origin of ["https://evil.example", null]) {
      for (const [method, path, body] of [
        ["DELETE", `/api/admin/users/${target}`, undefined],
        ["POST", `/api/admin/users/${target}/suspend`, undefined],
        ["PATCH", `/api/admin/users/${target}/role`, { role: "admin" }],
        ["PATCH", `/api/admin/users/${target}`, { maxKeys: 4 }],
      ] as const) {
        const r = await call(e, method, path, { user: admin, origin, body });
        expect([r.status, r.json]).toEqual([403, { error: "forbidden_origin" }]);
      }
    }
    expect(await e.h.db.select().from(e.h.schema.user)).toEqual(before);
    expect(e.om.calls).toEqual([]);
  });

  it("exact DELETE /api/me 는 Origin 을 proof 보다 먼저 검사하며 기존 /api/me/keys 를 가로채지 않는다", async () => {
    const user = await addUser(e.h);
    const key = await seedKey(e, user);
    for (const origin of ["https://evil.example", "null", null]) {
      const r = await call(e, "DELETE", "/api/me", { user, origin, body: { password: "submitted-password" } });
      expect([r.status, r.json]).toEqual([403, { error: "forbidden_origin" }]);
    }
    expect(proof).not.toHaveBeenCalled();
    expect(await e.h.db.select().from(e.h.schema.rateLimit)).toEqual([]);
    const list = await call(e, "GET", "/api/me/keys", { user });
    expect(list.status).toBe(200);
    expect(Object.keys(list.json.keys[0]).sort()).toEqual(["createdAt", "disabledReason", "id", "label", "preview", "state", "syncState"]);
    noSecrets(list.text);
    expect((await call(e, "PATCH", `/api/me/keys/${key.id}`, { user, body: { label: "기존 경로" } })).status).toBe(200);
    // 같은 출처는 자기 탈퇴 handler 에 도달한다. null proof 의 거부 응답만 검사하며 실제 AUTH 증거로 취급하지 않는다.
    const same = await call(e, "DELETE", "/api/me", { user, body: { password: "submitted-password" } });
    expect([same.status, same.json]).toEqual([403, { error: "forbidden" }]);
    expect(proof).toHaveBeenCalledTimes(1);
    expect(proof).toHaveBeenCalledWith({ userId: user, sessionId: user, password: "submitted-password" });
    noSecrets(same.text);
    expect(same.text).not.toContain("submitted-password");
    expect((await call(e, "DELETE", "/api/me/unregistered", { user })).status).toBe(404);
    expect((await call(e, "GET", "/api/me", { user })).status).toBe(404);
    expect(proof).toHaveBeenCalledTimes(1);
    expect(e.om.calls).toEqual([]);
  });

  it("exact 자기 탈퇴의 합성 proof 성공도 응답에 hash·지문·비밀번호를 내보내지 않는다 (실제 AUTH 검증 아님)", async () => {
    const user = await addUser(e.h);
    await sessionFor(user);
    const accountId = randomUUID();
    await e.h.db.insert(e.h.schema.account).values({ id: accountId, accountId: user, providerId: "credential", userId: user, password: PASSWORD_HASH, createdAt: new Date(), updatedAt: new Date() });
    const fingerprint = "a".repeat(64);
    proof.mockResolvedValue({ authVersion: 0, accountId, passwordHash: PASSWORD_HASH, observedSessionFingerprint: null, currentCredentialFingerprint: fingerprint });
    const r = await call(e, "DELETE", "/api/me", { user, body: { password: "submitted-password" } });
    expect([r.status, r.json]).toEqual([200, { deleted: true, sync: "none" }]);
    noSecrets(r.text);
    expect(r.text).not.toContain(accountId);
    expect(r.text).not.toContain(fingerprint);
    expect(r.text).not.toContain("submitted-password");
    const [row] = await e.h.db.select().from(e.h.schema.user).where(eq(e.h.schema.user.id, user));
    expect(row.status).toBe("deleted");
    expect(await e.h.db.select().from(e.h.schema.session).where(eq(e.h.schema.session.userId, user))).toEqual([]);
    expect(proof).toHaveBeenCalledTimes(1);
    expect(e.om.calls).toEqual([]);
  });

  it("새 변경 경로도 잘못된 JSON 은 400, API_BODY_LIMIT 초과는 기존 413 이며 proof 를 호출하지 않는다", async () => {
    const user = await addUser(e.h);
    const admin = await addUser(e.h, { role: "admin" });
    const malformed = await call(e, "DELETE", "/api/me", { user, raw: "{" });
    expect([malformed.status, malformed.json]).toEqual([400, { error: "invalid_body" }]);
    const wrongFields = await call(e, "DELETE", "/api/me", { user, body: { password: "submitted-password", role: "admin" } });
    expect([wrongFields.status, wrongFields.json]).toEqual([400, { error: "invalid_body" }]);
    for (const [method, path] of [["DELETE", "/api/me"], ["PATCH", `/api/admin/users/${user}/role`], ["POST", "/api/setup"]]) {
      const r = await call(e, method, path, { user: admin, raw: JSON.stringify({ password: "x".repeat(API_BODY_LIMIT) }) });
      expect([r.status, r.json]).toEqual([413, { error: "payload_too_large" }]);
      noSecrets(r.text);
    }
    expect(proof).not.toHaveBeenCalled();
    expect(e.om.calls).toEqual([]);
  });
});
