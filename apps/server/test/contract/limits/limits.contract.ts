// K2.T6·T7 한도 분배 계약 시험 (계획서 v5.7 5.3). 실제 OmniRoute(계약 환경)의 키·예산·분석으로 1분 분배 한 번을 돌린다.
// 저장소 최상위 pnpm test:contract -t "TC-K2.…" 가 계약 환경을 띄우고 이 파일을 돈다.
// 요청 비용: OpenAI 0.00221, Anthropic 0.0062115 (tests/contract/setup.mjs 가격). 3건(OpenAI·Anthropic·Anthropic 스트리밍) 0.014633.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CONFIRMED_KEY, confirmDays, coveredUntil, storedSpent } from "../../../src/limits/daily.ts";
import { dayStart, monthStart } from "../../../src/limits/month.ts";
import { rebalanceAll } from "../../../src/limits/rebalance.ts";
import { deleteSetting } from "../../../src/limits/store.ts";
import { addUser, blocked, infer, insertUsageCopies, isActive, issue, offRejected, OPENAI_COST, open, settled, THREE_COST, threeRequests, type Ctx } from "./env.ts";

let c: Ctx;
beforeEach(async () => {
  c = await open("contract-k2");
});
afterEach(async () => {
  await c.close();
});

const rebalance = () => rebalanceAll({ db: c.h, now: new Date(), client: c.limits });
const row = async (omniId: string) => {
  const k = c.h.schema.apiKeys;
  const [r] = await c.h.db.select().from(k).where(eq(k.omnirouteKeyId, omniId));
  return { state: r.state, reason: r.disabledReason, budgetUsd: r.budgetUsd == null ? null : Number(r.budgetUsd) };
};

describe("TC-K2.T6.d 두 키로 나눠 써 회원 한도에 닿으면 분배 뒤 두 키 모두 막힌다 (계약)", () => {
  it("한도 0.02, 키 A·B 각 3건(합 0.029266) → 분배 1회 → A·B 다음 요청 403. 대조: 한도 0.03 이면 A·B 예산 == 각 사용액 + 0.000734, 다음 요청 200", { timeout: 240_000 }, async () => {
    const u = await addUser(c, 0.02);
    const a = await issue(c, u);
    const b = await issue(c, u);
    expect([...(await threeRequests(a.key)), ...(await threeRequests(b.key))]).toEqual([200, 200, 200, 200, 200, 200]);
    await settled(c, [a.id, b.id], 6);
    await rebalance();
    const [na, nb] = [await infer(a.key), await infer(b.key)];
    expect([na.status, nb.status]).toEqual([403, 403]);
    expect([na.json?.error?.code, nb.json?.error?.code]).toEqual(["permission_denied", "permission_denied"]);

    // 대조: 남은 한도 0.03 − 0.029266 = 0.000734 > 0 이면 끄지 않고 예산으로 막는다
    const v = await addUser(c, 0.03);
    const x = await issue(c, v);
    const y = await issue(c, v);
    expect([...(await threeRequests(x.key)), ...(await threeRequests(y.key))]).toEqual([200, 200, 200, 200, 200, 200]);
    await settled(c, [x.id, y.id], 6);
    await rebalance();
    for (const id of [x.id, y.id]) expect(Math.abs(((await row(id)).budgetUsd ?? 0) - (THREE_COST + 0.000734))).toBeLessThan(1e-6);
    expect(c.calls.filter((k) => k.fn === "setBudget" && (k.id === x.id || k.id === y.id)).length).toBe(2);
    expect([(await infer(x.key)).status, (await infer(y.key)).status]).toEqual([200, 200]);
  });
});

describe("TC-K2.T6.e 삭제한 키의 사용액이 새 키의 남은 몫을 줄인다 (계약, V18 의존)", () => {
  it("한도 0.02, 키 A 3건(0.014633) → A 삭제 → 키 B 발급·분배 → B 예산 == 0.02 − 0.014633 (오차 1e-6)", { timeout: 240_000 }, async () => {
    const u = await addUser(c, 0.02);
    const a = await issue(c, u);
    expect(await threeRequests(a.key)).toEqual([200, 200, 200]);
    await settled(c, [a.id], 3);
    // 삭제 (계획서 5.2: 끄고 지운다. 매핑은 deleted 로 남긴다)
    await c.client.setKeyActive(a.id, false);
    await c.client.deleteKey(a.id);
    await c.h.db.update(c.h.schema.apiKeys).set({ state: "deleted", deletedAt: new Date() }).where(eq(c.h.schema.apiKeys.omnirouteKeyId, a.id));
    const b = await issue(c, u);
    await rebalance();
    expect(Math.abs(((await row(b.id)).budgetUsd ?? 0) - (0.02 - THREE_COST))).toBeLessThan(1e-6);
    expect(c.calls.filter((k) => k.fn === "setBudget").map((k) => k.id)).toEqual([b.id]);
  });
});

