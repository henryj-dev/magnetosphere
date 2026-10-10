// K6.T4 끝난 작업 정리가 1분 작업 큐 실행기(jobs.ts 의 omniroute_jobs)에 걸려 있다 (SQLite 파일 DB).
// 경계·실패 작업·펜싱은 네 DB 에서 prune.db.test.ts (TC-K6.T4.a) 가 본다.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLease } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle, Runtime } from "@magnetosphere/runtime/types";
import { DONE_RETENTION_MS } from "../../src/queue/index.ts";
import { queueJob } from "../../src/queue/runner.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";

let env: TestEnv;
let h: DbHandle;
beforeEach(async () => {
  env = await makeTestEnv();
  h = await connectNode(env.env.DATABASE_URL);
});
afterEach(async () => {
  await h.close();
  env.cleanup();
});

describe("TC-K6.T4.b 작업 큐 실행기가 끝난 지 30일 넘은 작업을 지운다", () => {
  it("OmniRoute 연결이 없어도 queueJob 한 번 → done_at 이 31일 전인 작업 0행, 1일 전인 작업·실패 작업은 남음", async () => {
    const j = h.schema.omnirouteJobs;
    const ago = (ms: number) => new Date(Date.now() - ms);
    const row = (doneAt: Date | null, failedAt: Date | null) => ({
      id: randomUUID(),
      action: "budget.set",
      payload: "{}",
      attempts: 1,
      nextRunAt: ago(DONE_RETENTION_MS * 2),
      doneAt,
      failedAt,
    });
    const old = row(ago(DONE_RETENTION_MS + 86_400_000), null);
    const recent = row(ago(86_400_000), null);
    const failed = row(null, ago(DONE_RETENTION_MS * 2));
    await h.db.insert(j).values([old, recent, failed]);
    const lease = await acquireLease(h, "omniroute_jobs", "me", 55_000);
    // OMNIROUTE_URL 이 없다: 실행기는 OmniRoute 작업을 돌지 않지만 DB 정리는 한다
    const rt = { secret: () => undefined } as unknown as Runtime;
    await queueJob(rt)({ db: h, lease: lease!, signal: new AbortController().signal });
    const left = (await h.db.select({ id: j.id }).from(j)).map((r) => r.id).sort();
    expect(left).toEqual([recent.id, failed.id].sort());
  });
});
