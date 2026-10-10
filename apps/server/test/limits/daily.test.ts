// K2.T7 지난 날 저장 usage_daily · 날 확정 · 하루 대조 (계획서 v5.7 5.3, V15). SQLite 파일 DB, 가짜 어댑터·시계.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Analytics } from "@magnetosphere/omniroute";
import { acquireLease } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { confirmDays, CONFIRMED_KEY, RECONCILE_TIMEOUT_MS, SPLIT_KEY, storedSpent, type AnalyticsClient } from "../../src/limits/daily.ts";
import { readSetting, writeSetting } from "../../src/limits/store.ts";
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

/** 회원 하나와 키 (OmniRoute id 를 정해서) */
async function member(keys: { ork: string; state?: string }[]) {
  const userId = randomUUID();
  await h.db.insert(h.schema.user).values({ id: userId, name: "m", email: `m-${userId}@example.com`, monthlyLimitUsd: 5 });
  for (const k of keys) {
    await h.db.insert(h.schema.apiKeys).values({ id: randomUUID(), userId, omnirouteKeyId: k.ork, keyPreview: "abcd", state: k.state ?? "active", createdAt: new Date("2026-04-01T00:00:00Z") });
  }
}

interface Call {
  apiKeyIds?: string[];
  start: string;
  end: string;
  timeoutMs?: number;
}

/** 가짜 분석. respond(창) 이 byApiKey 를 돌려준다 */
function fakeClient(respond: (c: Call) => { [key: string]: number | undefined } | Error) {
  const calls: Call[] = [];
  const client = (opts?: { timeoutMs?: number }): AnalyticsClient => ({
    async getAnalytics(q) {
      const c: Call = { apiKeyIds: q.apiKeyIds, start: new Date(q.startDate).toISOString(), end: new Date(q.endDate).toISOString(), timeoutMs: opts?.timeoutMs };
      calls.push(c);
      const r = respond(c);
      if (r instanceof Error) throw r;
      const byApiKey = Object.entries(r).map(([apiKeyId, cost]) => ({ apiKeyId, requests: 1, cost: cost ?? 0 }));
      const a: Analytics = { totalCost: byApiKey.reduce((s, x) => s + x.cost, 0), totalRequests: byApiKey.length, promptTokens: 0, completionTokens: 0, byApiKey };
      return a;
    },
  });
  return { client, calls };
}

async function rows() {
  const t = h.schema.usageDaily;
  return (await h.db.select().from(t)).map((r: any) => `${r.keyId} ${r.day} ${Number(r.costUsd).toFixed(6)}`).sort();
}

async function put(keyId: string, day: string, costUsd: number) {
  await h.db.insert(h.schema.usageDaily).values({ keyId, day, costUsd, updatedAt: new Date("2026-04-01T00:00:00Z") });
}

const drifts = async (): Promise<{ keyDays: number; diffUsd: number; from: string; until: string }[]> =>
  (await h.db.select().from(h.schema.auditLog).where(eq(h.schema.auditLog.action, "alert.usage_drift"))).map((r: any) => JSON.parse(r.detail));

describe("TC-K2.T7.a 날이 바뀐 첫 분배가 어제를 확정 저장한다 (V15 의존)", () => {
  it('usage_daily_confirmed "2026-04-09", now 2026-04-10T00:01Z → 어제 창 호출 1건, 매핑 키의 04-09 행, 확정 날 갱신. 같은 날 두 번째 실행 → 어제 창·대조 호출 0건', async () => {
    await member([{ ork: "ork-A" }, { ork: "ork-B", state: "deleted" }]);
    await writeSetting(h, CONFIRMED_KEY, "2026-04-09", new Date("2026-04-09T00:01:00Z"));
    const now = new Date("2026-04-10T00:01:00Z");
    const lease = await acquireLease(h, "budget_rebalance", "node-a", 55_000, now);
    // 기록은 모두 04-09 에 있다: 그날을 담는 창(어제 창·대조 창)은 같은 값을 돌려준다
    const { client, calls } = fakeClient((c) => (c.start <= "2026-04-09T00:00:00.000Z" && c.end >= "2026-04-09T23:59:59.999Z" ? { "ork-A": 0.5, "ork-B": 0.25, "ork-X": 9 } : {}));
    const r = await confirmDays(h, now, client, { lease: lease! });

    // 어제 창: [04-09 00:00, 04-09 23:59:59.999] — OmniRoute 는 끝을 포함하므로 오늘 00:00 정각 기록이 어제·오늘 두 번 들지 않게
    const yesterday = calls.filter((c) => c.start === "2026-04-09T00:00:00.000Z");
    expect(yesterday).toEqual([{ apiKeyIds: undefined, start: "2026-04-09T00:00:00.000Z", end: "2026-04-09T23:59:59.999Z", timeoutMs: undefined }]);
    expect(r.confirmed).toBe("2026-04-09");
    // 매핑에 없는 키(ork-X)는 두지 않는다. 삭제한 키(ork-B)는 둔다
    expect(await rows()).toEqual(["ork-A 2026-04-09 0.500000", "ork-B 2026-04-09 0.250000"]);
    expect(await readSetting(h, CONFIRMED_KEY)).toBe("2026-04-10");

    const before = calls.length;
    await confirmDays(h, new Date("2026-04-10T00:02:00Z"), client, { lease: lease! });
    expect(calls.length - before, "같은 날 두 번째 실행의 분석 호출").toBe(0);
    // 이번 달 1일 ~ 어제 합 (오늘 제외)
    expect([...(await storedSpent(h, ["ork-A", "ork-B"], new Date("2026-04-01T00:00:00Z"), new Date("2026-04-10T00:00:00Z")))]).toEqual([
      ["ork-A", 0.5],
      ["ork-B", 0.25],
    ]);
  });
});