describe("TC-K2.T6.f 사용액 0 키도 회원 한도 도달 뒤 꺼진다 (계약, Q1 의존)", () => {
  it('한도 0.01, 키 A 3건 → 키 C(사용액 0) 분배 1회 → A·C 다음 요청 403 permission_denied, api_keys 두 행 disabled_reason "limit"', { timeout: 240_000 }, async () => {
    const u = await addUser(c, 0.01);
    const a = await issue(c, u);
    expect(await threeRequests(a.key)).toEqual([200, 200, 200]);
    const k = await issue(c, u);
    await settled(c, [a.id], 3);
    await rebalance();
    const ra = await infer(a.key);
    expect([ra.status, ra.json?.error?.code]).toEqual([403, "permission_denied"]);
    // C 는 한 번도 쓰지 않은 키라 꺼지면 401 AUTH_002 로 거부된다 (offRejected 주석). OmniRoute 에서 꺼졌는지는 listKeys 로 본다
    const rc = await infer(k.key);
    expect(offRejected(rc, false), `C 응답 ${rc.status} ${JSON.stringify(rc.json)}`).toBe(true);
    for (const key of [a, k]) {
      expect(await isActive(c, key.id)).toBe(false);
      expect(await row(key.id)).toMatchObject({ state: "disabled", reason: "limit" });
    }
  });
});

describe("TC-K2.T6.j 남은 한도가 다시 생기면 limit 으로 꺼진 키만 켠다 (계약, Q1 의존)", () => {
  it("f 뒤 회원이 직접 끈 키 D 추가 → 한도 0.05 로 올림 → 분배 1회 → A·C 다음 요청 200, D 403. 키마다 [setBudget, setKeyActive(true)]", { timeout: 240_000 }, async () => {
    const u = await addUser(c, 0.01);
    const a = await issue(c, u);
    expect(await threeRequests(a.key)).toEqual([200, 200, 200]);
    const k = await issue(c, u);
    await settled(c, [a.id], 3);
    await rebalance();
    expect([(await row(a.id)).reason, (await row(k.id)).reason]).toEqual(["limit", "limit"]);

    const d = await issue(c, u, { state: "disabled", reason: "member" });
    await c.h.db.update(c.h.schema.user).set({ monthlyLimitUsd: 0.05 }).where(eq(c.h.schema.user.id, u));
    c.calls.length = 0;
    await rebalance();
    expect([(await infer(a.key)).status, (await infer(k.key)).status]).toEqual([200, 200]);
    const rd = await infer(d.key);
    expect(offRejected(rd, false), `D 응답 ${rd.status} ${JSON.stringify(rd.json)}`).toBe(true);
    expect([await isActive(c, a.id), await isActive(c, k.id), await isActive(c, d.id)]).toEqual([true, true, false]);
    for (const key of [a, k]) {
      expect(c.calls.filter((x) => x.id === key.id).map((x) => [x.fn, x.value])).toEqual([
        ["setBudget", key === a ? 0.05 : 0.05 - THREE_COST],
        ["setKeyActive", true],
      ]);
      expect(await row(key.id)).toMatchObject({ state: "active", reason: null });
    }
    expect(c.calls.filter((x) => x.id === d.id)).toEqual([]);
    expect(await row(d.id)).toMatchObject({ state: "disabled", reason: "member" });
  });
});

describe("TC-K2.T6.g 초과 폭은 한도 × 동시에 쓰는 키 수 안이다 (계약)", () => {
  it("한도 0.02, 키 2개를 동시에 막힐 때까지(isBudgetBlocked 또는 403) 쓰기, 매 회차 분배 → 회원 총 사용액 ≤ 0.02 × 2 + 0.004878", { timeout: 300_000 }, async () => {
    const u = await addUser(c, 0.02);
    const a = await issue(c, u);
    const b = await issue(c, u);
    await rebalance();
    let ok = 0;
    const done = { a: false, b: false };
    for (let round = 0; round < 40 && !(done.a && done.b); round++) {
      const rs = await Promise.all([done.a ? null : infer(a.key), done.b ? null : infer(b.key)]);
      rs.forEach((r, i) => {
        if (!r) return;
        if (r.status === 200) ok++;
        else if (blocked(r)) done[i === 0 ? "a" : "b"] = true;
        else throw new Error(`예상하지 못한 응답 ${r.status} ${JSON.stringify(r.json)}`);
      });
      await rebalance();
    }
    expect(done).toEqual({ a: true, b: true });
    const total = (await settled(c, [a.id, b.id], ok)).totalCost;
    expect(Math.abs(total - ok * OPENAI_COST)).toBeLessThan(1e-9);
    expect(total).toBeLessThanOrEqual(0.02 * 2 + 0.004878);
  });
});

