// K1.T2 임대 하트비트 (S4 보안 리뷰 L4). pnpm test:db 로 네 DB 에서 돈다 (scripts/test-db.mjs → MG_TEST_DBS).
// 인스턴스 하나 = 연결 풀 하나 (connectNode). 두 풀이 같은 DB 의 같은 임대를 다툰다.
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLease, runLeased } from "../../src/lease.ts";
import { connectNode } from "../../src/node.ts";
import type { DbHandle } from "../../src/types.ts";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../dbs.ts";

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
    const tries: unknown[] = [];
    let running = true;
    let started!: () => void;
    const jobStarted = new Promise<void>((r) => (started = r));
    // A 가 임대를 잡고 작업을 시작한 뒤부터 B 가 100ms 마다 같은 임대를 잡아 본다
    const rival = (async () => {
      await jobStarted;
      while (running) {
        await sleep(100);
        if (running) tries.push(await acquireLease(b, "heartbeat", "B", 300));
      }
    })();
    const ran = await runLeased(a, "heartbeat", "A", 300, async (signal) => {
      started();
      await sleep(1_500);
      expect(signal.aborted, "하트비트가 늘리는 동안 작업 신호는 살아 있다").toBe(false);
    });
    running = false;
    await rival;
    expect(ran).toBe(true);
    // 1,500ms 동안 100ms 마다 → 10번 이상 시도했어야 대조가 된다
    expect(tries.length).toBeGreaterThanOrEqual(10);
    expect(tries.filter(Boolean), "작업 중에 다른 holder 가 임대를 잡았다").toHaveLength(0);
  });
});
