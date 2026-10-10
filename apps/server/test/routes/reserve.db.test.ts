// K4 보안 리뷰 시험 보강: 자리 잡기 reserveSlot 을 HTTP·확인 없이 직접 10건 동시에 부른다 (pnpm test:db, 네 DB). D1 은 issue.workers.test.ts.
// 앞 확인(liveKeyCount)이 없어도 한 문장 조건·행 잠금만으로 최대 개수를 지키는지 본다.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { liveKeyCount, reserveSlot } from "../../src/routes/issue.ts";
import { addUser } from "./env.ts";

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

  it(`TC-K4.T1.l ${LABEL[kind]}: 연결 둘에서 reserveSlot 10건 동시 (최대 2) → true 정확히 2, 행 2. 재발급(옛 키 제외)도 넘지 않는다`, async () => {
    const u = await addUser(a, { maxKeys: 2 });
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => reserveSlot(i % 2 ? b : a, { id: randomUUID(), userId: u, label: null, createdAt: now }, 2)));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await liveKeyCount(a, u)).toBe(2);
    // 옛 키 하나를 빼고 세는 재발급 자리: 10건 중 하나만 (2 - 1 = 1 칸)
    const [old] = (await a.db.select({ id: a.schema.apiKeys.id }).from(a.schema.apiKeys)) as { id: string }[];
    const again = await Promise.all(Array.from({ length: 10 }, (_, i) => reserveSlot(i % 2 ? b : a, { id: randomUUID(), userId: u, label: null, createdAt: now }, 2, old.id)));
    expect(again.filter(Boolean)).toHaveLength(1);
    expect(await liveKeyCount(a, u)).toBe(3);
  });
});
