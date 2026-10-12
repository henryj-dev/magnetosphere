// K6.T4 끝난 작업 정리가 1분 작업 큐 실행기(jobs.ts 의 omniroute_jobs)에 걸려 있다 (SQLite 파일 DB).
// 경계·실패 작업·펜싱은 네 DB 에서 prune.db.test.ts (TC-K6.T4.a) 가 본다.
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLease } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle, Runtime } from "@magnetosphere/runtime/types";
import { DONE_RETENTION_MS } from "../../src/queue/index.ts";
import { queueJob } from "../../src/queue/runner.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";
import { t3aRows, T3_NOW } from "../invites/prune-checks.ts";

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

describe("TC-M3.T3.c 작업 큐 실행기에 초대 정리가 등록돼 있다", () => {
  it("OmniRoute 연결 없이 실제 queueJob 한 번 → 만료·취소 31일 초대만 지움 2·남음 6", async () => {
    const inv = h.schema.invites;
    const { drop, keep } = t3aRows();
    // 고정 시각의 공용 행을 실제 queueJob 시각으로 옮긴다. 실행기·pruneInvites 는 흉내 내지 않는다.
    const now = Date.now();
    const at = (ms: number | null) => (ms === null ? null : new Date(ms + now - T3_NOW));
    const createdBy = randomUUID();
    await h.db.insert(inv).values(
      [...Object.values(drop), ...Object.values(keep)].map((r) => ({
        id: r.id,
        email: null,
        tokenHash: createHash("sha256").update(r.id).digest("hex"),
        role: "member",
        expiresAt: at(r.expiresAt),
        usedAt: at(r.usedAt),
        usedBy: r.usedBy,
        createdBy,
        revokedAt: at(r.revokedAt),
      })),
    );
    const lease = await acquireLease(h, "omniroute_jobs", "invite-prune", 55_000);
    expect(lease).not.toBeNull();
    const rt = { secret: () => undefined } as unknown as Runtime;
    await queueJob(rt)({ db: h, lease: lease!, signal: new AbortController().signal });
    const left = (await h.db.select({ id: inv.id }).from(inv)).map((r: { id: string }) => r.id).sort();
    expect(left).toEqual(Object.values(keep).map((r) => r.id).sort());
    expect(left).toHaveLength(6);
  });
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
    const left = (await h.db.select({ id: j.id }).from(j)).map((r: { id: string }) => r.id).sort();
    expect(left).toEqual([recent.id, failed.id].sort());
  });
});
