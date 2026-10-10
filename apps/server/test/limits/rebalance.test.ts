// K2.T6 1분 분배 (계획서 v5.7 5.3). SQLite 파일 DB, 가짜 어댑터·시계. 실제 OmniRoute 는 test/contract/limits.
import { eq } from "drizzle-orm";
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

// ---- K2 리뷰 M2·L1·M3 ----

describe("TC-K2.T6.l 임대 안에 다 못 끝내는 회원 수도 두 tick 이면 모든 키가 새 달 예산(또는 꺼짐)을 받는다", () => {
  it("새 달 첫 실행, 회원 20(마지막 회원은 한도 초과). tick 마다 OmniRoute 변경 15건째에 임대를 잃는다 → 두 tick 뒤 켜진 키 19개 모두 4월 setBudget, 초과 회원 키 꺼짐, 둘째 tick 은 첫 tick 이 한 키를 다시 보내지 않는다", async () => {
    await writeSetting(h, CONFIRMED_KEY, "2026-04-01", new Date("2026-04-01T00:00:30Z"));
    await writeSetting(h, REBALANCE_MONTH_KEY, "2026-03", new Date("2026-03-31T23:59:00Z"));
    const orks: string[] = [];
    for (let i = 1; i <= 19; i++) {
      const ork = `ork-${String(i).padStart(2, "0")}`;
      orks.push(ork);
      // 지난달에 건 예산이 남아 있다 (OmniRoute 지출 카운터는 4월 1일에 0 이 됐다)
      await addMember(h, 10, [{ ork, budgetUsd: 10 }]);
    }
    await addMember(h, 1, [{ ork: "ork-over" }]);
    const tick = async (now: Date) => {
      const ac = new AbortController();
      let changes = 0;
      let t = 0;
      const o = fakeOmni(() => ({ "ork-over": 2 }), {
        onChange: () => {
          t += 1_000;
          if (++changes >= 15) {
            ac.abort(new Error("임대를 잃었다"));
            throw ac.signal.reason;
          }
        },
      });
      await rebalanceAll({ db: h, now, client: o.client, signal: ac.signal, clock: () => t, budgetMs: 12_000 });
      return o;
    };
    const first = await tick(new Date("2026-04-01T00:01:00Z"));
    expect(first.of("setKeyActive"), "초과 회원 끄기가 먼저").toEqual([{ fn: "setKeyActive", id: "ork-over", value: false }]);
    const second = await tick(new Date("2026-04-01T00:02:00Z"));
    const sentFirst = new Set(first.of("setBudget").map((c) => c.id));
    const sentSecond = second.of("setBudget").map((c) => c.id as string);
    expect(sentSecond.filter((id) => sentFirst.has(id)), "둘째 tick 이 다시 보낸 키").toEqual([]);
    expect([...sentFirst, ...sentSecond].sort()).toEqual(orks);
    expect(await keyRow(h, "ork-over")).toMatchObject({ state: "disabled", reason: "limit" });
  });
});

describe("TC-K2.T6.m 회원 하나의 예외가 다른 회원을 막지 않는다", () => {
  it("첫 회원 저장값이 깨짐(음수 비용) → 그 회원만 실패로 세고 alert.rebalance_failed 1행, 둘째 회원 키는 setBudget", async () => {
    await confirmedToday();
    const bad = await addMember(h, 5, [{ ork: "ork-bad" }]);
    await addMember(h, 5, [{ ork: "ork-ok" }]);
    await h.db.insert(h.schema.usageDaily).values({ keyId: "ork-bad", day: "2026-04-03", costUsd: -1, updatedAt: new Date() });
    const o = fakeOmni(() => ({}));
    const r = await rebalanceAll({ db: h, now: NOW, client: o.client });
    expect(o.of("setBudget").map((c) => c.id)).toEqual(["ork-ok"]);
    expect(r.failedMembers).toBe(1);
    const alerts = await h.db.select().from(h.schema.auditLog).where(eq(h.schema.auditLog.action, "alert.rebalance_failed"));
    expect(alerts.map((a: any) => JSON.parse(a.detail).userIds)).toEqual([[bad.userId]]);
  });
});

