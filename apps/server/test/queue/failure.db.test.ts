// K1 리뷰 #4: 재시도를 다 쓴 작업의 실패 표시(failed_at)·키 sync_state·알림(audit_log)은 함께 남거나 함께 되돌려진다.
// 정한 쪽: 함께 되돌린다. 알림 없는 failed 는 아무도 모르는 실패라 Q3 의 목적(드러내기)을 깬다. 되돌린 작업은 차지 시각
// (CLAIM_MS) 뒤 다시 집혀 실패 처리 전체를 다시 한다. 한 작업의 실패 처리 예외는 같은 tick 의 다른 작업을 막지 않는다.
// pnpm test:db, 네 DB. audit_log 이름을 잠시 바꿔 삽입을 실패시킨다.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { ACTIONS, CLAIM_MS, enqueue, RETRY_DELAYS_MS, runDue, type Handler, type Handlers } from "../../src/queue/index.ts";

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
  const exec = (q: ReturnType<typeof sql>) => (h.provider === "sqlite" ? h.db.run(q) : h.db.execute(q));

  it(`TC-K1.T3.g ${LABEL[kind]}: audit 삽입 실패 → failed_at·sync_state 함께 되돌림, 같은 tick 다음 작업은 돈다, 나중에 다시 실패 처리`, async () => {
    const userId = randomUUID();
    const keyId = randomUUID();
    await h.db.insert(h.schema.user).values({ id: userId, name: "fail", email: `fail-${userId}@example.com` });
    await h.db.insert(h.schema.apiKeys).values({ id: keyId, userId, omnirouteKeyId: `ork-${keyId}`, keyPreview: "abcd", state: "disabled", syncState: "pending", createdAt: new Date() });
    const T0 = new Date("2026-10-01T00:00:00.000Z");
    const j = h.schema.omnirouteJobs;
    // 마지막 시도만 남은 작업 (앞 네 번 실패) 하나와, 그 뒤 차례인 다른 작업 하나
    const last = await enqueue(h, "key.apply_state", { keyId }, { now: T0 });
    await h.db.update(j).set({ attempts: RETRY_DELAYS_MS.length }).where(eq(j.id, last));
    const next = await enqueue(h, "budget.set", { omnirouteKeyId: "k", monthlyUsd: 1 }, { runAt: new Date(T0.getTime() + 1) });
    const calls: string[] = [];
    const failing: Handler = async (_p, { job }) => {
      calls.push(job.id);
      throw new Error("OmniRoute 가 응답하지 않는다");
    };
    const handlers = Object.fromEntries(ACTIONS.map((a) => [a, failing])) as Handlers;
    const row = async (id: string) => (await h.db.select().from(j).where(eq(j.id, id)))[0];
    const sync = async () => (await h.db.select({ s: h.schema.apiKeys.syncState }).from(h.schema.apiKeys).where(eq(h.schema.apiKeys.id, keyId)))[0].s;

    await exec(sql.raw("ALTER TABLE audit_log RENAME TO audit_log_off"));
    try {
      await runDue(h, handlers, new Date(T0.getTime() + 1));
    } finally {
      await exec(sql.raw("ALTER TABLE audit_log_off RENAME TO audit_log"));
    }
    expect(calls, "같은 tick 의 다음 작업도 돌았다").toEqual([last, next]);
    expect((await row(last)).failedAt, "알림을 못 쓰면 failed_at 도 남지 않는다").toBeNull();
    expect(await sync()).toBe("pending");
    expect((await row(next)).attempts).toBe(1);

    // 알림 저장이 돌아온 뒤 차지 시각이 지나면 다시 집혀 실패 처리가 함께 남는다
    await runDue(h, handlers, new Date(T0.getTime() + 1 + CLAIM_MS));
    expect((await row(last)).failedAt).toBeInstanceOf(Date);
    expect(await sync()).toBe("failed");
    const alerts = await h.db.select().from(h.schema.auditLog).where(eq(h.schema.auditLog.action, "alert.job_failed"));
    expect(alerts.map((a: { target: string }) => a.target)).toEqual([last]);
  });
});
