// K4.T4 변경 API 의 CSRF (계획서 7장 "회원 앱 변경 API 는 CSRF 보호").
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUser, call, keysOf, openRoutes, seedKey, type RouteEnv } from "./env.ts";

let e: RouteEnv;
beforeEach(async () => {
  e = await openRoutes();
});
afterEach(async () => {
  await e.close();
});

describe("TC-K4.T4.a 다른 출처의 변경 요청은 403 이다", () => {
  it("Origin https://evil.example 로 POST /api/me/keys · DELETE /api/me/keys/:id → 403, OmniRoute 0. Origin 없음 → 403. 같은 출처 → 정상", async () => {
    const u = await addUser(e.h);
    const admin = await addUser(e.h, { role: "admin" });
    const k = await seedKey(e, u);
    for (const origin of ["https://evil.example", "https://keys.localhost:3000", "http://localhost:3001", "null", null]) {
      const label = String(origin);
      expect((await call(e, "POST", "/api/me/keys", { user: u, body: {}, origin })).status, `POST ${label}`).toBe(403);
      expect((await call(e, "DELETE", `/api/me/keys/${k.id}`, { user: u, origin })).status, `DELETE ${label}`).toBe(403);
      expect((await call(e, "POST", `/api/me/keys/${k.id}/disable`, { user: u, origin })).status, `disable ${label}`).toBe(403);
      expect((await call(e, "PATCH", `/api/admin/users/${u}`, { user: admin, body: { maxKeys: 9 }, origin })).status, `admin ${label}`).toBe(403);
    }
    expect(e.om.calls).toEqual([]);
    expect((await keysOf(e.h, u)).map((r: { state: string }) => r.state)).toEqual(["active"]);
    // 읽기는 출처를 보지 않는다
    expect((await call(e, "GET", "/api/me/keys", { user: u, origin: "https://evil.example" })).status).toBe(200);
    // 같은 출처는 정상
    expect((await call(e, "POST", "/api/me/keys", { user: u, body: {} })).status).toBe(201);
    expect((await call(e, "DELETE", `/api/me/keys/${k.id}`, { user: u })).status).toBe(200);
  });
});