describe("TC-K2.T7.b 하루 한 번 대조가 저장값을 덮고 차이를 알린다 (V15 의존)", () => {
  it("저장값 04-03 키 A 0.010000, 대조 응답 0.012000 → 대조 호출 1건(04-01T00:00Z ~ 04-09T23:59:59.999Z), 저장값 0.012000, alert.usage_drift 1행(키·날 1, 합계 0.002). 차이 없으면 0행", async () => {
    await member([{ ork: "ork-A" }]);
    await put("ork-A", "2026-04-03", 0.01);
    await writeSetting(h, CONFIRMED_KEY, "2026-04-09", new Date("2026-04-09T00:01:00Z"));
    const month = (c: Call) => c.start === "2026-04-01T00:00:00.000Z";
    const { client, calls } = fakeClient((c) => (month(c) ? { "ork-A": 0.012 } : {}));
    await confirmDays(h, new Date("2026-04-10T00:01:00Z"), client);
    expect(calls.filter(month)).toEqual([{ apiKeyIds: undefined, start: "2026-04-01T00:00:00.000Z", end: "2026-04-09T23:59:59.999Z", timeoutMs: RECONCILE_TIMEOUT_MS }]);
    expect(await rows()).toEqual(["ork-A 2026-04-03 0.012000"]);
    expect(await drifts()).toEqual([{ keyDays: 1, diffUsd: 0.002, from: "2026-04-01", until: "2026-04-10" }]);

    // 다음 날: 어제(04-10) 0, 대조 합계 그대로 0.012 → 차이 없음, 알림 추가 없음
    await confirmDays(h, new Date("2026-04-11T00:01:00Z"), client);
    expect(calls.filter(month).length).toBe(2);
    expect(await drifts()).toHaveLength(1);
  });
});

