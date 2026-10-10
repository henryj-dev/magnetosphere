// K4.T3 관리자 한도·최대 개수 API (계획서 v5.7 5.2·5.3).
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUser, call, openRoutes, seedKey, type RouteEnv } from "./env.ts";

let e: RouteEnv;
beforeEach(async () => {
  e = await openRoutes();
});
afterEach(async () => {
  await e.close();
});

const audit = async () => (await e.h.db.select().from(e.h.schema.auditLog)).filter((a: { action: string }) => a.action === "limits.update");
const userRow = async (id: string) => {
  const u = e.h.schema.user;
  const [r] = await e.h.db.select({ monthlyLimitUsd: u.monthlyLimitUsd, maxKeys: u.maxKeys }).from(u).where(eq(u.id, id));
  return { monthlyLimitUsd: r.monthlyLimitUsd == null ? null : Number(r.monthlyLimitUsd), maxKeys: r.maxKeys ?? null };
};

describe("TC-K4.T3.a 관리자만 바꾸고, 바꾸면 즉시 분배한다", () => {
  it("회원 세션 → 403, 세션 없음 → 401, 관리자 → 200 + rebalanceMember 1회 + audit_log(limits.update) 1행, null 로 바꾸면 clearBudget", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    const member = await addUser(e.h, { limitUsd: 5 });
    const k = await seedKey(e, member, { budgetUsd: 5 });
    const path = `/api/admin/users/${member}`;
    expect((await call(e, "PATCH", path, { user: member, body: { monthlyLimitUsd: 100 } })).status, "회원 자기 한도").toBe(403);
    expect((await call(e, "PATCH", path, { body: { monthlyLimitUsd: 100 } })).status, "세션 없음").toBe(401);
    // 정지된 관리자도 바꾸지 못한다 (역할·상태는 DB 에서 읽는다)
    const suspendedAdmin = await addUser(e.h, { role: "admin", status: "suspended" });
    expect((await call(e, "PATCH", path, { user: suspendedAdmin, body: { monthlyLimitUsd: 100 } })).status).toBe(403);
    expect(await userRow(member)).toEqual({ monthlyLimitUsd: 5, maxKeys: null });
    expect(e.om.calls).toEqual([]);
    expect(await audit()).toEqual([]);

    const r = await call(e, "PATCH", path, { user: admin, body: { monthlyLimitUsd: 2, maxKeys: 3 }, ip: "198.51.100.7" });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ user: { id: member, monthlyLimitUsd: 2, maxKeys: 3 }, rebalanced: true });
    expect(await userRow(member)).toEqual({ monthlyLimitUsd: 2, maxKeys: 3 });
    // 즉시 분배: 그 회원 키로 분석 한 번, 내린 한도로 예산을 다시 건다
    expect(e.om.of("getAnalytics")).toHaveLength(1);
    expect(e.om.of("getAnalytics")[0].apiKeyIds).toEqual([k.ork]);
    expect(e.om.of("setBudget")).toEqual([{ fn: "setBudget", id: k.ork, value: 2 }]);
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: admin, target: member, ip: "198.51.100.7" });
    expect(JSON.parse(rows[0].detail)).toEqual({ before: { monthlyLimitUsd: 5, maxKeys: null }, after: { monthlyLimitUsd: 2, maxKeys: 3 } });
    // 무제한(null)으로 바꾸면 즉시 분배가 건 예산을 푼다 (clearBudget)
    const r2 = await call(e, "PATCH", path, { user: admin, body: { monthlyLimitUsd: null } });
    expect(r2.json).toEqual({ user: { id: member, monthlyLimitUsd: null, maxKeys: 3 }, rebalanced: true });
    expect(e.om.of("clearBudget")).toEqual([{ fn: "clearBudget", id: k.ork }]);
    expect(e.om.keys.get(k.ork)?.budget).toBeNull();
    expect(await audit()).toHaveLength(2);
  });
});

describe("TC-K4.T3.b 잘못된 값은 400 이다", () => {
  it("-1 · NaN · \"5\" · 1e13 · 0.0000001 · maxKeys 1.5 · maxKeys -1 → 각각 400, DB 변화 0 (대조: 999999.999999·null 은 200)", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    const member = await addUser(e.h, { limitUsd: 5 });
    const path = `/api/admin/users/${member}`;
    const bad: { body?: unknown; raw?: string; name: string }[] = [
      { name: "-1", body: { monthlyLimitUsd: -1 } },
      { name: "NaN", raw: '{"monthlyLimitUsd": NaN}' },
      { name: '"5"', body: { monthlyLimitUsd: "5" } },
      { name: "1e13", body: { monthlyLimitUsd: 1e13 } },
      { name: "0.0000001", body: { monthlyLimitUsd: 0.0000001 } },
      { name: "maxKeys 1.5", body: { maxKeys: 1.5 } },
      { name: "maxKeys -1", body: { maxKeys: -1 } },
      { name: "빈 본문", body: {} },
      { name: "모르는 필드", body: { role: "admin" } },
    ];
    for (const b of bad) {
      const r = await call(e, "PATCH", path, { user: admin, body: b.body, raw: b.raw });
      expect([b.name, r.status]).toEqual([b.name, 400]);
    }
    expect(await userRow(member)).toEqual({ monthlyLimitUsd: 5, maxKeys: null });
    expect(await audit()).toEqual([]);
    expect(e.om.calls).toEqual([]);
    // 대조: 범위 끝 값과 무제한(null)은 받는다
    expect((await call(e, "PATCH", path, { user: admin, body: { monthlyLimitUsd: 999999.999999 } })).status).toBe(200);
    expect((await userRow(member)).monthlyLimitUsd).toBe(999999.999999);
    expect((await call(e, "PATCH", path, { user: admin, body: { monthlyLimitUsd: null, maxKeys: 0 } })).status).toBe(200);
    expect(await userRow(member)).toEqual({ monthlyLimitUsd: null, maxKeys: 0 });
    expect((await call(e, "PATCH", "/api/admin/users/no-such-user", { user: admin, body: { maxKeys: 1 } })).status).toBe(404);
  });
});
