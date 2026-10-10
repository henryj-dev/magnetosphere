// K1.T2 하트비트 실패 (DB 없이). 늘리기가 실패하면 작업 신호가 끊기고, 신호를 넘긴 호출이 더 나가지 않는다.
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { holdLease, LeaseLostError } from "../../src/lease.ts";

describe("TC-K1.T2.c 하트비트 실패면 작업 신호가 끊기고 OmniRoute 호출이 멈춘다", () => {
  it("renewLease 가 false 를 돌려주는 가짜 DB + 가짜 fetch → signal.aborted true, 끊긴 뒤 fetch 호출 0건", async () => {
    // 가짜 DB: 처음 늘리기부터 0행 (다른 인스턴스가 잡아 fence 가 바뀐 경우)
    let renews = 0;
    const renew = async () => {
      renews++;
      return false;
    };
    // 가짜 fetch: 실제 fetch 처럼 끊긴 신호로 부르면 보내지 않고 신호의 이유로 실패한다. 실제로 보낸 시각만 남긴다
    const sent: number[] = [];
    let abortedAt = Infinity;
    const fakeFetch = async (_url: string, init: { signal: AbortSignal }) => {
      init.signal.throwIfAborted();
      sent.push(performance.now());
      await sleep(10);
      return new Response("{}");
    };
    let seen: AbortSignal | undefined;
    const lost = new LeaseLostError({ name: "budget_rebalance", holder: "A", fence: 3 });
    // 분배 루프 흉내: 키 100개에 setBudget. 신호를 fetch 에 넘기는 것 말고는 임대를 모른다
    const job = holdLease(renew, 90, async (signal) => {
      seen = signal;
      signal.addEventListener("abort", () => (abortedAt = performance.now()));
      for (let i = 0; i < 100; i++) await fakeFetch(`http://omniroute.test/setBudget/${i}`, { signal });
    }, () => lost);

    await expect(job).rejects.toBe(lost);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe(lost);
    expect(sent.length, "끊기 전에는 호출이 나갔다 (대조)").toBeGreaterThan(0);
    expect(sent.length, "100건 끝까지 돌았다").toBeLessThan(100);
    expect(sent.filter((at) => at >= abortedAt), "끊긴 뒤 나간 호출").toHaveLength(0);
    // 끊긴 뒤에는 하트비트도 멈춘다
    const after = renews;
    await sleep(200);
    expect(renews).toBe(after);
  });
});
