// TC-M4.T5 전체 createApp 의 설치 루트·관리자 보호. 가짜 auth fixture 이며 실제 SDK 쿠키 검증은 별도 범위다.
// DB 는 beforeEach 에서만 연다. OmniRoute 설치 어댑터는 mock 으로 고정해 운영 주소나 소켓을 호출하지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type Services } from "../../src/app.ts";
import { ensureSetupToken } from "../../src/setup/index.ts";
import * as omniSetup from "../../src/setup/omniroute.ts";
import { ADMIN } from "../helpers.ts";
import { addUser, call, fakeAuth, fakeMfa, openRoutes, ORIGIN, type RouteEnv } from "../routes/env.ts";

let e: RouteEnv;
let s: Services;
beforeEach(async () => {
  e = await openRoutes();
  vi.spyOn(omniSetup, "bootstrapOmniRoute").mockResolvedValue({ status: "manual_required", reason: "시험 어댑터" });
  vi.spyOn(omniSetup, "omniRouteStatus").mockResolvedValue("connected");
  vi.spyOn(omniSetup, "saveManualToken").mockResolvedValue({ ok: true });
  s = {
    db: e.h, auth: fakeAuth(), cipher: {} as Services["cipher"], mfa: await fakeMfa(e.h),
    omniroute: { baseUrl: null, initialPassword: null }, appOrigin: ORIGIN,
  };
  e.app = createApp({ services: async () => s, assets: async (c) => c.text("spa"), setupTokenFromSecret: false, log: (line) => e.logs.push(line) });
});
afterEach(async () => { vi.restoreAllMocks(); await e?.close(); });

const expectNoOmni = () => {
  expect(omniSetup.bootstrapOmniRoute).not.toHaveBeenCalled();
  expect(omniSetup.omniRouteStatus).not.toHaveBeenCalled();
  expect(omniSetup.saveManualToken).not.toHaveBeenCalled();
};

describe("TC-M4.T5.a 활성 관리자·설치 Origin", () => {
  it("정지 관리자 가짜 세션은 GET·PUT 설치 관리 경로에서 forbidden 403 이고 설치 어댑터 호출이 없다", async () => {
    const admin = await addUser(e.h, { role: "admin", status: "suspended" });
    for (const method of ["GET", "PUT"]) {
      const r = await call(e, method, "/api/setup/omniroute", { user: admin, body: method === "PUT" ? { token: "oma_live_test" } : undefined });
      expect([r.status, r.json]).toEqual([403, { error: "forbidden" }]);
    }
    expectNoOmni();
  });

  it("최초 설치는 세션·토큰 없이도 교차 Origin·Origin 누락을 먼저 403 으로 거부한다", async () => {
    for (const origin of ["https://evil.example", "http://localhost:3001", "null", null]) {
      for (const [method, path, body] of [
        ["POST", "/api/setup", { token: "wrong", ...ADMIN }],
        ["PUT", "/api/setup/omniroute", { token: "oma_live_test" }],
      ] as const) {
        const r = await call(e, method, path, { origin, body });
        expect([r.status, r.json]).toEqual([403, { error: "forbidden_origin" }]);
      }
    }
    expect(await e.h.db.select().from(e.h.schema.rateLimit)).toEqual([]);
    expect(await e.h.db.select().from(e.h.schema.user)).toEqual([]);
    expectNoOmni();
  });

  it("활성 관리자와 정확한 Origin 은 GET·PUT 관리 경로를 허용하고 응답에 토큰이 없다", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    for (const origin of ["https://evil.example", null]) {
      const denied = await call(e, "PUT", "/api/setup/omniroute", { user: admin, origin, body: { token: "oma_live_test" } });
      expect([denied.status, denied.json]).toEqual([403, { error: "forbidden_origin" }]);
    }
    expect(omniSetup.saveManualToken).not.toHaveBeenCalled();
    const get = await call(e, "GET", "/api/setup/omniroute", { user: admin });
    expect([get.status, get.json]).toEqual([200, { omniroute: "connected" }]);
    const token = "oma_live_private_setup_token";
    const put = await call(e, "PUT", "/api/setup/omniroute", { user: admin, body: { token } });
    expect([put.status, put.json]).toEqual([200, { omniroute: "connected" }]);
    expect(omniSetup.saveManualToken).toHaveBeenCalledWith(s.db, s.cipher, s.omniroute, token, admin);
    expect(put.text).not.toContain(token);
  });

  it("appOrigin 설정이 없으면 exact 설치 루트도 fail-closed 이다", async () => {
    s.appOrigin = undefined;
    const r = await call(e, "POST", "/api/setup", { body: { token: "wrong", ...ADMIN } });
    expect([r.status, r.json]).toEqual([403, { error: "forbidden_origin" }]);
    expectNoOmni();
  });
});

describe("TC-M4.T5.b 설치 완료 판정은 관리자 상태와 무관하다", () => {
  it("정지 관리자만 남아도 needed false 이고 같은 Origin 의 재설치는 409 다", async () => {
    await addUser(e.h, { role: "admin", status: "suspended" });
    const get = await call(e, "GET", "/api/setup", { origin: null });
    expect([get.status, get.json]).toEqual([200, { needed: false }]);
    const post = await call(e, "POST", "/api/setup", { body: { token: "wrong", ...ADMIN } });
    expect([post.status, post.json]).toEqual([409, { error: "already_set_up" }]);
    expect(await e.h.db.select().from(e.h.schema.user)).toHaveLength(1);
    expectNoOmni();
  });

  it("정확한 Origin 의 최초 POST /api/setup 은 세션 없이 설치되며 교차 Origin 이 토큰을 소비하지 않는다", async () => {
    const token = "m4-setup-origin-test-token-32-characters";
    await ensureSetupToken(e.h, { rotate: false, fixedToken: token, log: () => {} });
    expect((await call(e, "GET", "/api/setup")).json).toEqual({ needed: true });
    const rejected = await call(e, "POST", "/api/setup", { origin: "https://evil.example", body: { token, ...ADMIN } });
    expect([rejected.status, rejected.json]).toEqual([403, { error: "forbidden_origin" }]);
    const accepted = await call(e, "POST", "/api/setup", { body: { token, ...ADMIN } });
    // 설치 응답은 bootstrap grant 를 한 번 싣는다 (A1)
    expect([accepted.status, accepted.json]).toEqual([201, { ok: true, omniroute: "manual_required", mfaGrant: { grant: expect.any(String), expiresAt: expect.any(String) } }]);
    expect(omniSetup.bootstrapOmniRoute).toHaveBeenCalledTimes(1);
    expect((await call(e, "GET", "/api/setup")).json).toEqual({ needed: false });
    expect(accepted.text).not.toContain(token);
    expect(accepted.text).not.toContain(ADMIN.password);
  });
});