describe("TC-K2.T7.c 대조가 제한 시간에 걸리면 날 단위로 나눈다", () => {
  it("대조 첫 호출이 시간 초과 → 그 실행 지난 날 저장값 변화 0, 다음 실행부터 하루 창 호출, 9일 치를 다 맞추면 한 번 호출로 돌아감", async () => {
    await member([{ ork: "ork-A" }]);
    await put("ork-A", "2026-04-03", 0.01);
    await put("ork-A", "2026-04-05", 0.02);
    await writeSetting(h, CONFIRMED_KEY, "2026-04-09", new Date("2026-04-09T00:01:00Z"));
    const perDay: Record<string, number> = { "2026-04-03": 0.012, "2026-04-05": 0.02, "2026-04-07": 0.003 };
    let failMonth = true;
    const { client, calls } = fakeClient((c) => {
      const days = (Date.parse(c.end) + 1 - Date.parse(c.start)) / 86_400_000;
      if (days > 1) {
        if (failMonth) return new DOMException("The operation was aborted due to timeout", "TimeoutError");
        return { "ork-A": Object.values(perDay).reduce((s, v) => s + v, 0) };
      }
      const v = perDay[c.start.slice(0, 10)];
      return v === undefined ? {} : { "ork-A": v };
    });

    const r1 = await confirmDays(h, new Date("2026-04-10T00:01:00Z"), client);
    expect(r1.timedOut).toBe(true);
    expect(await rows(), "시간 초과 실행의 지난 날 저장값").toEqual(["ork-A 2026-04-03 0.010000", "ork-A 2026-04-05 0.020000"]);
    expect(await readSetting(h, SPLIT_KEY)).toEqual({ next: "2026-04-01", until: "2026-04-10" });

    calls.length = 0;
    for (let m = 2; m <= 12; m++) await confirmDays(h, new Date(`2026-04-10T00:${String(m).padStart(2, "0")}:00Z`), client);
    // 하루 창 9개 (04-01 ~ 04-09) 를 차례로 하나씩, 그 뒤 실행은 호출 없음
    expect(calls.map((c) => [c.start, c.end])).toEqual(
      Array.from({ length: 9 }, (_, i) => {
        const d = `2026-04-0${i + 1}`;
        return [`${d}T00:00:00.000Z`, `${d}T23:59:59.999Z`];
      }),
    );
    expect(await rows()).toEqual(["ork-A 2026-04-03 0.012000", "ork-A 2026-04-05 0.020000", "ork-A 2026-04-07 0.003000"]);
    expect(await readSetting(h, SPLIT_KEY)).toBeUndefined();
    expect((await drifts()).reduce((s, d) => s + d.keyDays, 0), "차이 난 키·날 (04-03, 04-07)").toBe(2);

    // 다음 날 첫 실행: 어제 창 1건 + 한 번 호출 대조 1건
    failMonth = false;
    calls.length = 0;
    const r2 = await confirmDays(h, new Date("2026-04-11T00:01:00Z"), client);
    expect(calls.map((c) => [c.start, c.end])).toEqual([
      ["2026-04-10T00:00:00.000Z", "2026-04-10T23:59:59.999Z"],
      ["2026-04-01T00:00:00.000Z", "2026-04-10T23:59:59.999Z"],
    ]);
    expect({ timedOut: r2.timedOut, reconciled: r2.reconciled }).toEqual({ timedOut: false, reconciled: { from: "2026-04-01", until: "2026-04-11" } });
  });
});

// ---- K2 리뷰 M1·L3·열린 질문: 확정되지 않은 날은 분석 창으로 센다, 응답에 없는 키는 자료 없음 ----

/** 회원 한도 100, 키 A·B. A 예산 = 100 − (B 이번 달 사용액) 이라 B 사용액을 A 예산으로 읽는다 */
async function memberAB() {
  const { addMember } = await import("./fake.ts");
  await addMember(h, 100, [{ ork: "ork-A" }, { ork: "ork-B" }]);
}

async function budgetA() {
  const { keyRow } = await import("./fake.ts");
  return (await keyRow(h, "ork-A")).budgetUsd;
}

describe("TC-K2.T7.f 이틀 넘는 공백 뒤 대조가 시간 초과여도 이번 달 사용액 == 분석 한 달 합", () => {
  it('confirmed "04-05", now 04-10T00:01, 대조 시간 초과 → 04-05~04-08 을 분석 창으로 센다. 분할이 하루 진행된 뒤에도 같다', async () => {
    const { fakeOmni, recordsAnalytics, multiDay } = await import("./fake.ts");
    const { rebalanceAll } = await import("../../src/limits/rebalance.ts");
    await memberAB();
    await put("ork-B", "2026-04-02", 1);
    await writeSetting(h, CONFIRMED_KEY, "2026-04-05", new Date("2026-04-05T00:01:00Z"));
    const records = [
      { key: "ork-B", at: "2026-04-02T10:00:00.000Z", cost: 1 },
      { key: "ork-B", at: "2026-04-06T10:00:00.000Z", cost: 3 },
      { key: "ork-B", at: "2026-04-09T10:00:00.000Z", cost: 1 },
      { key: "ork-B", at: "2026-04-10T00:00:30.000Z", cost: 0.5 },
    ];
    const o = fakeOmni(recordsAnalytics(records, { timeout: (q) => q.timeoutMs !== undefined && multiDay(q) }));
    const r = await rebalanceAll({ db: h, now: new Date("2026-04-10T00:01:00Z"), client: o.client });
    expect(r.confirm.timedOut).toBe(true);
    // 한 달 합: B 5.5 → A 예산 94.5
    expect(await budgetA()).toBe(94.5);
    await rebalanceAll({ db: h, now: new Date("2026-04-10T00:02:00Z"), client: o.client });
    expect(await budgetA()).toBe(94.5);
  });
});

