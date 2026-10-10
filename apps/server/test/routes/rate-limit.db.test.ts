// K4.T4 키 발급·재발급 요청 수 제한 (pnpm test:db). 인스턴스 둘이 같은 DB 의 rate_limit 으로 함께 센다 (계획서 v5.6 Q4).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { ISSUE_LIMITS } from "../../src/routes/guard.ts";
import { addUser, call, openRoutes, type RouteEnv } from "./env.ts";

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let a: DbHandle;
  let b: DbHandle;
  let ea: RouteEnv;
  let eb: RouteEnv;
  beforeAll(async () => {
    t = await createTestDb(kind);
    [a, b] = [await connectNode(t.url), await connectNode(t.url)];
    [ea, eb] = [await openRoutes({ h: a }), await openRoutes({ h: b })];
  });
  afterAll(async () => {
    await ea?.close();
    await eb?.close();
    await Promise.all([a?.close(), b?.close()]);
    await t?.drop();
  });

  it(`TC-K4.T4.b ${LABEL[kind]}: 같은 회원 발급·재발급 11번째 429·OmniRoute 0 (인스턴스 둘), 같은 IP 회원 넷 합쳐 31번째 429`, async () => {
    expect(ISSUE_LIMITS).toEqual({ member: { max: 10, windowMs: 3_600_000 }, ip: { max: 30, windowMs: 3_600_000 } });
    const ip = "198.51.100.20";
    const creates = () => ea.om.of("createKey").length + eb.om.of("createKey").length;
    const m1 = await addUser(a, { maxKeys: 50 });
    let first: string | null = null;
    for (let i = 0; i < 10; i++) {
      const e = i % 2 ? eb : ea;
      // 발급과 재발급을 섞는다 (재발급도 같은 칸을 쓴다)
      const r: Awaited<ReturnType<typeof call>> = i === 5 && first ? await call(e, "POST", `/api/me/keys/${first}/regenerate`, { user: m1, ip }) : await call(e, "POST", "/api/me/keys", { user: m1, body: {}, ip });
      expect([i, r.status], r.text).toEqual([i, 201]);
      first ??= r.json.key.id;
    }
    const before = creates();
    const r11 = await call(eb, "POST", "/api/me/keys", { user: m1, body: {}, ip });
    expect([r11.status, r11.json?.error]).toEqual([429, "too_many_requests"]);
    expect(creates(), "429 는 OmniRoute 를 부르지 않는다").toBe(before);
    // 다른 회원은 막히지 않는다 (대조: 회원 칸)
    const m2 = await addUser(a, { maxKeys: 50 });
    const m3 = await addUser(a, { maxKeys: 50 });
    for (const [m, n] of [[m2, 10], [m3, 10]] as const) {
      for (let i = 0; i < n; i++) expect((await call(i % 2 ? eb : ea, "POST", "/api/me/keys", { user: m, body: {}, ip })).status).toBe(201);
    }
    // 같은 IP 로 31번째 (m1 의 10 + m2 의 10 + m3 의 10 다음)
    const m4 = await addUser(a, { maxKeys: 50 });
    const at = creates();
    const r31 = await call(ea, "POST", "/api/me/keys", { user: m4, body: {}, ip });
    expect([r31.status, r31.json?.error]).toEqual([429, "too_many_requests"]);
    expect(creates()).toBe(at);
    // 다른 IP 의 그 회원은 된다 (대조: IP 칸)
    expect((await call(eb, "POST", "/api/me/keys", { user: m4, body: {}, ip: "198.51.100.21" })).status).toBe(201);
  });
});
