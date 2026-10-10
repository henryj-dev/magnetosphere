// 확인 20번: 월 예산 시간대·초기화·달 중간 변경 (2단계 실행판 K0.T10, TC-K0.T10.a~c, docs/verify/V20.json)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error 시험 도우미는 타입 선언이 없는 .mjs 다
import { isBudgetBlocked } from "../../../../../tests/contract/budget-block.mjs";
import { infer } from "../env.ts";
import { answerOf, around, eventually, newKey, ONE_OPENAI_COST, open, raw, threeRequests, type Session } from "./common.ts";

const answer = answerOf("V20");
let s: Session;
beforeAll(async () => {
  s = await open("contract-v20");
});
afterAll(async () => {
  await s.close();
});

/** 다음 요청이 예산 차단인지 (차단이 아니면 200 이어야 한다) */
async function nextBlocked(key: string): Promise<boolean> {
  const r = await infer(key, "openai");
  if (r.status !== 200) expect(isBudgetBlocked(r.status, r.json), `${r.status} ${JSON.stringify(r.json)}`).toBe(true);
  return r.status !== 200;
}

describe("TC-K0.T10.a 달 중간에 예산을 올리고 내리면 다음 요청부터 바뀐다 (V20 의존)", () => {
  it("월 예산 0.01 · 요청 3건(0.014633) 뒤 차단 → 1.0 으로 올림 → 다음 요청 == raiseUnblocks, 다시 0.01 → == lowerBlocks", async () => {
    const k = await newKey(s, "v20a");
    await s.client.setBudget(k.id, { monthlyUsd: 0.01 });
    expect(await threeRequests(k.key)).toEqual([200, 200, 200]);
    expect(await eventually(() => nextBlocked(k.key), (b) => b)).toBe(true);
    await s.client.setBudget(k.id, { monthlyUsd: 1.0 });
    expect(!(await nextBlocked(k.key))).toBe(answer.raiseUnblocks);
    await s.client.setBudget(k.id, { monthlyUsd: 0.01 });
    expect(await nextBlocked(k.key)).toBe(answer.lowerBlocks);
  });
});

describe("TC-K0.T10.b 예산 == 사용액이면 막히는가 (V20 의존)", () => {
  // 실행판은 요청 3건의 비용을 예산으로 걸라고 적었지만, OmniRoute 는 요청마다 비용을 더한 부동소수 합(0.014633000000000004)으로
  // 비교해 분석 비용(0.014633)을 걸면 '같음'이 아니라 '넘음'이 된다. 비용 하나(0.00221)는 더하기 오차가 없어 같음을 그대로 본다
  it("요청 1건 뒤 그 키 분석 비용 c(0.00221)를 예산으로 → 다음 요청이 예산 차단인지 == equalBlocks, 그다음 요청은 차단", async () => {
    const k = await newKey(s, "v20b");
    expect((await infer(k.key, "openai")).status).toBe(200);
    const a = await eventually(() => s.client.getAnalytics({ apiKeyIds: [k.id], ...around() }), (x) => x.totalRequests === 1);
    expect(Math.abs(a.totalCost - ONE_OPENAI_COST)).toBeLessThan(1e-9);
    await s.client.setBudget(k.id, { monthlyUsd: a.totalCost });
    expect(await nextBlocked(k.key)).toBe(answer.equalBlocks);
    // 같음에서 통과한 요청 뒤에는 사용액 > 예산이라 막힌다 (대조)
    expect(await nextBlocked(k.key)).toBe(true);
  });
});

describe("TC-K0.T10.c 기간 시작 시각이 answer.timezone 기준이다 (V20 의존)", () => {
  it("예산 조회 응답의 periodStartAt·nextResetAt == answer.timezone 의 이번 달·다음 달 1일 00:00, 예산 0 은 무제한 == zeroIsUnlimited", async () => {
    expect(answer.timezone).toBe("UTC"); // 다른 시간대가 되면 아래 계산을 그 시간대로 바꾼다
    const k = await newKey(s, "v20c");
    await s.client.setBudget(k.id, { monthlyUsd: 1.0 });
    const b = await raw(s, "GET", `/api/usage/budget?apiKeyId=${k.id}`);
    expect(b.status).toBe(200);
    const now = new Date();
    expect(b.json.resetTime).toBe(answer.resetTime);
    expect(b.json.periodStartAt).toBe(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    expect(b.json.nextResetAt).toBe(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    // 예산 0 (어댑터는 보내지 않는다, TC-S5.T2.j) → 사용액이 있어도 차단하지 않는다
    expect((await infer(k.key, "openai")).status).toBe(200);
    const zero = await raw(s, "POST", "/api/usage/budget", { apiKeyId: k.id, dailyLimitUsd: 0, weeklyLimitUsd: 0, monthlyLimitUsd: 0, resetInterval: "monthly" });
    expect(zero.status).toBe(200);
    const check = await raw(s, "GET", `/api/usage/budget?apiKeyId=${k.id}`);
    expect(check.json.budgetCheck.allowed === true && check.json.activeLimitUsd === 0).toBe(answer.zeroIsUnlimited);
  });
});
