// K1.T3 작업 큐 (SQLite 파일 DB, 가짜 시계 = runDue 에 넘기는 now). 네 DB 동시 실행기는 concurrency.db.test.ts.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OmniRouteError } from "@magnetosphere/omniroute";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { ACTIONS, enqueue, isLongFailed, runDue, type Handler, type Handlers } from "../../src/queue/index.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";

const T0 = new Date("2026-10-01T00:00:00.000Z");
const all = (fn: Handler): Handlers => Object.fromEntries(ACTIONS.map((a) => [a, fn])) as Handlers;

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

const jobRow = async (id: string) => (await h.db.select().from(h.schema.omnirouteJobs).where(eq(h.schema.omnirouteJobs.id, id)))[0];

async function keyRow(): Promise<string> {
  const userId = randomUUID();
  const keyId = randomUUID();
  await h.db.insert(h.schema.user).values({ id: userId, name: "q", email: `q-${userId}@example.com` });
  await h.db.insert(h.schema.apiKeys).values({ id: keyId, userId, omnirouteKeyId: `ork-${keyId}`, keyPreview: "abcd", state: "disabled", syncState: "pending", createdAt: T0 });
  return keyId;
}

/** 늘 실패하는 핸들러로 다섯 번(첫 시도 + 재시도 넷) 돌린다. 시도마다 실패 시각과 그 뒤 next_run_at */
async function failFiveTimes(id: string, calls: { n: number }) {
  const handlers = all(async () => {
    calls.n++;
    throw new Error("OmniRoute 가 응답하지 않는다");
  });
  const seen: { at: Date; next: Date; failedAt: Date | null }[] = [];
  let at = T0;
  for (let i = 0; i < 5; i++) {
    await runDue(h, handlers, at);
    const r = await jobRow(id);
    seen.push({ at, next: r.nextRunAt, failedAt: r.failedAt });
    at = r.nextRunAt;
  }
  return { seen, handlers };
}

describe("TC-K1.T3.a 재시도 간격은 1분·2분·10분·30분이다 (Q2 의존)", () => {
  it("늘 실패하는 핸들러, 가짜 시계 → 실패 시각 대비 next_run_at 차이 60000·120000·600000·1800000ms, 4번째 재시도 실패 뒤 next_run_at 그대로·failed_at 설정", async () => {
    const id = await enqueue(h, "budget.set", { omnirouteKeyId: "k", monthlyUsd: 1 }, { now: T0 });
    const calls = { n: 0 };
    const { seen } = await failFiveTimes(id, calls);
    expect(calls.n).toBe(5);
    expect(seen.slice(0, 4).map((s) => s.next.getTime() - s.at.getTime())).toEqual([60_000, 120_000, 600_000, 1_800_000]);
    expect(seen.slice(0, 4).every((s) => s.failedAt === null)).toBe(true);
    // 다섯 번째 시도(4번째 재시도)의 실패: next_run_at 은 그 시도 전 값, failed_at 은 실패 시각
    expect(seen[4].next.getTime()).toBe(seen[4].at.getTime());
    expect(seen[4].failedAt?.getTime()).toBe(seen[4].at.getTime());
    expect((await jobRow(id)).attempts).toBe(5);
  });
});

