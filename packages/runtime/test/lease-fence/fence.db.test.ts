// K1.T2 펜싱 토큰 (S4 보안 리뷰 L4). pnpm test:db 로 네 DB 에서 돈다 (scripts/test-db.mjs → MG_TEST_DBS).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLease, fenced, renewLease, updatedRows, type Lease } from "../../src/lease.ts";
import { connectNode } from "../../src/node.ts";
import type { DbHandle } from "../../src/types.ts";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../dbs.ts";

const TTL = 1_000;

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

  /** 회원 하나와 키 하나. 펜싱 쓰기 대상 (api_keys.budget_usd) */
  async function keyRow(h: DbHandle): Promise<string> {
    const userId = randomUUID();
    const keyId = randomUUID();
    await h.db.insert(h.schema.user).values({ id: userId, name: "fence", email: `fence-${userId}@example.com` });
    await h.db.insert(h.schema.apiKeys).values({ id: keyId, userId, omnirouteKeyId: `ork-${keyId}`, keyPreview: "abcd", state: "active", createdAt: new Date() });
    return keyId;
  }
  const setBudget = (h: DbHandle, lease: Lease, keyId: string, usd: number) =>
    updatedRows(h, h.db.update(h.schema.apiKeys).set({ budgetUsd: usd }).where(and(eq(h.schema.apiKeys.id, keyId), fenced(h, lease))), h.schema.apiKeys.id);

  it(`TC-K1.T2.b ${LABEL[kind]}: A 가 fence n 으로 잡음 → 늘리지 않고 만료 → B 가 fence n+1 → A 의 fenced 갱신 0행, B 의 갱신 1행`, async () => {
    const keyId = await keyRow(a);
    const t0 = Date.now();
    const leaseA = await acquireLease(a, "budget_rebalance", "A", TTL, new Date(t0));
    expect(leaseA).not.toBeNull();
    // 대조: 임대가 살아 있을 때 A 의 펜싱 쓰기는 1행이다
    expect(await setBudget(a, leaseA!, keyId, 3)).toBe(1);
    // A 는 멈춰 늘리지 못했다. 만료 뒤 B 가 잡는다
    const leaseB = await acquireLease(b, "budget_rebalance", "B", TTL, new Date(t0 + 2 * TTL));
    expect(leaseB?.fence).toBe(leaseA!.fence + 1);

    expect(await setBudget(a, leaseA!, keyId, 7), "임대를 잃은 A 의 쓰기").toBe(0);
    expect(await setBudget(b, leaseB!, keyId, 5), "새 임대자 B 의 쓰기").toBe(1);
    expect(await renewLease(a, leaseA!, TTL, new Date(t0 + 2 * TTL)), "A 는 늘리지도 못한다").toBe(false);
    const [row] = await a.db.select({ budgetUsd: a.schema.apiKeys.budgetUsd }).from(a.schema.apiKeys).where(eq(a.schema.apiKeys.id, keyId));
    expect(Number(row.budgetUsd)).toBe(5);
  });

  it(`TC-K1.T2.d ${LABEL[kind]}: 같은 이름을 holder 바꿔 10번 잡음 → fence 10개가 엄격 증가`, async () => {
    const t0 = Date.now();
    const fences: number[] = [];
    for (let i = 0; i < 10; i++) {
      // 앞 임대가 만료된 뒤에 잡는다. 두 연결을 번갈아 써서 연결이 달라도 fence 를 바로 받는지 본다
      const lease = await acquireLease(i % 2 ? b : a, "reconcile-fence", `holder-${i}`, TTL, new Date(t0 + i * 2 * TTL));
      expect(lease, `${i}번째 잡기`).not.toBeNull();
      fences.push(lease!.fence);
    }
    expect(fences.every((f, i) => i === 0 || f > fences[i - 1]), `fence ${fences.join(",")}`).toBe(true);
    const [row] = await a.db.select({ fence: a.schema.jobLeases.fence, holder: a.schema.jobLeases.holder }).from(a.schema.jobLeases).where(eq(a.schema.jobLeases.name, "reconcile-fence"));
    expect({ fence: Number(row.fence), holder: row.holder }).toEqual({ fence: fences[9], holder: "holder-9" });
  });
});
