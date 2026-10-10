// K2.T2 달 경계와 시간대 (UTC, V20). 달 바뀜 판단은 app_settings.budget_rebalance_month (Q5).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { computeBudgets } from "../../src/limits/compute.ts";
import { monthChanged, monthKey, monthWindow, REBALANCE_MONTH_KEY } from "../../src/limits/month.ts";
import { readSetting, writeSetting } from "../../src/limits/store.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";

const V20 = JSON.parse(readFileSync(new URL("../../../../docs/verify/V20.json", import.meta.url), "utf8")).answer;

describe("TC-K2.T2.a 달 경계 직전·직후의 창이 다르다 (V20 의존)", () => {
  it("UTC 3월 31일 23:59:59.999 → 창 시작 3월 1일 00:00, 4월 1일 00:00:00.000 → 4월 1일 00:00", () => {
    expect(V20.timezone).toBe("UTC");
    const before = new Date("2026-03-31T23:59:59.999Z");
    const after = new Date("2026-04-01T00:00:00.000Z");
    expect(monthWindow(before).start.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(monthWindow(before).end).toBe(before);
    expect(monthWindow(after).start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    // 다른 시간대의 자정(예: UTC+9 4월 1일 00:00 = 3월 31일 15:00Z)은 아직 3월이다
    expect(monthWindow(new Date("2026-03-31T15:00:00.000Z")).start.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("TC-K2.T2.b 새 달 첫 실행은 지난달 사용액을 넣지 않는다", () => {
  it("가짜 분석(지난달 4.9, 이번 달 0), 한도 5, 새 달 00:00:30 실행 → 남은 5", () => {
    const records = [
      { at: new Date("2026-03-31T23:58:00.000Z"), cost: 4.9 },
      { at: new Date("2026-04-01T00:00:00.000Z"), cost: 0 },
    ];
    // 분석 API 는 [startDate, endDate] 안의 기록 비용을 더한다
    const analytics = (start: Date, end: Date) => records.filter((r) => r.at >= start && r.at <= end).reduce((s, r) => s + r.cost, 0);
    const now = new Date("2026-04-01T00:00:30.000Z");
    const w = monthWindow(now);
    const r = computeBudgets({ limitUsd: 5, keys: [{ id: "A", state: "active", spentUsd: analytics(w.start, w.end) }] });
    expect(r.remaining).toBe(5);
  });
});

describe("TC-K2.T2.c 달 바뀜은 저장한 마지막 실행 달로 판단한다 (Q5 의존)", () => {
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

  it('budget_rebalance_month "2026-03", now 2026-04-01T00:00:30Z → true, 저장 뒤 "2026-04". 같은 달 두 번째 → false. 값 없음 → true', async () => {
    expect(monthChanged(await readSetting<string>(h, REBALANCE_MONTH_KEY), new Date("2026-04-01T00:00:30Z")), "값 없음(첫 실행)").toBe(true);
    await writeSetting(h, REBALANCE_MONTH_KEY, "2026-03", new Date("2026-03-31T23:59:00Z"));
    const now = new Date("2026-04-01T00:00:30Z");
    expect(monthChanged(await readSetting<string>(h, REBALANCE_MONTH_KEY), now)).toBe(true);
    await writeSetting(h, REBALANCE_MONTH_KEY, monthKey(now), now);
    expect(await readSetting<string>(h, REBALANCE_MONTH_KEY)).toBe("2026-04");
    expect(monthChanged(await readSetting<string>(h, REBALANCE_MONTH_KEY), new Date("2026-04-01T00:01:30Z")), "같은 달 두 번째").toBe(false);
    expect(monthChanged(await readSetting<string>(h, REBALANCE_MONTH_KEY), new Date("2026-04-30T23:59:59.999Z"))).toBe(false);
  });
});