describe("TC-K2.T6.o 임대를 잃어 끊긴 setBudget 은 다음 실행이 다시 보낸다", () => {
  it("setBudget 도중 임대 상실 → budget_usd 는 비어 있다(NULL), 다음 실행이 같은 예산을 다시 setBudget", async () => {
    await confirmedToday();
    await writeSetting(h, REBALANCE_MONTH_KEY, "2026-04", NOW);
    await addMember(h, 5, [{ ork: "ork-A" }]);
    const ac = new AbortController();
    const lost = fakeOmni(() => ({}), {
      onChange: () => {
        ac.abort(new Error("임대를 잃었다"));
        throw ac.signal.reason;
      },
    });
    await expect(rebalanceAll({ db: h, now: NOW, client: lost.client, signal: ac.signal })).rejects.toThrow("임대를 잃었다");
    expect((await keyRow(h, "ork-A")).budgetUsd).toBeNull();
    const again = fakeOmni(() => ({}));
    await rebalanceAll({ db: h, now: new Date(NOW.getTime() + 60_000), client: again.client });
    expect(again.of("setBudget").map((c) => [c.id, c.value])).toEqual([["ork-A", 5]]);
    expect((await keyRow(h, "ork-A")).budgetUsd).toBe(5);
  });
});

describe("TC-K2.T6.p 무제한(NULL)으로 바뀐 회원의 옛 예산은 clearBudget 으로 푼다", () => {
  it("한도 NULL, 켜진 키 A(budget_usd 5)·limit 으로 꺼진 키 B(budget_usd 3) → A [clearBudget], B [clearBudget, setKeyActive(true)], 두 행 budget_usd NULL. 예산 없는 키는 부르지 않는다", async () => {
    await confirmedToday();
    await addMember(h, null, [{ ork: "ork-A", budgetUsd: 5 }, { ork: "ork-B", state: "disabled", reason: "limit", budgetUsd: 3 }, { ork: "ork-C" }]);
    const o = fakeOmni(() => ({ "ork-A": 50 }));
    await rebalanceAll({ db: h, now: NOW, client: o.client });
    const by = (id: string) => o.calls.filter((c) => c.id === id).map((c) => c.fn);
    expect([by("ork-A"), by("ork-B"), by("ork-C")]).toEqual([["clearBudget"], ["clearBudget", "setKeyActive"], []]);
    expect([(await keyRow(h, "ork-A")).budgetUsd, (await keyRow(h, "ork-B")).budgetUsd]).toEqual([null, null]);
    expect(await keyRow(h, "ork-B")).toMatchObject({ state: "active", reason: null });
  });
});

// ---- K2 재검토 H1·M-a·M-b·M-c·L-a ----

const setKey = (ork: string, set: Record<string, unknown>) => h.db.update(h.schema.apiKeys).set(set).where(eq(h.schema.apiKeys.omnirouteKeyId, ork));

