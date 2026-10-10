// K3.T3 탈퇴 회원 키 (V18, pnpm test:db, 네 DB). 회원 status 를 DB 에서 deleted 로 바꾸면 정합성 점검이 끄고 2분 뒤 지운다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { reconcile } from "../../src/keys/reconcile.ts";
import { omnirouteHandlers } from "../../src/queue/handlers.ts";
import { KEY_DELETE_DELAY_MS, runDue } from "../../src/queue/index.ts";
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

  it(`TC-K3.T3.e ${LABEL[kind]}: 탈퇴 회원 키는 점검이 끄고 2분 뒤 삭제한다 — 행은 남고 state deleted·deleted_at`, async () => {
    const T0 = new Date("2026-10-05T00:00:00.000Z");
    const userId = randomUUID();
    const keyId = randomUUID();
    const ork = `ork-${keyId}`;
    await h.db.insert(h.schema.user).values({ id: userId, name: "left", email: `left-${userId}@example.com`, monthlyLimitUsd: 5 });
    await h.db.insert(h.schema.apiKeys).values({ id: keyId, userId, omnirouteKeyId: ork, keyPreview: "abcd", state: "active", createdAt: T0 });
    const om = fakeKeys();
    om.add(ork, { isActive: true });
    // 회원 탈퇴는 DB 에서만 바뀐다 (탈퇴 API 는 3단계)
    await h.db.update(h.schema.user).set({ status: "deleted" }).where(eq(h.schema.user.id, userId));

    await reconcile({ db: h, client: () => om.client(), now: T0 });
    expect(om.seq()).toEqual(["listKeys", "setKeyActive(false)"]);
    const j = h.schema.omnirouteJobs;
    const jobs = (await h.db.select().from(j).where(eq(j.keyId, keyId))).filter((r: { action: string }) => r.action === "key.delete");
    expect(jobs.map((r: { nextRunAt: Date }) => r.nextRunAt.getTime() - T0.getTime())).toEqual([KEY_DELETE_DELAY_MS]);
    // 5분 점검이 그 사이 또 돌아도 다시 부르거나 작업을 겹쳐 넣지 않는다 (이미 꺼졌고 key.delete 가 기다린다)
    await reconcile({ db: h, client: () => om.client(), now: new Date(T0.getTime() + 60_000) });
    expect(om.of("setKeyActive")).toHaveLength(1);

    await runDue(h, omnirouteHandlers(() => om.client()), new Date(T0.getTime() + KEY_DELETE_DELAY_MS));
    expect(om.of("deleteKey")).toEqual([{ fn: "deleteKey", id: ork }]);
    const [row] = await h.db.select().from(h.schema.apiKeys).where(eq(h.schema.apiKeys.id, keyId));
    expect(row.state).toBe("deleted");
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.deletedAt.getTime()).toBe(T0.getTime());
  });
});
