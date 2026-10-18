// TC-K1.T2.a 경쟁 루프 정리 (DB 없이, rival.ts). 작업이 던지거나 경쟁 쪽이 던져도 루프가 끝나고, 원래 예외가 그대로 남고,
// 처리되지 않은 거부가 생기지 않는다. 앞선 작업이 실패해 경쟁 루프가 close 뒤까지 남는 시나리오를 가짜 연결로 검증한다.
// 실제 CI 의 최초 실패는 UNKNOWN 이다 (이 시험은 그 원인을 재현해 확정하지 않는다).
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { raceWhileRunning } from "./rival.ts";

const EVERY = 5;
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => void unhandled.push(e);

/** 가짜 연결: close() 뒤에 부르면 libsql 처럼 CLIENT_CLOSED 로 거부한다 */
function fakeConn() {
  const c = {
    closed: false,
    calls: 0,
    callsAfterClose: 0,
    attempt: async (): Promise<null> => {
      if (c.closed) {
        c.callsAfterClose++;
        throw Object.assign(new Error("The client is closed"), { code: "CLIENT_CLOSED" });
      }
      c.calls++;
      return null;
    },
  };
  return c;
}

describe("TC-FOLLOWUP.Heartbeat 경쟁 루프는 작업이 어떻게 끝나든 멈추고 원래 예외를 남긴다", () => {
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("TC-FOLLOWUP.Heartbeat.a 작업이 시작 뒤 던지면 루프가 멈춘다 → close 뒤 attempt 0회, 원래 예외 그대로, 처리되지 않은 거부 0", async () => {
    const conn = fakeConn();
    const boom = new Error("하트비트가 늘리는 동안 작업 신호는 살아 있다");
    const race = await raceWhileRunning(
      async (started) => {
        started();
        await sleep(EVERY * 6);
        throw boom;
      },
      conn.attempt,
      EVERY,
    );
    // afterAll 이 연결을 닫는 자리를 흉내 낸다 (가짜 연결 시나리오). 루프가 아직 돌면 이 뒤의 attempt 가 CLIENT_CLOSED 로 거부된다
    conn.closed = true;
    await sleep(EVERY * 10);
    expect(race.jobFailure?.error).toBe(boom);
    expect(race.rivalFailure).toBeUndefined();
    expect(conn.calls).toBeGreaterThan(0);
    expect(conn.callsAfterClose).toBe(0);
    expect(unhandled).toHaveLength(0);
  });

  it("TC-FOLLOWUP.Heartbeat.b 작업 중 attempt 가 던지면 곧바로 받아 둔다 → 작업은 끝까지 돌고, 원래 예외 그대로, 처리되지 않은 거부 0", async () => {
    const lost = new Error("SQLITE_BUSY");
    let calls = 0;
    const race = await raceWhileRunning(
      async (started) => {
        started();
        // attempt 가 던진 뒤에도 한참 더 돈다. 그동안 거부가 처리되지 않은 채 남으면 unhandledRejection 이 난다
        await sleep(EVERY * 12);
        return true;
      },
      async () => {
        if (++calls === 2) throw lost;
        return null;
      },
      EVERY,
    );
    expect(race.ran).toBe(true);
    expect(race.jobFailure).toBeUndefined();
    expect(race.rivalFailure?.error).toBe(lost);
    // 던진 뒤로는 부르지 않는다
    expect(calls).toBe(2);
    expect(race.tries).toHaveLength(1);
    expect(unhandled).toHaveLength(0);
  });

  it("TC-FOLLOWUP.Heartbeat.c 작업이 시작을 알리지 않고 false 로 끝나면(임대 못 잡음) 기다리지 않고 끝난다 → attempt 0회", { timeout: 1_000 }, async () => {
    const conn = fakeConn();
    const race = await raceWhileRunning(async () => false, conn.attempt, EVERY);
    expect(race.ran).toBe(false);
    expect(race.tries).toHaveLength(0);
    expect(conn.calls).toBe(0);
    expect(unhandled).toHaveLength(0);
  });
});
