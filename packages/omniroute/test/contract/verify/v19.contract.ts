// 확인 19번: regenerate 의 id·누적 지출·예산 (2단계 실행판 K0.T9, TC-K0.T9.a, docs/verify/V19.json)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error 시험 도우미는 타입 선언이 없는 .mjs 다
import { isBudgetBlocked } from "../../../../../tests/contract/budget-block.mjs";
import { infer } from "../env.ts";
import { answerOf, around, eventually, newKey, open, raw, sleep, THREE_COST, threeRequests, type Session } from "./common.ts";

const answer = answerOf("V19");
let s: Session;
beforeAll(async () => {
  s = await open("contract-v19");
});
afterAll(async () => {
  await s.close();
});

describe("TC-K0.T9.a regenerate 뒤 관찰이 V19.json answer 와 같다 (V19 의존)", () => {
  it("월 예산 0.01 · 요청 3건 · 예산 차단 → regenerate → id·옛 원문 키·새 원문 키·누적 지출·예산 == answer", async () => {
    const k = await newKey(s, "v19");
    await s.client.setBudget(k.id, { monthlyUsd: 0.01 });
    expect(await threeRequests(k.key)).toEqual([200, 200, 200]);
    const blocked = await eventually(() => infer(k.key, "openai"), (r) => r.status !== 200);
    expect(isBudgetBlocked(blocked.status, blocked.json), JSON.stringify(blocked.json)).toBe(true);

    const rg = await raw(s, "POST", `/api/keys/${k.id}/regenerate`);
    expect(rg.status).toBe(200);
    const oldKey = await infer(k.key, "openai");
    const newKey_ = await infer(rg.json.key, "openai");
    await sleep(1_500);
    const a = await s.client.getAnalytics({ apiKeyIds: [k.id], ...around() });
    const budget = await raw(s, "GET", `/api/usage/budget?apiKeyId=${k.id}`);

    const observed = {
      sameId: rg.json.id === k.id,
      spendKept: Math.abs(a.totalCost - THREE_COST) < 1e-9,
      budgetKept: budget.json?.monthlyLimitUsd === 0.01,
      oldKeyStatus: oldKey.status,
      newKeyStatus: newKey_.status,
      newKeyBlocked: isBudgetBlocked(newKey_.status, newKey_.json),
      // regenerate 직후 옛 원문 키로 통과한 요청이 그 키 id 에 잡히는가 (예산 차단 중이라 잡히면 4건)
      oldKeyRequestsAttributed: a.totalRequests !== 3,
    };
    expect(observed).toEqual({
      sameId: answer.sameId,
      spendKept: answer.spendKept,
      budgetKept: answer.budgetKept,
      oldKeyStatus: answer.oldKeyStatus,
      newKeyStatus: answer.newKeyStatus,
      newKeyBlocked: answer.newKeyBlocked,
      oldKeyRequestsAttributed: answer.oldKeyRequestsAttributed,
    });
  });
});
