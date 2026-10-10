// K2.T6 1분 분배 (계획서 v5.7 5.3). SQLite 파일 DB, 가짜 어댑터·시계. 실제 OmniRoute 는 test/contract/limits.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, OmniRouteFormatError } from "@magnetosphere/omniroute";
import { acquireLease } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { CONFIRMED_KEY } from "../../src/limits/daily.ts";
import { REBALANCE_MONTH_KEY } from "../../src/limits/month.ts";
import { rebalanceAll } from "../../src/limits/rebalance.ts";
import { readSetting, writeSetting } from "../../src/limits/store.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";
import { addMember, fakeOmni, keyRow } from "./fake.ts";

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

const NOW = new Date("2026-04-10T12:00:00.000Z");
/** 날 확정을 이미 한 날 (같은 날 두 번째 실행) */
const confirmedToday = () => writeSetting(h, CONFIRMED_KEY, "2026-04-10", new Date("2026-04-10T00:01:00Z"));

describe("TC-K2.T6.a 활성 키가 없는 회원은 OmniRoute 호출이 없다", () => {
  it("회원 둘(활성 키 있음 1, 꺼진 키만 1) → setBudget 대상은 첫 회원 키뿐", async () => {
    await confirmedToday();
    await addMember(h, 5, [{ ork: "ork-1" }]);
    await addMember(h, 5, [{ ork: "ork-2", state: "disabled", reason: "member" }]);
    const o = fakeOmni(() => ({ "ork-1": 0.1, "ork-2": 0.2 }));
    const r = await rebalanceAll({ db: h, now: NOW, client: o.client });
    expect(r.members, "분배 대상 회원").toBe(1);
    expect(o.of("setBudget").map((c) => c.id)).toEqual(["ork-1"]);
    expect(o.of("setKeyActive")).toEqual([]);
    expect(await keyRow(h, "ork-2")).toMatchObject({ state: "disabled", reason: "member", budgetUsd: null });
  });
});

describe("TC-K2.T6.b 예산이 바뀐 키만 setBudget 을 부른다", () => {
  it("같은 상태로 두 번 실행 → 두 번째 실행 setBudget 0건. 다른 키가 써서 예산이 바뀌면 그 키만", async () => {
    await confirmedToday();
    await addMember(h, 5, [{ ork: "ork-A" }, { ork: "ork-B" }]);
    let costs: Record<string, number> = { "ork-A": 1, "ork-B": 0.5 };
    const o = fakeOmni(() => costs);
    await rebalanceAll({ db: h, now: NOW, client: o.client });
    expect(o.of("setBudget").map((c) => [c.id, c.value])).toEqual([
      ["ork-A", 4.5],
      ["ork-B", 4],
    ]);
    o.calls.length = 0;
    await rebalanceAll({ db: h, now: new Date(NOW.getTime() + 60_000), client: o.client });
    expect(o.of("setBudget"), "두 번째 실행").toEqual([]);
    // A 가 더 쓰면 A 예산은 그대로(사용액 + 남은 한도), B 예산만 준다
    costs = { "ork-A": 1.5, "ork-B": 0.5 };
    await rebalanceAll({ db: h, now: new Date(NOW.getTime() + 120_000), client: o.client });
    expect(o.of("setBudget").map((c) => [c.id, c.value])).toEqual([["ork-B", 3.5]]);
  });
});

describe("TC-K2.T6.c 분석 형식 오류면 예산을 하나도 바꾸지 않는다", () => {
  it("분석 응답에 음수 cost(analyticsSchema money 위반) → OmniRouteFormatError, setBudget 0건, budget_usd 변화 0", async () => {
    await confirmedToday();
    await addMember(h, 5, [{ ork: "ork-A", budgetUsd: 4.5 }, { ork: "ork-B", budgetUsd: 4 }]);
    const sent: { method: string; url: string }[] = [];
    // 실제 어댑터에 가짜 fetch: 분석은 byApiKey 비용이 음수인 응답, 그 밖의 요청은 기록만
    const fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ method: init?.method ?? "GET", url: String(url) });
      const body = String(url).includes("analytics")
        ? { summary: { totalCost: 0, totalRequests: 2, promptTokens: 0, completionTokens: 0 }, byApiKey: [{ apiKeyId: "ork-A", requests: 1, cost: -1 }] }
        : { success: true, apiKeyId: "ork-A", budget: { monthlyLimitUsd: 1, resetInterval: "monthly" } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const client = () => createClient({ baseUrl: "http://omni.test", credential: { token: "oma_live_t" }, fetch });
    await expect(rebalanceAll({ db: h, now: NOW, client })).rejects.toThrow(OmniRouteFormatError);
    expect(sent.filter((s) => s.method !== "GET"), "setBudget·setKeyActive 요청").toEqual([]);
    expect((await keyRow(h, "ork-A")).budgetUsd).toBe(4.5);
    expect((await keyRow(h, "ork-B")).budgetUsd).toBe(4);
  });
});

describe("TC-K2.T6.k 1분 분배는 오늘 창 하나만 부른다 (V15 의존)", () => {
  it("같은 날 두 번째 실행 → getAnalytics 1건(startDate 오늘 00:00:00.000Z, endDate now, apiKeyIds 없음). 회원 사용액 == usage_daily 이번 달 합 + 오늘 창", async () => {
    await writeSetting(h, CONFIRMED_KEY, "2026-04-09", new Date("2026-04-09T00:01:00Z"));
    await addMember(h, 5, [{ ork: "ork-A" }, { ork: "ork-B", state: "deleted" }]);
    const t = h.schema.usageDaily;
    const at = new Date("2026-04-09T00:01:00Z");
    await h.db.insert(t).values([
      { keyId: "ork-A", day: "2026-03-31", costUsd: 9, updatedAt: at },
      { keyId: "ork-A", day: "2026-04-03", costUsd: 1, updatedAt: at },
      { keyId: "ork-B", day: "2026-04-05", costUsd: 0.25, updatedAt: at },
    ]);
    // 기록: A 는 04-03 1 (저장됨) + 오늘 0.5, B 는 04-05 0.25. 어제(04-09)는 0
    const o = fakeOmni((q) => {
      if (q.start === "2026-04-10T00:00:00.000Z") return { "ork-A": 0.5 };
      if (q.start === "2026-04-01T00:00:00.000Z") return { "ork-A": 1, "ork-B": 0.25 };
      return {};
    });
    const lease = await acquireLease(h, "budget_rebalance", "node-a", 55_000, new Date("2026-04-10T00:01:00Z"));
    await rebalanceAll({ db: h, now: new Date("2026-04-10T00:01:00Z"), client: o.client, lease: lease! });
    expect(await readSetting(h, REBALANCE_MONTH_KEY), "실행 뒤 달 저장 (Q5)").toBe("2026-04");

    o.calls.length = 0;
    await rebalanceAll({ db: h, now: NOW, client: o.client });
    expect(o.of("getAnalytics")).toEqual([{ fn: "getAnalytics", apiKeyIds: undefined, start: "2026-04-10T00:00:00.000Z", end: NOW.toISOString() }]);
    // 사용액 = 저장 1 + 0.25 (이번 달) + 오늘 0.5 = 1.75 → 남은 3.25 → A 예산 1.5 + 3.25. 지난달 9 는 넣지 않는다
    expect((await keyRow(h, "ork-A")).budgetUsd).toBe(4.75);
  });
});
