// K4.T1 동시 발급 (pnpm test:db, 네 DB). 인스턴스 둘(연결 풀 둘)이 같은 DB 에서 같은 회원의 발급 10건을 동시에 받는다.
// D1 은 test/routes/issue.workers.test.ts 가 같은 시나리오를 wrangler dev 로 돈다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { addUser, call, keysOf, openRoutes, type RouteEnv } from "./env.ts";

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

  it(`TC-K4.T1.f ${LABEL[kind]}: 최대 2, 동시 POST 10건 → 201 정확히 2, 나머지 409, OmniRoute 의 그 회원 m_ 키 == 2`, async () => {
    const u = await addUser(a, { maxKeys: 2, limitUsd: 5 });
    // 두 인스턴스의 가짜 OmniRoute 를 하나로 합친다 (같은 OmniRoute)
    eb.om.keys = ea.om.keys;
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => call(i % 2 ? eb : ea, "POST", "/api/me/keys", { user: u, body: {} })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(results.map((r) => r.json))).toEqual([201, 201, 409, 409, 409, 409, 409, 409, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.json?.error === "max_keys")).toBe(true);
    const name = new RegExp(`^m_${u.slice(0, 8)}_`);
    const live = [...ea.om.keys.values()].filter((k) => name.test(k.name));
    expect(live).toHaveLength(2);
    expect(live.every((k) => k.isActive)).toBe(true);
    const rows = (await keysOf(a, u)).filter((r: { state: string }) => r.state !== "deleted");
    expect(rows).toHaveLength(2);
    // 진 쪽은 OmniRoute 에 키를 만들지 않았다
    expect(ea.om.of("createKey").length + eb.om.of("createKey").length).toBe(2);
  });
});
