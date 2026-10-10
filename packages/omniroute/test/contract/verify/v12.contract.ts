// 확인 12번: 키 그룹·쿼터 풀 공동 예산 (2단계 실행판 K0.T5, TC-K0.T5.a, docs/verify/V12.json)
// 쿼터 풀(연결 하나에 키를 배정)에 사용 금액 일정 예산을 걸면 배정된 키들의 소비를 합쳐 막는다.
// 시험은 풀 하나를 만들고 끝나면 지운다 (다른 계약 시험은 파일을 차례로 돌아 이 풀과 겹치지 않는다).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { infer } from "../env.ts";
import { answerOf, newKey, open, raw, sleep, type Session } from "./common.ts";

const answer = answerOf("V12");
let s: Session;
let poolId: string | null = null;
beforeAll(async () => {
  s = await open("contract-v12");
});
afterAll(async () => {
  if (poolId) await raw(s, "DELETE", `/api/quota/pools/${poolId}`);
  await s.close();
});

describe("TC-K0.T5.a V12 관찰이 V12.json answer 와 같다 (V12 의존)", () => {
  it("answer.api 존재, 후보 경로 404, 풀에 키 A·B 와 금액 예산 0.005 → A 2건·B 1건 뒤 A 다음 요청 차단 == sharedBlocking (풀 밖 키 C 는 통과)", async () => {
    expect((await raw(s, "GET", answer.api)).status).toBe(answer.exists ? 200 : 404);
    for (const p of answer.absentPaths as string[]) expect((await raw(s, "GET", p)).status, p).toBe(404);

    const conns = (await raw(s, "GET", "/api/providers")).json.connections as { id: string; name: string }[];
    const conn = conns.find((c) => c.name === "conn-mko");
    expect(conn).toBeDefined();
    const A = await newKey(s, "v12a");
    const B = await newKey(s, "v12b");
    const C = await newKey(s, "v12c");
    const pool = await raw(s, "POST", answer.api, {
      connectionId: conn!.id,
      name: `contract-v12-${Date.now().toString(36)}`,
      allocations: [A, B].map((k) => ({ apiKeyId: k.id, weight: 50, policy: "hard" })),
    });
    expect(pool.status, JSON.stringify(pool.json)).toBe(201);
    poolId = pool.json.pool.id;
    const sched = await raw(s, "PUT", `${answer.api}/${poolId}/schedules`, {
      schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440, budgetValue: 0.005, budgetUnit: "usd", budgetWindow: "monthly" }],
    });
    expect(sched.status, JSON.stringify(sched.json)).toBe(200);

    // A 2건(0.00442)은 A 혼자로는 예산 밑이다. B 1건을 더하면 풀 합계 0.00663 ≥ 0.005
    const statuses: number[] = [];
    for (const k of [A, A, B]) {
      statuses.push((await infer(k.key, "openai")).status);
      await sleep(300); // 소비 기록은 응답 뒤 다음 틱에 쌓인다
    }
    expect(statuses).toEqual([200, 200, 200]);
    await sleep(1_000);
    const next = await infer(A.key, "openai");
    const control = await infer(C.key, "openai");
    expect(control.status).toBe(200);
    expect(next.status !== 200).toBe(answer.sharedBlocking);
    // 3.8.51 arm64 빌드는 이 차단을 429 가 아니라 본문 없는 500 으로 낸다 (OmniRoute 로그 "[quotaShare] blocked … [schedule-budget]")
    expect(next.status === 429 || next.status === 500, `${next.status} ${next.body.slice(0, 200)}`).toBe(true);
  });
});
