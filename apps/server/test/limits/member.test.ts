// K2.T4 즉시 분배 진입점 (계획서 v5.7 5.3). SQLite 파일 DB, 가짜 어댑터·시계.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { CONFIRMED_KEY } from "../../src/limits/daily.ts";
import { rebalanceMember } from "../../src/limits/member.ts";
import { rebalanceAll } from "../../src/limits/rebalance.ts";
import { writeSetting } from "../../src/limits/store.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";
import { addMember, fakeOmni, keyRow } from "./fake.ts";

let env: TestEnv;
let h: DbHandle;
beforeEach(async () => {
  env = await makeTestEnv();
  h = await connectNode(env.env.DATABASE_URL);
  await writeSetting(h, CONFIRMED_KEY, "2026-04-10", new Date("2026-04-10T00:01:00Z"));
});
afterEach(async () => {
  await h.close();
  env.cleanup();
});

describe("TC-K2.T4.a 즉시 분배는 그 회원 키 전부(삭제 포함)로 분석한다", () => {
  it("회원 키 3(그중 삭제 1) → getAnalytics apiKeyIds 집합 == 세 id, 다른 회원 키 0, startDate == 오늘 00:00 UTC, 사용액 == storedSpent(세 id) + 오늘 값", async () => {
    const { userId } = await addMember(h, 5, [{ ork: "ork-A" }, { ork: "ork-B", state: "deleted" }, { ork: "ork-C" }]);
    await addMember(h, 5, [{ ork: "ork-Z" }]);
    await h.db.insert(h.schema.usageDaily).values([
      { keyId: "ork-B", day: "2026-04-02", costUsd: 2, updatedAt: new Date() },
      { keyId: "ork-Z", day: "2026-04-02", costUsd: 4, updatedAt: new Date() },
    ]);
    const now = new Date("2026-04-10T12:00:00.000Z");
    const o = fakeOmni(() => ({ "ork-A": 0.5, "ork-B": 0.5, "ork-C": 0, "ork-Z": 1 }));
    await rebalanceMember(h, userId, { now, client: o.client });
    const calls = o.of("getAnalytics");
    expect(calls).toHaveLength(1);
    expect([...(calls[0].apiKeyIds ?? [])].sort()).toEqual(["ork-A", "ork-B", "ork-C"]);
    expect({ start: calls[0].start, end: calls[0].end }).toEqual({ start: "2026-04-10T00:00:00.000Z", end: now.toISOString() });
    // 사용액 = 저장 2 (B) + 오늘 0.5 (A) + 0.5 (B) = 3 → 남은 2 → A 2.5, C 2. 다른 회원(Z) 키는 건드리지 않는다
    expect(o.of("setBudget").map((c) => [c.id, c.value])).toEqual([
      ["ork-A", 2.5],
      ["ork-C", 2],
    ]);
    expect((await keyRow(h, "ork-Z")).budgetUsd).toBeNull();
  });
});

describe("TC-K2.T4.b 즉시 분배와 1분 분배가 겹쳐도 옛 계산이 새 계산을 덮지 않는다", () => {
  it("즉시 분배(분석 시각 t2) 기록 뒤 늦게 끝난 1분 분배(분석 시각 t1 < t2)의 budget_usd 갱신 → 0행, setBudget 0건", async () => {
    const { userId } = await addMember(h, 5, [{ ork: "ork-A" }, { ork: "ork-B" }]);
    const t1 = new Date("2026-04-10T12:00:00.000Z");
    const t2 = new Date("2026-04-10T12:00:20.000Z");
    // t2 의 즉시 분배: B 가 새로 1 을 써 A 예산 4 (= 0 + 5 − 1)
    const now2 = fakeOmni(() => ({ "ork-A": 0, "ork-B": 1 }));
    await rebalanceMember(h, userId, { now: t2, client: now2.client });
    expect((await keyRow(h, "ork-A")).budgetUsd).toBe(4);
    // 그보다 먼저 분석(t1)했던 1분 분배가 늦게 끝난다: 옛 사용액(B 0)으로 A 예산 5 를 걸려 한다
    const old = fakeOmni(() => ({ "ork-A": 0, "ork-B": 0 }));
    const r = await rebalanceAll({ db: h, now: t1, client: old.client });
    expect(old.of("setBudget"), "옛 계산의 setBudget").toEqual([]);
    expect(r.stale).toBe(2);
    expect(await keyRow(h, "ork-A")).toMatchObject({ budgetUsd: 4, budgetAt: t2 });
    expect((await keyRow(h, "ork-B")).budgetUsd).toBe(5);
  });
});
