// K1 재검토: 임대를 잃어 끊긴 시도는 attempts 로 세지 않지만 interrupts 로 따로 센다. 상한(MAX_INTERRUPTS)을 넘으면 failed.
// 차지 풀기 쓰기(next_run_at = 차지 시각 비교)가 MySQL·MariaDB·Postgres 에서도 맞는지 본다 (pnpm test:db, 네 DB).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLease, LeaseLostError } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { ACTIONS, enqueue, runDue, type Handler, type Handlers } from "../../src/queue/index.ts";

const MAX = 5;

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

  it(`TC-K1.T3.m ${LABEL[kind]}: 매번 임대를 잃는 작업 → 끊길 때마다 attempts·next_run_at 그대로·interrupts + 1, ${MAX}번 끊긴 뒤 다음 차지는 핸들러 없이 failed·alert`, async () => {
    const T0 = new Date("2026-10-05T00:00:00.000Z");
    const id = await enqueue(h, "budget.set", { omnirouteKeyId: "k", monthlyUsd: 1 }, { now: T0 });
    const j = h.schema.omnirouteJobs;
    const row = async () => (await h.db.select().from(j).where(eq(j.id, id)))[0];
    let calls = 0;
    for (let i = 1; i <= MAX + 1; i++) {
      const at = new Date(T0.getTime() + i * 600_000);
      const lease = (await acquireLease(h, "omniroute_jobs", `runner-${i}`, 55_000, at))!;
      const ac = new AbortController();
      const stealing: Handler = async (_p, { signal }) => {
        calls++;
        // 다른 실행기가 만료된 임대를 가져가고, 이 실행기의 하트비트가 실패해 신호가 끊긴다
        await acquireLease(h, "omniroute_jobs", `thief-${i}`, 55_000, new Date(at.getTime() + 60_000));
        ac.abort(new LeaseLostError(lease));
        signal?.throwIfAborted();
      };
      const handlers = Object.fromEntries(ACTIONS.map((a) => [a, stealing])) as Handlers;
      await runDue(h, handlers, at, { lease, signal: ac.signal });
      const r = await row();
      if (i <= MAX) {
        expect({ attempts: r.attempts, nextRunAt: r.nextRunAt.getTime(), interrupts: r.interrupts, failedAt: r.failedAt }, `${i}번째 끊김`).toEqual({
          attempts: 0,
          nextRunAt: T0.getTime(),
          interrupts: i,
          failedAt: null,
        });
      } else {
        expect(calls, "상한을 넘은 작업은 핸들러를 부르지 않는다").toBe(MAX);
        expect(r.failedAt).toBeInstanceOf(Date);
        expect(r.lastError).toBe("임대를 5번 잃음");
        const alerts = await h.db.select().from(h.schema.auditLog).where(eq(h.schema.auditLog.target, id));
        expect(alerts.map((a: { action: string }) => a.action)).toEqual(["alert.job_failed"]);
      }
    }
  });
});