describe("TC-K2.T6.t 늦게 도착한 clearBudget·setBudget 이 더 새 계산을 덮어도 다음 분배가 다시 건다 (재검토 H1)", () => {
  it("한도 NULL 분배(t1)의 clearBudget 도중 한도 10·즉시 분배(t2) setBudget → 늦은 clear 뒤 budget_usd·budget_month NULL, 다음 분배 setBudget(10). 반대 순서(늦은 setBudget 이 새 clear 를 덮음)도 다음 분배가 clearBudget", async () => {
    const { rebalanceMember } = await import("../../src/limits/member.ts");
    await confirmedToday();
    await writeSetting(h, REBALANCE_MONTH_KEY, "2026-04", NOW);
    const t1 = NOW;
    const t2 = new Date(NOW.getTime() + 5_000);
    const t3 = new Date(NOW.getTime() + 60_000);
    const { userId } = await addMember(h, null, [{ ork: "ork-A", budgetUsd: 5 }]);
    await setKey("ork-A", { budgetMonth: "2026-04", budgetAt: new Date(NOW.getTime() - 60_000) });
    const later = fakeOmni(() => ({}));
    const slow = fakeOmni(() => ({}), {
      onChange: async (c) => {
        if (c.fn !== "clearBudget") return;
        await h.db.update(h.schema.user).set({ monthlyLimitUsd: 10 }).where(eq(h.schema.user.id, userId));
        await rebalanceMember(h, userId, { now: t2, client: later.client });
      },
    });
    await rebalanceAll({ db: h, now: t1, client: slow.client });
    expect(later.of("setBudget").map((c) => c.value)).toEqual([10]);
    expect(await keyRow(h, "ork-A")).toMatchObject({ budgetUsd: null, budgetMonth: null });
    const next = fakeOmni(() => ({}));
    await rebalanceAll({ db: h, now: t3, client: next.client });
    expect(next.of("setBudget").map((c) => [c.id, c.value])).toEqual([["ork-A", 10]]);

    // 반대: 한도 10 분배(t4)의 setBudget 도중 한도 NULL·즉시 분배(t5) clearBudget → 늦은 setBudget 뒤 다음 분배가 clearBudget
    const t4 = new Date(NOW.getTime() + 120_000);
    const t5 = new Date(NOW.getTime() + 125_000);
    await setKey("ork-A", { budgetUsd: 9, budgetMonth: "2026-04" });
    const later2 = fakeOmni(() => ({}));
    const slow2 = fakeOmni(() => ({}), {
      onChange: async (c) => {
        if (c.fn !== "setBudget") return;
        await h.db.update(h.schema.user).set({ monthlyLimitUsd: null }).where(eq(h.schema.user.id, userId));
        await rebalanceMember(h, userId, { now: t5, client: later2.client });
      },
    });
    await rebalanceAll({ db: h, now: t4, client: slow2.client });
    expect(later2.of("clearBudget").length).toBe(1);
    const next2 = fakeOmni(() => ({}));
    await rebalanceAll({ db: h, now: new Date(NOW.getTime() + 180_000), client: next2.client });
    expect(next2.of("clearBudget").map((c) => c.id)).toEqual(["ork-A"]);
  });
});

describe("TC-K2.T6.u 예산 값을 모르는(NULL) 키도 무제한 전환 때 푼다 (재검토 M-a)", () => {
  it("한도 NULL, 키 budget_usd NULL·budget_month NULL·budget_at 있음(setBudget 실패 뒤) → clearBudget 1건, 다음 실행은 0건. 한 번도 예산을 건 적 없는 키(budget_at NULL)는 0건", async () => {
    await confirmedToday();
    await addMember(h, null, [{ ork: "ork-A" }, { ork: "ork-N" }]);
    await setKey("ork-A", { budgetAt: new Date("2026-04-10T11:00:00Z") });
    const o = fakeOmni(() => ({}));
    await rebalanceAll({ db: h, now: NOW, client: o.client });
    expect(o.of("clearBudget").map((c) => c.id)).toEqual(["ork-A"]);
    const again = fakeOmni(() => ({}));
    await rebalanceAll({ db: h, now: new Date(NOW.getTime() + 60_000), client: again.client });
    expect(again.of("clearBudget")).toEqual([]);
  });
});

describe("TC-K2.T6.q 매번 실패하는 회원이 앞에 있어도 두 tick 안에 뒤 회원이 새 달 예산을 받는다 (재검토 M-b)", () => {
  it("새 달, 첫 회원 키 3개가 setBudget 마다 15초 뒤 시간 초과, 뒤 회원 10 → 둘째 tick 이 뒤 회원 10명 모두 setBudget", async () => {
    await writeSetting(h, CONFIRMED_KEY, "2026-04-01", new Date("2026-04-01T00:00:30Z"));
    await writeSetting(h, REBALANCE_MONTH_KEY, "2026-03", new Date("2026-03-31T23:59:00Z"));
    await addMember(h, 10, [{ ork: "ork-f1", budgetUsd: 10 }, { ork: "ork-f2", budgetUsd: 10 }, { ork: "ork-f3", budgetUsd: 10 }]);
    const rest: string[] = [];
    for (let i = 0; i < 10; i++) {
      rest.push(`ork-r${i}`);
      await addMember(h, 10, [{ ork: `ork-r${i}`, budgetUsd: 10 }]);
    }
    const tick = async (now: Date) => {
      let t = 0;
      const o = fakeOmni(() => ({}), {
        onChange: (c) => {
          if (String(c.id).startsWith("ork-f")) {
            t += 15_000;
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          }
          t += 1_000;
        },
      });
      await rebalanceAll({ db: h, now, client: o.client, clock: () => t, budgetMs: 36_666 });
      return o;
    };
    await tick(new Date("2026-04-01T00:01:00Z"));
    const second = await tick(new Date("2026-04-01T00:02:00Z"));
    expect(second.of("setBudget").map((c) => c.id).filter((id) => String(id).startsWith("ork-r")).sort()).toEqual(rest.sort());
  });
});