describe("TC-K2.T7.d 지난 날 합 + 오늘 == 분석 API 한 달 값이다 (계약, V15 의존)", () => {
  it("키 A·B 요청, A 에 어제 12:00 기록과 오늘 00:00:00.000(자정 정각) 기록을 더함 → confirmDays → storedSpent(이번 달 1일 ~ 오늘) + 오늘 창(자정 기록 포함) == 이번 달 1일 ~ 지금 (1e-9)", { timeout: 240_000 }, async () => {
    await deleteSetting(c.h, CONFIRMED_KEY);
    const u = await addUser(c, 5);
    const a = await issue(c, u);
    const b = await issue(c, u);
    expect([(await infer(a.key)).status, (await infer(a.key)).status, (await infer(b.key)).status]).toEqual([200, 200, 200]);
    await settled(c, [a.id, b.id], 3);
    const now = new Date();
    const today = dayStart(now);
    const yesterday = new Date(today.getTime() - 86_400_000 + 12 * 3_600_000);
    // 오늘이 1일이면 어제는 지난달이라 이번 달 저장 합에 들지 않는다. 그래도 자정 정각 기록은 오늘 창의 경계를 본다
    const sameMonth = yesterday.getUTCMonth() === now.getUTCMonth();
    const stamps = [today.toISOString(), ...(sameMonth ? [yesterday.toISOString()] : [])];
    expect(insertUsageCopies(a.id, stamps)).toBe(stamps.length);
    const ids = [a.id, b.id];
    const month = await settled(c, ids, 3 + stamps.length);

    const r = await confirmDays(c.h, now, c.limits);
    expect(r.confirmed).toBe(new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10));
    const covered = await coveredUntil(c.h, now);
    expect(covered.getTime()).toBe(today.getTime());
    const stored = await storedSpent(c.h, ids, monthStart(now), covered);
    const storedSum = [...stored.values()].reduce((s, v) => s + v, 0);
    const todayWindow = await c.client.getAnalytics({ apiKeyIds: ids, startDate: covered, endDate: new Date() });
    const monthNow = await c.client.getAnalytics({ apiKeyIds: ids, startDate: monthStart(now), endDate: new Date() });
    expect(Math.abs(monthNow.totalCost - month.totalCost)).toBeLessThan(1e-9);
    // 오늘 창: 실제 요청 3건 + 자정 정각 1건
    expect(todayWindow.totalRequests).toBe(4);
    expect(Math.abs(storedSum - (sameMonth ? OPENAI_COST : 0))).toBeLessThan(1e-9);
    expect(Math.abs(storedSum + todayWindow.totalCost - monthNow.totalCost)).toBeLessThan(1e-9);
  });
});

describe("TC-K2.T6.n 무제한으로 바뀐 회원의 옛 예산을 clearBudget 이 푼다 (계약, K2 리뷰 M3)", () => {
  it("한도 0.016, 키 A 3건 → 분배(예산 0.016) → 1건 200 → 다음 요청 예산 차단 → 한도 NULL → 분배 → [clearBudget] → 다음 요청 200", { timeout: 240_000 }, async () => {
    const u = await addUser(c, 0.016);
    const a = await issue(c, u);
    expect(await threeRequests(a.key)).toEqual([200, 200, 200]);
    await settled(c, [a.id], 3);
    await rebalance();
    expect(Math.abs(((await row(a.id)).budgetUsd ?? 0) - 0.016)).toBeLessThan(1e-6);
    expect((await infer(a.key)).status).toBe(200);
    const over = await infer(a.key);
    expect(blocked(over) && over.status === 429, `예산 차단 기대, 받은 응답 ${over.status} ${JSON.stringify(over.json)}`).toBe(true);
    await c.h.db.update(c.h.schema.user).set({ monthlyLimitUsd: null }).where(eq(c.h.schema.user.id, u));
    c.calls.length = 0;
    await rebalance();
    expect(c.calls.map((x) => [x.fn, x.id])).toEqual([["clearBudget", a.id]]);
    expect((await row(a.id)).budgetUsd).toBeNull();
    expect((await infer(a.key)).status).toBe(200);
  });
});
