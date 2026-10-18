// K1.T2 임대 하트비트 (S4 보안 리뷰 L4). pnpm test:db 로 네 DB 에서 돈다 (scripts/test-db.mjs → MG_TEST_DBS).
// 인스턴스 하나 = 연결 풀 하나 (connectNode). 두 풀이 같은 DB 의 같은 임대를 다툰다.
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLease, runLeased } from "../../src/lease.ts";
import { connectNode } from "../../src/node.ts";
import type { DbHandle } from "../../src/types.ts";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../dbs.ts";
import { raceWhileRunning } from "./rival.ts";

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let a: DbHandle;
  let b: DbHandle;
  beforeAll(async () => {
    t = await createTestDb(kind);
    [a, b] = [await connectNode(t.url), await connectNode(t.url)];
  });
  afterAll(async () => {
    await Promise.all([a?.close(), b?.close()]);
    await t?.drop();
  });

  it(`TC-K1.T2.a ${LABEL[kind]}: ttl 300ms·작업 1,500ms 동안 다른 holder 가 100ms 마다 acquireLease → 성공 0회`, async () => {
    // A 가 임대를 잡고 작업을 시작한 뒤부터 B 가 100ms 마다 같은 임대를 잡아 본다.
    // A 가 던져도 B 의 루프는 여기서 멈추고 끝난다 (afterAll 이 b 를 닫은 뒤 B 가 돌지 않는다, rival.ts)
    const { ran, tries, jobFailure, rivalFailure } = await raceWhileRunning(
      (started) =>
        runLeased(a, "heartbeat", "A", 300, async (signal) => {
          started();
          await sleep(1_500);
          expect(signal.aborted, "하트비트가 늘리는 동안 작업 신호는 살아 있다").toBe(false);
        }),
      () => acquireLease(b, "heartbeat", "B", 300),
      100,
    );
    // 불변식을 먼저 본다. 다른 holder 가 잡았으면 A 의 하트비트 실패는 그 결과일 수 있어, 둘 다 드러나게 soft 로 남긴다
    expect.soft(tries.filter(Boolean), "작업 중에 다른 holder 가 임대를 잡았다").toHaveLength(0);
    // 그다음 원래 예외를 그대로 다시 던진다: A 의 작업(하트비트 단언·임대 잃음·DB 예외), B 의 시도
    if (jobFailure) throw jobFailure.error;
    if (rivalFailure) throw rivalFailure.error;
    expect(ran).toBe(true);
    // 1,500ms 동안 100ms 마다 → 10번 이상 시도했어야 대조가 된다
    expect(tries.length).toBeGreaterThanOrEqual(10);
  });
});
