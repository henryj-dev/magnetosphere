// 확인 18번: 삭제한 키의 기록이 분석에 남는가 (2단계 실행판 K0.T8, TC-K0.T8.a, docs/verify/V18.json)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { infer } from "../env.ts";
import { answerOf, around, eventually, newKey, open, raw, sleep, THREE_COST, threeRequests, type Session } from "./common.ts";

const answer = answerOf("V18");
let s: Session;
beforeAll(async () => {
  s = await open("contract-v18");
});
afterAll(async () => {
  await s.close();
});

describe("TC-K0.T8.a 삭제한 키의 비용이 그 키 id 분석에 그대로 잡힌다 (V18 의존)", () => {
  it("요청 3건 → deleteKey → apiKeyIds=[삭제한 id]·byApiKey == V18 answer, 삭제 직후 원문 키·끈 뒤 캐시 시간이 지난 삭제 == answer", { timeout: 150_000 }, async () => {
    const k = await newKey(s, "v18");
    expect(await threeRequests(k.key)).toEqual([200, 200, 200]);
    await eventually(() => s.client.getAnalytics({ apiKeyIds: [k.id], ...around() }), (a) => a.totalRequests === 3);
    await s.client.deleteKey(k.id);

    // 삭제 직후 옛 원문 키 (3.8.51: 키 검증 캐시가 남아 있는 동안 통과하고, 그 요청은 키 id 없이 기록된다)
    const after = await infer(k.key, "openai");
    expect(after.status).toBe(answer.rawKeyAfterDelete);
    await sleep(1_500);

    const a = await s.client.getAnalytics({ apiKeyIds: [k.id], ...around() });
    const deletedKeyCounted = Math.abs(a.totalCost - THREE_COST) < 1e-9;
    expect(deletedKeyCounted).toBe(answer.deletedKeyCounted);
    expect(Math.abs(a.totalCost - answer.totalCost)).toBeLessThan(1e-9);
    // 삭제 뒤 옛 원문 키로 통과한 요청이 그 키 id 에 잡히는가
    expect(a.totalRequests === 4).toBe(answer.graceRequestsAttributed);

    const { startDate, endDate } = around();
    const all = await raw(s, "GET", `/api/usage/analytics?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`);
    expect(all.status).toBe(200);
    expect(all.json.byApiKey.some((x: { apiKeyId: string }) => x.apiKeyId === k.id)).toBe(answer.byApiKeyIncludesDeleted);

    // 끄고 키 검증 캐시 시간이 지난 뒤 지우면 옛 원문 키는 바로 거부된다 (계획서 v5.6 5.2 삭제 순서의 근거)
    const k2 = await newKey(s, "v18-off");
    expect((await infer(k2.key, "openai")).status).toBe(200);
    await s.client.setKeyActive(k2.id, false);
    expect((await infer(k2.key, "openai")).status).toBe(403);
    await sleep(answer.keyCacheTtlMs + 5_000);
    await s.client.deleteKey(k2.id);
    expect((await infer(k2.key, "openai")).status).toBe(answer.rawKeyAfterOffWaitDelete);
  });
});
