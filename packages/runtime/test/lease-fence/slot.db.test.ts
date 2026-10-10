// K1 리뷰 #6: 주기 경계 하나는 한 번만 돈다 (같은 holder 라도). runLeased 의 7번째 인자 slot = 경계 번호 (경계 시각 / 주기).
// K2 분배가 "경계마다 한 번"에 기댄다. pnpm test:db 로 네 DB.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLeased } from "../../src/lease.ts";
import { connectNode } from "../../src/node.ts";
import type { DbHandle } from "../../src/types.ts";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../dbs.ts";

const TTL = 55_000;

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let h: DbHandle;
  beforeAll(async () => {
    t = await createTestDb(kind);
    h = await connectNode(t.url);
  });
  afterAll(async () => {
    await h?.close();
    await t?.drop();
  });

  it(`TC-K1.T2.f ${LABEL[kind]}: 같은 경계 번호로 같은 holder 두 번 → 한 번만 돈다, 만료 뒤 다른 holder 도 그 경계는 못 돈다, 다음 경계는 돈다`, async () => {
    const ran: string[] = [];
    const job = (tag: string) => async () => void ran.push(tag);
    const t0 = Date.UTC(2026, 9, 1, 0, 1, 0);
    const slot = t0 / 60_000;
    expect(await runLeased(h, "k1_slot", "A", TTL, job("A1"), () => t0, slot)).toBe(true);
    // 같은 경계에서 같은 인스턴스의 타이머가 한 번 더 울렸다 (내 임대라 다시 잡히던 경우)
    expect(await runLeased(h, "k1_slot", "A", TTL, job("A2"), () => t0 + 1_000, slot)).toBe(false);
    // 임대가 만료된 뒤 깨어난 다른 인스턴스 (시계가 어긋나 같은 경계를 본다)
    expect(await runLeased(h, "k1_slot", "B", TTL, job("B1"), () => t0 + 56_000, slot)).toBe(false);
    // 다음 경계
    expect(await runLeased(h, "k1_slot", "B", TTL, job("B2"), () => t0 + 60_000, slot + 1)).toBe(true);
    expect(await runLeased(h, "k1_slot", "A", TTL, job("A3"), () => t0 + 120_000, slot + 2)).toBe(true);
    expect(ran).toEqual(["A1", "B2", "A3"]);
  });
});
