// K1.T3 작업 큐 (SQLite 파일 DB, 가짜 시계 = runDue 에 넘기는 now). 네 DB 동시 실행기는 concurrency.db.test.ts.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OmniRouteError, type OmniRouteClient } from "@magnetosphere/omniroute";
import { acquireLease, LeaseLostError } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { ACTIONS, CLAIM_MS, DUE_GRACE_MS, enqueue, KEY_DELETE_DELAY_MS, isLongFailed, RETRY_DELAYS_MS, runDue, type Handler, type Handlers } from "../../src/queue/index.ts";
import { omnirouteHandlers } from "../../src/queue/handlers.ts";
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

/** 고정 씨앗 의사 난수 (0 이상 1 미만). 시험이 실패하면 같은 씨앗으로 다시 재현한다 */
function seeded(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("TC-K1.T3.a 재시도 간격은 1분·2분·10분·30분이다 (Q2 의존)", () => {
  it("1분 경계 tick 에 0~20초 지연을 섞어도 시도는 0·1·3·13·43분 경계에 돌고, next_run_at − 실패 시각 = 60000·120000·600000·1800000ms", async () => {
    // 실행기는 1분 경계마다 깨지만 깨는 시각이 0~20초 늦을 수 있다 (타이머·Cron 지연). 실패 시각 = 그 tick 시각 (핸들러는 바로 실패)
    for (let seed = 1; seed <= 20; seed++) {
      const rand = seeded(seed);
      const id = await enqueue(h, "budget.set", { omnirouteKeyId: "k", monthlyUsd: 1 }, { now: T0 });
      const tried: number[] = [];
      const gaps: number[] = [];
      let failedAt = 0;
      const handlers = all(async () => {
        throw new Error("OmniRoute 가 응답하지 않는다");
      });
      for (let minute = 0; minute <= 45; minute++) {
        const tick = new Date(T0.getTime() + minute * 60_000 + Math.floor(rand() * 20_000));
        const before = (await jobRow(id)).attempts;
        await runDue(h, handlers, tick, { clock: () => tick.getTime() });
        const r = await jobRow(id);
        if (r.attempts === before) continue;
        tried.push(minute);
        if (r.failedAt) failedAt = r.failedAt.getTime();
        else gaps.push(r.nextRunAt.getTime() - tick.getTime());
      }
      expect(tried, `씨앗 ${seed}`).toEqual([0, 1, 3, 13, 43]);
      expect(gaps, `씨앗 ${seed}`).toEqual([60_000, 120_000, 600_000, 1_800_000]);
      expect(failedAt, `씨앗 ${seed}: 4번째 재시도 실패 뒤 failed_at`).toBeGreaterThan(0);
      await h.db.delete(h.schema.omnirouteJobs).where(eq(h.schema.omnirouteJobs.id, id));
    }
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
    expect(await runDue(h, handlers, new Date(failedAt.getTime() + 24 * 3600_000))).toEqual({ done: 0, retried: 0, failed: 0, errors: 0, stale: 0 });
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
    const id = await enqueue(h, "key.rollback", { keyId: "key-k", omnirouteKeyId: "k" }, { now: T0 });
    // 아직 차례가 아닌 작업은 집지 않는다 (대조)
    const later = await enqueue(h, "budget.set", { omnirouteKeyId: "k", monthlyUsd: 2 }, { runAt: new Date(T0.getTime() + 60_000) });
    const calls: string[] = [];
    const handlers = all(async (_p, { job }) => void calls.push(job.id));
    expect(await runDue(h, handlers, T0)).toEqual({ done: 1, retried: 0, failed: 0, errors: 0, stale: 0 });
    const r = await jobRow(id);
    expect({ doneAt: r.doneAt?.getTime(), attempts: r.attempts, lastError: r.lastError }).toEqual({ doneAt: T0.getTime(), attempts: 1, lastError: null });
    // 차례 비교에는 30초 유예가 있다 (DUE_GRACE_MS). 유예 밖이면 아직 아니다
    expect(await runDue(h, handlers, new Date(T0.getTime() + 60_000 - DUE_GRACE_MS - 1))).toEqual({ done: 0, retried: 0, failed: 0, errors: 0, stale: 0 });
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

describe("TC-K1.T3.h 망가진 payload 는 곧바로 failed 로 두고 큐를 끊지 않는다", () => {
  it("payload 가 JSON 이 아닌 작업 → 핸들러 호출 없이 failed_at·attempts 1·sync_state failed·alert 1행, 같은 tick 의 다음 작업은 돈다", async () => {
    const keyId = await keyRow();
    const j = h.schema.omnirouteJobs;
    const broken = randomUUID();
    await h.db.insert(j).values({ id: broken, action: "key.apply_state", payload: "{broken", keyId, attempts: 0, nextRunAt: T0 });
    const good = await enqueue(h, "key.rollback", { keyId: "key-k", omnirouteKeyId: "k" }, { runAt: new Date(T0.getTime() + 1) });
    const calls: string[] = [];
    const result = await runDue(h, all(async (_p, { job }) => void calls.push(job.id)), new Date(T0.getTime() + 1));
    expect(calls).toEqual([good]);
    expect(result).toMatchObject({ done: 1, failed: 1, errors: 0, stale: 0 });
    const r = await jobRow(broken);
    expect({ attempts: r.attempts, failed: r.failedAt instanceof Date, lastError: r.lastError }).toEqual({ attempts: 1, failed: true, lastError: "payload JSON 아님" });
    const [key] = await h.db.select({ syncState: h.schema.apiKeys.syncState }).from(h.schema.apiKeys).where(eq(h.schema.apiKeys.id, keyId));
    expect(key.syncState).toBe("failed");
    const alerts = await h.db.select().from(h.schema.auditLog).where(eq(h.schema.auditLog.action, "alert.job_failed"));
    expect(alerts.map((a: { target: string }) => a.target)).toEqual([broken]);
    // 다음 tick 에도 다시 집지 않는다
    expect(await runDue(h, all(async () => {}), new Date(T0.getTime() + 24 * 3600_000))).toMatchObject({ done: 0, failed: 0 });
  });
});

describe("TC-K1.T3.i 임대를 잃어 끊긴 실행은 재시도 횟수를 쓰지 않는다", () => {
  it("핸들러 도중 임대를 다른 실행기가 가져가 신호가 끊김 → 그 작업 attempts 0·next_run_at 원래 값·last_error 없음, 다음 작업은 집지 않는다", async () => {
    const lease = (await acquireLease(h, "omniroute_jobs", "A", 55_000, T0))!;
    const id = await enqueue(h, "budget.set", { omnirouteKeyId: "k", monthlyUsd: 1 }, { now: T0 });
    const other = await enqueue(h, "budget.set", { omnirouteKeyId: "k2", monthlyUsd: 1 }, { runAt: new Date(T0.getTime() + 1) });
    const ac = new AbortController();
    const calls: string[] = [];
    const handlers = all(async (_p, { job, signal }) => {
      calls.push(job.id);
      // 하트비트가 늦은 사이 다른 실행기(B)가 만료된 임대를 가져갔다 → 하트비트 실패로 신호가 끊긴다
      await acquireLease(h, "omniroute_jobs", "B", 55_000, new Date(T0.getTime() + 60_000));
      ac.abort(new LeaseLostError(lease));
      signal?.throwIfAborted();
    });
    await runDue(h, handlers, new Date(T0.getTime() + 1), { lease, signal: ac.signal });
    expect(calls).toEqual([id]);
    const r = await jobRow(id);
    expect({ attempts: r.attempts, nextRunAt: r.nextRunAt.getTime(), lastError: r.lastError, failedAt: r.failedAt }).toEqual({ attempts: 0, nextRunAt: T0.getTime(), lastError: null, failedAt: null });
    expect((await jobRow(other)).attempts).toBe(0);
  });
});

describe("TC-K1.T3.l 실패 처리가 계속 실패해도 OmniRoute 호출을 끝없이 되풀이하지 않는다", () => {
  it("attempts 가 RETRY_DELAYS_MS 길이 + 2 를 넘으면 핸들러 없이 실패 처리만 시도하고 경보, 알림 저장이 돌아오면 failed", async () => {
    const keyId = await keyRow();
    const j = h.schema.omnirouteJobs;
    const id = await enqueue(h, "key.apply_state", { keyId }, { now: T0 });
    // 실패 처리를 이미 두 번 못 쓴 작업 (마지막 시도 뒤 차지만 남았다)
    await h.db.update(j).set({ attempts: RETRY_DELAYS_MS.length + 2 }).where(eq(j.id, id));
    const calls: string[] = [];
    const handlers = all(async (_p, { job }) => {
      calls.push(job.id);
      throw new Error("OmniRoute 가 응답하지 않는다");
    });
    const alarms: string[] = [];
    await h.db.run(sql.raw("ALTER TABLE audit_log RENAME TO audit_log_off"));
    try {
      const r = await runDue(h, handlers, T0, { onAlarm: (jobId) => void alarms.push(jobId), onError: () => {} });
      expect(r).toMatchObject({ failed: 0, errors: 1 });
    } finally {
      await h.db.run(sql.raw("ALTER TABLE audit_log_off RENAME TO audit_log"));
    }
    expect(calls, "핸들러(OmniRoute 호출)를 다시 부르지 않는다").toEqual([]);
    expect(alarms).toEqual([id]);
    expect((await jobRow(id)).failedAt).toBeNull();
    await runDue(h, handlers, new Date(T0.getTime() + CLAIM_MS));
    expect(calls).toEqual([]);
    expect((await jobRow(id)).failedAt).toBeInstanceOf(Date);
  });
});

describe("TC-K1.T3.n key.* 작업은 keyId 없이 넣을 수 없다 (delete 우선이 조용히 꺼지지 않게)", () => {
  it("key.delete·key.rollback·key.apply_state 를 keyId 없이 → TypeError·행 0, keyId 가 있으면 key_id 칼럼에 남고 미완료 key.delete 가 켜기를 막는다", async () => {
    const runAt = new Date(T0.getTime() + KEY_DELETE_DELAY_MS);
    for (const [action, payload, opts] of [
      ["key.delete", { omnirouteKeyId: "k" }, { runAt }],
      ["key.rollback", { omnirouteKeyId: "k" }, { now: T0 }],
      ["key.apply_state", {}, { now: T0 }],
      ["key.delete", { keyId: "", omnirouteKeyId: "k" }, { runAt }],
    ] as const) {
      await expect(enqueue(h, action, payload, opts), `${action} ${JSON.stringify(payload)}`).rejects.toThrow(TypeError);
    }
    expect(await h.db.select().from(h.schema.omnirouteJobs)).toHaveLength(0);

    // 켜져 있어야 할 키에 미완료 key.delete 가 있으면 반영은 끈다 (delete 가 이긴다)
    const keyId = await keyRow();
    await h.db.update(h.schema.apiKeys).set({ state: "active" }).where(eq(h.schema.apiKeys.id, keyId));
    const del = await enqueue(h, "key.delete", { keyId, omnirouteKeyId: `ork-${keyId}` }, { runAt });
    expect((await jobRow(del)).keyId).toBe(keyId);
    await enqueue(h, "key.apply_state", { keyId }, { now: T0 });
    const set: boolean[] = [];
    const client = { setKeyActive: async (_id: string, v: boolean) => void set.push(v) } as unknown as OmniRouteClient;
    await runDue(h, omnirouteHandlers(() => client), T0);
    expect(set).toEqual([false]);
  });
});

describe("TC-K1.T3.o 핸들러 표 밖의 action 은 프로토타입 함수로 돌지 않는다", () => {
  it('action "toString"·"constructor" 작업 → done 이 아니라 failed "모르는 작업"', async () => {
    const j = h.schema.omnirouteJobs;
    for (const action of ["toString", "constructor", "hasOwnProperty"]) {
      const id = randomUUID();
      await h.db.insert(j).values({ id, action, payload: "{}", attempts: 0, nextRunAt: T0 });
      await runDue(h, all(async () => {}), T0);
      const r = await jobRow(id);
      expect({ action, done: r.doneAt, failed: r.failedAt instanceof Date, lastError: r.lastError }).toEqual({ action, done: null, failed: true, lastError: "모르는 작업" });
    }
  });
});
