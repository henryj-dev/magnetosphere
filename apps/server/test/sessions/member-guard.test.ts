// TC-M4.T3.f 공용 앱의 회원·관리자 권한 계약. 실제 SDK 쿠키 검증이 아닌 가짜 get-session 응답 시험이다.
// authoritative null 은 401, 의도적으로 반환한 비활성 회원은 DB 상태 검사로 403 이다. DB fixture 는 beforeEach 에서만 연다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Services } from "../../src/app.ts";
import { addUser, call, fakeAuth, keysOf, openRoutes, ORIGIN, seedKey, type RouteEnv } from "../routes/env.ts";

let e: RouteEnv;
let s: Services;
beforeEach(async () => {
  e = await openRoutes();
  s = {
    db: e.h, auth: fakeAuth(), cipher: {} as Services["cipher"],
    omniroute: { baseUrl: null, initialPassword: null }, appOrigin: ORIGIN,
    keysClient: async () => () => e.om.client(),
  };
  e.app = createApp({ services: async () => s, assets: async (c) => c.text("spa"), setupTokenFromSecret: false, log: (line) => e.logs.push(line) });
});
afterEach(async () => { await e?.close(); });

const deniedPaths = (id: string) => [
  ["GET", "/api/me/keys", undefined],
  ["PATCH", `/api/me/keys/${id}`, { label: "바꾸기" }],
  ["POST", "/api/me/keys", {}],
] as const;

describe("TC-M4.T3.f 현재 DB 상태에 따라 회원 route guard 를 닫는다", () => {
  it.each(["pending", "suspended", "deleted", "unknown", ""])("가짜 세션이 %s 회원을 반환해도 목록·PATCH·POST 는 403 이고 외부 호출은 없다", async (status) => {
    const user = await addUser(e.h, { status });
    const key = await seedKey(e, user);
    const before = await keysOf(e.h, user);
    for (const [method, path, body] of deniedPaths(key.id)) {
      const r = await call(e, method, path, { user, body });
      expect([r.status, r.json]).toEqual([403, { error: "member_inactive" }]);
    }
    expect(await keysOf(e.h, user)).toEqual(before);
    expect(e.om.calls).toEqual([]);
  });

  it("authoritative null·세션 없음·없는 DB 회원은 401 이며 비활성 오류로 바꾸지 않는다", async () => {
    const deleted = await addUser(e.h, { status: "deleted" });
    s.auth = { handler: async () => Response.json(null) };
    for (const [method, path, body] of deniedPaths("missing")) {
      const r = await call(e, method, path, { user: deleted, body });
      expect([r.status, r.json]).toEqual([401, { error: "unauthorized" }]);
    }
    const adminDenied = await call(e, "GET", "/api/admin/users", { user: deleted });
    expect([adminDenied.status, adminDenied.json]).toEqual([401, { error: "unauthorized" }]);
    s.auth = fakeAuth();
    for (const user of [undefined, "missing-member"]) {
      const r = await call(e, "GET", "/api/me/keys", { user });
      expect([r.status, r.json]).toEqual([401, { error: "unauthorized" }]);
    }
    expect(e.om.calls).toEqual([]);
  });

  it.each(["pending", "suspended", "deleted", "unknown"])("가짜 %s 관리자 세션은 관리 API 의 기존 forbidden 403 을 유지한다", async (status) => {
    const admin = await addUser(e.h, { role: "admin", status });
    const target = await addUser(e.h, { status: "pending" });
    const before = {
      users: await e.h.db.select().from(e.h.schema.user),
      settings: await e.h.db.select().from(e.h.schema.appSettings),
      keys: await e.h.db.select().from(e.h.schema.apiKeys),
      audits: await e.h.db.select().from(e.h.schema.auditLog),
    };
    // fakeAuth는 현재 DB 상태와 무관하게 id를 반환한다. 실제 SDK 쿠키 무효화와 별개인 DB 권한 계약이다.
    for (const [method, path, body] of [
      ["GET", "/api/admin/users", undefined],
      ["PATCH", `/api/admin/users/${target}`, { maxKeys: 3 }],
      ["POST", `/api/admin/users/${target}/approve`, undefined],
      ["DELETE", `/api/admin/users/${target}`, undefined],
      ["GET", "/api/admin/settings/signup", undefined],
      ["PATCH", "/api/admin/settings/signup", { signupMode: "closed", updatedAt: { signupMode: null } }],
    ] as const) {
      const r = await call(e, method, path, { user: admin, body });
      expect([r.status, r.json]).toEqual([403, { error: "forbidden" }]);
    }
    expect({
      users: await e.h.db.select().from(e.h.schema.user),
      settings: await e.h.db.select().from(e.h.schema.appSettings),
      keys: await e.h.db.select().from(e.h.schema.apiKeys),
      audits: await e.h.db.select().from(e.h.schema.auditLog),
    }).toEqual(before);
    expect(e.om.calls).toEqual([]);
  });

  it("active 회원은 같은 목록·PATCH·POST 경로를 정상 사용하고 관리자 경로에는 403 이다", async () => {
    const user = await addUser(e.h);
    const key = await seedKey(e, user);
    expect((await call(e, "GET", "/api/me/keys", { user })).status).toBe(200);
    const renamed = await call(e, "PATCH", `/api/me/keys/${key.id}`, { user, body: { label: "새 이름" } });
    expect(renamed.status).toBe(200);
    expect(renamed.json.key.label).toBe("새 이름");
    expect(e.om.calls).toEqual([]);
    expect((await call(e, "POST", "/api/me/keys", { user, body: {} })).status).toBe(201);
    expect(e.om.of("createKey")).toHaveLength(1);
    const admin = await call(e, "GET", "/api/admin/users", { user });
    expect([admin.status, admin.json]).toEqual([403, { error: "forbidden" }]);
  });
});
