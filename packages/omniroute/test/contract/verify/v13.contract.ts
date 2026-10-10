// 확인 13번: call-logs 를 키로 거르는 쿼리 (2단계 실행판 K0.T6, TC-K0.T6.a, docs/verify/V13.json)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { infer } from "../env.ts";
import { answerOf, eventually, newKey, open, raw, type Session } from "./common.ts";

const answer = answerOf("V13");
let s: Session;
beforeAll(async () => {
  s = await open("contract-v13");
});
afterAll(async () => {
  await s.close();
});

type Row = { apiKeyId: string | null; status: number; completed?: boolean | null; active?: boolean };

describe("TC-K0.T6.a V13 관찰이 V13.json answer 와 같다 (V13 의존)", () => {
  it("키 A 2건·키 B 1건 뒤 answer.param=A → 기록이 모두 A 이고 2건, 앞부분만 줘도 걸리는지 == !filtersExactly, 모르는 파라미터는 무시", async () => {
    const A = await newKey(s, "v13a");
    const B = await newKey(s, "v13b");
    for (const k of [A.key, A.key, B.key]) expect((await infer(k, "openai")).status).toBe(200);
    const get = async (q: string) => {
      const r = await raw(s, "GET", `/api/usage/call-logs?limit=50&${q}`);
      expect(r.status).toBe(200);
      return r.json as Row[];
    };

    expect(answer.param).not.toBeNull();
    const byA = await eventually(() => get(`${answer.param}=${A.id}`), (rows) => rows.length >= 2);
    expect(byA.map((r) => r.apiKeyId)).toEqual([A.id, A.id]);
    // 완료 기록만인가 (진행 중 줄은 status 0·active true)
    expect(byA.every((r) => r.status === 200 && r.active !== true)).toBe(answer.completedOnly);
    // 앞 8자리만 줘도 A 기록이 나오면 부분 일치다 (회원 키 id 가 다른 키 id·이름을 포함할 수는 없지만, 어댑터는 다시 정확히 거른다)
    const prefix = await get(`${answer.param}=${A.id.slice(0, 8)}`);
    expect(prefix.length === 2 && prefix.every((r) => r.apiKeyId === A.id)).toBe(!answer.filtersExactly);

    // 대조: 모르는 파라미터(apiKeyId)는 무시돼 B 기록까지 나온다 — 이 파라미터를 믿으면 다른 회원의 기록을 보여 준다
    const ignored = await get(`apiKeyId=${A.id}`);
    expect(ignored.some((r) => r.apiKeyId === B.id)).toBe(true);
  });
});
