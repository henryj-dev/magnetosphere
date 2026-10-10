// K1.T3 실행기 둘이 같은 DB 의 작업 큐를 동시에 돈다 (pnpm test:db, 네 DB). 인스턴스 하나 = 연결 풀 하나.
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { ACTIONS, enqueue, runDue, type Handler, type Handlers } from "../../src/queue/index.ts";

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

  it(`TC-K1.T3.c ${LABEL[kind]}: 작업 20개, 실행기 둘 동시 runDue → 작업마다 핸들러 호출 정확히 1`, async () => {
    const now = new Date("2026-10-01T00:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await enqueue(a, "key.rollback", { keyId: `key-${i}`, omnirouteKeyId: `ork-${i}` }, { now }));
    const calls = new Map<string, string[]>();
    const runner = (name: string): Handlers => {
      const handler: Handler = async (_p, { job }) => {
        calls.set(job.id, [...(calls.get(job.id) ?? []), name]);
        // OmniRoute 호출 시간. 두 실행기의 select·차지가 실제로 겹치게 한다
        await sleep(5);
      };
      return Object.fromEntries(ACTIONS.map((act) => [act, handler])) as Handlers;
    };
    const [ra, rb] = await Promise.all([runDue(a, runner("A"), now), runDue(b, runner("B"), now)]);
    expect(ra.done + rb.done).toBe(20);
    expect(ids.map((id) => calls.get(id)?.length ?? 0)).toEqual(Array(20).fill(1));
    // 두 실행기가 실제로 나눠 돌았는지 (대조가 되려면 겹쳐야 한다)
    expect(ra.done, `A ${ra.done}·B ${rb.done}`).toBeGreaterThan(0);
    expect(rb.done, `A ${ra.done}·B ${rb.done}`).toBeGreaterThan(0);
  });
});