describe("TC-K2.T7.g 처음 설치한 날 대조가 시간 초과여도 이번 달 사용액 == 분석 한 달 합", () => {
  it("usage_daily_confirmed 없음, now 04-10T00:01, 대조 시간 초과 → 이번 달 1일부터 분석 창으로 센다", async () => {
    const { fakeOmni, recordsAnalytics, multiDay } = await import("./fake.ts");
    const { rebalanceAll } = await import("../../src/limits/rebalance.ts");
    await memberAB();
    const records = [
      { key: "ork-B", at: "2026-04-03T10:00:00.000Z", cost: 2 },
      { key: "ork-B", at: "2026-04-09T10:00:00.000Z", cost: 1 },
      { key: "ork-B", at: "2026-04-10T00:00:30.000Z", cost: 0.5 },
    ];
    const o = fakeOmni(recordsAnalytics(records, { timeout: (q) => q.timeoutMs !== undefined && multiDay(q) }));
    const r = await rebalanceAll({ db: h, now: new Date("2026-04-10T00:01:00Z"), client: o.client });
    expect(r.confirm.timedOut).toBe(true);
    expect(await budgetA()).toBe(96.5);
  });
});

describe("TC-K2.T7.h 분할 대조의 하루 창이 시간 초과면 그날만 다음 실행으로 미룬다", () => {
  it("split { next 04-03, until 04-10 }, 04-03 창 시간 초과 → 분배는 계속(그날부터 분석 창), split 그대로", async () => {
    const { fakeOmni, recordsAnalytics } = await import("./fake.ts");
    const { rebalanceAll } = await import("../../src/limits/rebalance.ts");
    await memberAB();
    await writeSetting(h, CONFIRMED_KEY, "2026-04-10", new Date("2026-04-10T00:01:00Z"));
    await writeSetting(h, SPLIT_KEY, { next: "2026-04-03", until: "2026-04-10" }, new Date("2026-04-10T00:01:00Z"));
    const records = [
      { key: "ork-B", at: "2026-04-03T10:00:00.000Z", cost: 2 },
      { key: "ork-B", at: "2026-04-10T00:00:30.000Z", cost: 0.5 },
    ];
    const o = fakeOmni(recordsAnalytics(records, { timeout: (q) => q.timeoutMs !== undefined }));
    await rebalanceAll({ db: h, now: new Date("2026-04-10T00:05:00Z"), client: o.client });
    expect(await readSetting(h, SPLIT_KEY)).toEqual({ next: "2026-04-03", until: "2026-04-10" });
    expect(await budgetA()).toBe(97.5);
  });
});

describe("TC-K2.T7.i 대조 응답에 없는 키의 저장값은 지우지 않는다 (자료 없음)", () => {
  it("저장값 A 04-03 0.01·B 04-04 0.02, 대조 응답에 A 만 → B 저장값 0.02 그대로, 차이 0", async () => {
    await member([{ ork: "ork-A" }, { ork: "ork-B" }]);
    await put("ork-A", "2026-04-03", 0.01);
    await put("ork-B", "2026-04-04", 0.02);
    await writeSetting(h, CONFIRMED_KEY, "2026-04-09", new Date("2026-04-09T00:01:00Z"));
    const { client } = fakeClient((c) => (c.start === "2026-04-01T00:00:00.000Z" ? { "ork-A": 0.01 } : {}));
    await confirmDays(h, new Date("2026-04-10T00:01:00Z"), client);
    expect(await rows()).toEqual(["ork-A 2026-04-03 0.010000", "ork-B 2026-04-04 0.020000"]);
    expect(await drifts()).toEqual([]);
  });
});

describe("TC-K2.T7.j 지난달 분할 대조 상태는 새 달 첫 실행이 지운다 (재검토 L-b)", () => {
  it('split { next 03-25, until 03-31 }, now 04-01T00:01 → split 지움, 3월 하루 창 호출 0건 (같은 날 두 번째 실행도)', async () => {
    await member([{ ork: "ork-A" }]);
    await writeSetting(h, CONFIRMED_KEY, "2026-03-31", new Date("2026-03-31T00:01:00Z"));
    await writeSetting(h, SPLIT_KEY, { next: "2026-03-25", until: "2026-03-31" }, new Date("2026-03-31T00:01:00Z"));
    const { client, calls } = fakeClient(() => ({}));
    await confirmDays(h, new Date("2026-04-01T00:01:00Z"), client);
    expect(await readSetting(h, SPLIT_KEY)).toBeUndefined();
    await confirmDays(h, new Date("2026-04-01T00:02:00Z"), client);
    expect(calls.map((c) => c.start)).toEqual(["2026-03-31T00:00:00.000Z"]);
  });
});