describe("TC-K2.T6.r 계산이 깨진 회원은 키를 limit 으로 끄고, 같은 오류 알림은 하루 한 번 (재검토 M-c)", () => {
  it("음수 저장값 회원 → 첫 실행 setKeyActive(false)·limit, 같은 날 두 번 돌아도 alert.rebalance_failed 1행. 값이 고쳐지면 [setBudget, setKeyActive(true)]", async () => {
    await confirmedToday();
    await addMember(h, 5, [{ ork: "ork-x" }]);
    await addMember(h, 5, [{ ork: "ork-y" }]);
    await h.db.insert(h.schema.usageDaily).values({ keyId: "ork-x", day: "2026-04-03", costUsd: -1, updatedAt: new Date() });
    const first = fakeOmni(() => ({}));
    await rebalanceAll({ db: h, now: NOW, client: first.client });
    expect(first.calls.filter((c) => c.id === "ork-x").map((c) => [c.fn, c.value])).toEqual([["setKeyActive", false]]);
    expect(await keyRow(h, "ork-x")).toMatchObject({ state: "disabled", reason: "limit" });
    await rebalanceAll({ db: h, now: new Date(NOW.getTime() + 60_000), client: fakeOmni(() => ({})).client });
    const alerts = await h.db.select().from(h.schema.auditLog).where(eq(h.schema.auditLog.action, "alert.rebalance_failed"));
    expect(alerts).toHaveLength(1);
    await h.db.delete(h.schema.usageDaily).where(eq(h.schema.usageDaily.keyId, "ork-x"));
    const fixed = fakeOmni(() => ({}));
    await rebalanceAll({ db: h, now: new Date(NOW.getTime() + 120_000), client: fixed.client });
    expect(fixed.calls.filter((c) => c.id === "ork-x").map((c) => c.fn)).toEqual(["setBudget", "setKeyActive"]);
    expect(await keyRow(h, "ork-x")).toMatchObject({ state: "active", reason: null });
  });
});

describe("TC-K2.T6.s 분배가 연속 10번 실패하면 alert.rebalance_stalled 를 하루 한 번 (재검토 L-a)", () => {
  it("오늘 창 분석이 OmniRouteError → 9번째까지 0행, 10번째 1행, 12번째도 1행. 성공하면 연속 수가 0", async () => {
    const { OmniRouteError } = await import("@magnetosphere/omniroute");
    await confirmedToday();
    await addMember(h, 5, [{ ork: "ork-A" }]);
    let down = true;
    const o = fakeOmni(() => (down ? new OmniRouteError("GET", "analytics", 503, null, "down") : {}));
    const stalled = async () => (await h.db.select().from(h.schema.auditLog).where(eq(h.schema.auditLog.action, "alert.rebalance_stalled"))).length;
    for (let i = 1; i <= 12; i++) {
      await expect(rebalanceAll({ db: h, now: new Date(NOW.getTime() + i * 60_000), client: o.client })).rejects.toThrow(OmniRouteError);
      if (i === 9) expect(await stalled()).toBe(0);
      if (i === 10) expect(await stalled()).toBe(1);
    }
    expect(await stalled()).toBe(1);
    down = false;
    await rebalanceAll({ db: h, now: new Date(NOW.getTime() + 13 * 60_000), client: o.client });
    expect(await readSetting<{ count: number }>(h, "budget_rebalance_stalled")).toMatchObject({ count: 0 });
  });
});