describe("TC-K1.T3.b 재시도를 다 써도 실패하면 대상 키가 failed 로 드러난다 (Q3 의존)", () => {
  it("4번째 재시도 실패 → failed_at·runDue 대상에서 빠짐, api_keys.sync_state failed, audit_log alert.job_failed 1행, isLongFailed 30분 경계", async () => {
    const keyId = await keyRow();
    const id = await enqueue(h, "key.apply_state", { keyId, omnirouteKeyId: `ork-${keyId}`, active: false }, { now: T0 });
    const calls = { n: 0 };
    const { seen, handlers } = await failFiveTimes(id, calls);
    const failedAt = seen[4].failedAt!;
    expect(failedAt).toBeInstanceOf(Date);
    // 한참 뒤에 돌려도 다시 집지 않는다
    expect(await runDue(h, handlers, new Date(failedAt.getTime() + 24 * 3600_000))).toEqual({ done: 0, retried: 0, failed: 0 });
    expect(calls.n).toBe(5);

    const [key] = await h.db.select({ syncState: h.schema.apiKeys.syncState }).from(h.schema.apiKeys).where(eq(h.schema.apiKeys.id, keyId));
    expect(key.syncState).toBe("failed");
    const alerts = await h.db.select().from(h.schema.auditLog).where(eq(h.schema.auditLog.action, "alert.job_failed"));
    expect(alerts.map((a: { target: string }) => a.target)).toEqual([id]);
    expect(JSON.parse(alerts[0].detail)).toMatchObject({ action: "key.apply_state", attempts: 5, keyId });

    const job = await jobRow(id);
    expect(isLongFailed(job, new Date(failedAt.getTime() + 30 * 60_000 - 1))).toBe(false);
    expect(isLongFailed(job, new Date(failedAt.getTime() + 30 * 60_000 + 1))).toBe(true);
    expect(isLongFailed({ failedAt: null }, new Date(failedAt.getTime() + 24 * 3600_000))).toBe(false);
  });
});

describe("TC-K1.T3.d 성공한 작업은 done_at 이 찍히고 다시 돌지 않는다", () => {
  it("성공 → done_at 설정, attempts 1, 다음 runDue 에서 호출 0", async () => {
    const id = await enqueue(h, "key.apply_state", { omnirouteKeyId: "k", active: true }, { now: T0 });
    // 아직 차례가 아닌 작업은 집지 않는다 (대조)
    const later = await enqueue(h, "budget.set", { omnirouteKeyId: "k", monthlyUsd: 2 }, { runAt: new Date(T0.getTime() + 60_000) });
    const calls: string[] = [];
    const handlers = all(async (_p, { job }) => void calls.push(job.id));
    expect(await runDue(h, handlers, T0)).toEqual({ done: 1, retried: 0, failed: 0 });
    const r = await jobRow(id);
    expect({ doneAt: r.doneAt?.getTime(), attempts: r.attempts, lastError: r.lastError }).toEqual({ doneAt: T0.getTime(), attempts: 1, lastError: null });
    expect(await runDue(h, handlers, new Date(T0.getTime() + 59_999))).toEqual({ done: 0, retried: 0, failed: 0 });
    expect(calls).toEqual([id]);
    await runDue(h, handlers, new Date(T0.getTime() + 60_000));
    expect(calls).toEqual([id, later]);
  });
});

describe("TC-K1.T3.e last_error 에 비밀 값이 없다", () => {
  it("본문에 oma_live_·sk- 를 담은 OmniRouteError → last_error 에 oma_live_·sk- 0건", async () => {
    const id = await enqueue(h, "budget.set", { omnirouteKeyId: "k", monthlyUsd: 1 }, { now: T0 });
    const body = '{"error":{"message":"bad token oma_live_x9Yk2Lq7 for key sk-xAbC123def"}}';
    const err = new OmniRouteError("POST", "/budget", 401, "AUTH_001", body);
    // 대조: 어댑터 오류 메시지에는 비밀 값이 들어 있다
    expect(err.message).toContain("oma_live_");
    await runDue(h, all(async () => Promise.reject(err)), T0);
    const first = (await jobRow(id)).lastError as string;
    expect(first).toBe("OmniRoute 401 AUTH_001");

    // 오류 코드 자리에 비밀 값 모양이 와도, 어댑터 밖 오류의 메시지도 남기지 않는다
    const id2 = await enqueue(h, "budget.set", { omnirouteKeyId: "k", monthlyUsd: 1 }, { now: T0 });
    await runDue(h, all(async () => Promise.reject(new OmniRouteError("POST", "/x", 400, "sk-leaked-code", body))), T0);
    const id3 = await enqueue(h, "budget.set", { omnirouteKeyId: "k", monthlyUsd: 1 }, { now: T0 });
    await runDue(h, all(async () => Promise.reject(new TypeError(`fetch 실패 ${body}`))), T0);
    for (const e of [first, (await jobRow(id2)).lastError, (await jobRow(id3)).lastError]) {
      expect(e).toBeTruthy();
      expect(e).not.toMatch(/oma_live_|sk-/i);
    }
  });
});
