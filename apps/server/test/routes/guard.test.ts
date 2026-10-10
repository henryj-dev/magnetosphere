// K4.T4 변경 API 의 CSRF (계획서 7장 "회원 앱 변경 API 는 CSRF 보호").
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as guard from "../../src/routes/guard.ts";
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

describe("TC-K4.T4.c 키 변경 요청은 회원당 분당 30회까지다 (K4 보안 리뷰 L3)", () => {
  it("이름 변경 30번 → 200, 31번째 disable → 429·OmniRoute 0, enable·regenerate·DELETE 도 429. 다른 회원은 그대로", async () => {
    expect((guard as any).CHANGE_LIMITS).toEqual({ member: { max: 30, windowMs: 60_000 } });
    const u = await addUser(e.h);
    const k = await seedKey(e, u);
    for (let i = 0; i < 30; i++) expect((await call(e, "PATCH", `/api/me/keys/${k.id}`, { user: u, body: { label: `n${i}` } })).status, `#${i}`).toBe(200);
    for (const [method, path] of [["POST", `/api/me/keys/${k.id}/disable`], ["POST", `/api/me/keys/${k.id}/enable`], ["POST", `/api/me/keys/${k.id}/regenerate`], ["DELETE", `/api/me/keys/${k.id}`], ["PATCH", `/api/me/keys/${k.id}`]]) {
      const r = await call(e, method, path, { user: u, body: method === "PATCH" ? { label: "x" } : undefined });
      expect([method, path, r.status, r.json?.error]).toEqual([method, path, 429, "too_many_requests"]);
    }
    expect(e.om.calls).toEqual([]);
    const v = await addUser(e.h);
    const vk = await seedKey(e, v);
    expect((await call(e, "POST", `/api/me/keys/${vk.id}/disable`, { user: v })).status).toBe(200);
  });
});

describe("TC-K4.T4.d 발급 요청 수 제한의 IP 칸은 IPv6 를 /64 로 묶는다 (K4 보안 리뷰 L4)", () => {
  it("같은 /64 의 다른 주소는 같은 칸, 다른 /64·IPv4 는 다른 칸. ::ffff:IPv4 는 IPv4 와 같은 칸. 같은 /64 에서 회원 넷 합쳐 31번째 429", async () => {
    const b = (guard as any).ipBucket as (ip: string | null) => string;
    expect(b("2001:db8:1:2::1")).toBe(b("2001:0db8:0001:0002:ffff:1:2:3"));
    expect(b("2001:db8:1:2::1")).toBe(b("2001:DB8:1:2:aaaa:bbbb:cccc:dddd"));
    expect(b("2001:db8:1:2::1")).not.toBe(b("2001:db8:1:3::1"));
    expect(b("::ffff:203.0.113.5")).toBe(b("203.0.113.5"));
    expect(b("203.0.113.5")).not.toBe(b("203.0.113.6"));
    expect(b(null)).toBe(b(null));
    let n = 0;
    for (let m = 0; m < 3; m++) {
      const u = await addUser(e.h, { maxKeys: 50 });
      for (let i = 0; i < 10; i++) expect((await call(e, "POST", "/api/me/keys", { user: u, body: {}, ip: `2001:db8:1:2:${(n++).toString(16)}::1` })).status).toBe(201);
    }
    const last = await addUser(e.h, { maxKeys: 50 });
    const r = await call(e, "POST", "/api/me/keys", { user: last, body: {}, ip: "2001:db8:1:2:ffff:ffff:ffff:fffe" });
    expect([r.status, r.json?.error]).toEqual([429, "too_many_requests"]);
    expect((await call(e, "POST", "/api/me/keys", { user: last, body: {}, ip: "2001:db8:1:3::1" })).status, "다른 /64").toBe(201);
  });
});
