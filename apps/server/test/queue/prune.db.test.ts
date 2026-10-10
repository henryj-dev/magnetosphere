// K6.T4 끝난 작업 정리 (K1 리뷰 #9). done_at 이 30일(DONE_RETENTION_MS) 넘게 지난 작업만 지운다.
// 실패 작업(failed_at)은 지우지 않는다 (오래 실패 화면, 7단계). 임대를 잃은 실행기의 정리는 0행이다.
// pnpm test:db, 네 DB. 시각 비교가 DB 방언(timestamp 칼럼)마다 같은지 본다.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLease } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { DONE_RETENTION_MS, pruneDone } from "../../src/queue/index.ts";

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

  it(`TC-K6.T4.a ${LABEL[kind]}: done_at 이 30일 넘은 작업만 지우고 실패·미완료·30일 안 작업은 남긴다, 임대를 잃으면 0행`, async () => {
    expect(DONE_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);
    const now = new Date("2026-10-11T00:00:00.000Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const j = h.schema.omnirouteJobs;
    const row = (doneAt: Date | null, failedAt: Date | null) => ({
      id: randomUUID(),
      action: "budget.set",
      payload: JSON.stringify({ omnirouteKeyId: "k", monthlyUsd: 1 }),
      attempts: 1,
      nextRunAt: ago(DONE_RETENTION_MS * 3),
      doneAt,
      failedAt,
    });
    const old = row(ago(DONE_RETENTION_MS + 1_000), null);
    const recent = row(ago(DONE_RETENTION_MS - 1_000), null);
    const failed = row(null, ago(DONE_RETENTION_MS * 3));
    // 두 칸이 다 찍힌 행은 runDue 가 만들지 않지만, 실패 칸이 있으면 지우지 않는다
    const failedAndDone = row(ago(DONE_RETENTION_MS * 2), ago(DONE_RETENTION_MS * 2));
    const pending = row(null, null);
    await h.db.insert(j).values([old, recent, failed, failedAndDone, pending]);
    const lease = await acquireLease(h, "omniroute_jobs", `a-${kind}`, 55_000, now);
    expect(lease).not.toBeNull();

    expect(await pruneDone(h, now, { lease: lease! })).toBe(1);
    const left = (await h.db.select({ id: j.id }).from(j)).map((r) => r.id).sort();
    expect(left).toEqual([recent.id, failed.id, failedAndDone.id, pending.id].sort());

    // 임대를 다른 실행기가 가져간 뒤 옛 임대로 정리 → 0행 (펜싱)
    const older = row(ago(DONE_RETENTION_MS * 2), null);
    await h.db.insert(j).values(older);
    const later = new Date(now.getTime() + 60_000);
    expect(await acquireLease(h, "omniroute_jobs", `b-${kind}`, 55_000, later)).not.toBeNull();
    expect(await pruneDone(h, later, { lease: lease! })).toBe(0);
    expect((await h.db.select({ id: j.id }).from(j)).map((r) => r.id)).toContain(older.id);
  });
});
