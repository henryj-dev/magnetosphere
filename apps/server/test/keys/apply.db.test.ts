// K3.T2 반영의 키 state 맞추기 (pnpm test:db, 네 DB). 회원 상태로 user_status 를 적고 지우지만, 관리자·회원이 끈 이유는 건드리지 않는다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { applyKey } from "../../src/keys/apply.ts";
import { fakeKeys } from "./fake.ts";

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let h: DbHandle;
  beforeAll(async () => {
    t = await createTestDb(kind);
    h = await connectNode(t.url);
  });
  afterAll(async () => {
    await h?.close();
    await t?.drop();
  });

  it(`TC-K3.T2.g ${LABEL[kind]}: 정지·해제를 반영해도 admin 으로 꺼진 키의 이유는 그대로다 (대조: 켜진 키는 user_status 로 갔다 돌아온다)`, async () => {
    const T0 = new Date("2026-10-06T00:00:00.000Z");
    const userId = randomUUID();
    await h.db.insert(h.schema.user).values({ id: userId, name: "n", email: `n-${userId}@example.com`, status: "suspended" });
    const admin = randomUUID();
    const plain = randomUUID();
    await h.db.insert(h.schema.apiKeys).values([
      { id: admin, userId, omnirouteKeyId: `ork-${admin}`, keyPreview: "abcd", state: "disabled", disabledReason: "admin", createdAt: T0 },
      { id: plain, userId, omnirouteKeyId: `ork-${plain}`, keyPreview: "abcd", state: "active", createdAt: T0 },
    ]);
    const om = fakeKeys();
    const row = async (id: string) => {
      const [r] = await h.db.select().from(h.schema.apiKeys).where(eq(h.schema.apiKeys.id, id));
      return [r.state, r.disabledReason ?? null];
    };
    for (const id of [admin, plain]) await applyKey(h, id, { client: () => om.client(), now: T0 });
    expect([await row(admin), await row(plain)]).toEqual([["disabled", "admin"], ["disabled", "user_status"]]);
    await h.db.update(h.schema.user).set({ status: "active" }).where(eq(h.schema.user.id, userId));
    for (const id of [admin, plain]) await applyKey(h, id, { client: () => om.client(), now: T0 });
    expect([await row(admin), await row(plain)]).toEqual([["disabled", "admin"], ["active", null]]);
    expect(om.of("setKeyActive").filter((c) => c.id === `ork-${admin}`).map((c) => c.value)).toEqual([false, false]);
  });
});
