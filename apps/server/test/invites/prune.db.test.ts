// 만료·취소한 초대 정리 (M3.T3) — Node 네 DB (pnpm test:db). 시각 비교(timestamp 칼럼)와 MySQL 파생 테이블 감싸기가 DB 마다 같은지 본다.
// D1 판은 prune.workers.test.ts. 문서 단언 "지움 2·남음 3" 에 차지 중·사용·취소·취소 29일 행을 더해 "지움 2·남음 6" 다 (prune-checks.ts).
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLease } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { INVITE_RETENTION_MS, pruneInvites } from "../../src/invites/prune.ts";
import { T3_NOW, t3aRows, type InviteRowMs } from "./prune-checks.ts";

const at = (ms: number | null) => (ms === null ? null : new Date(ms));
const values = (rows: InviteRowMs[], createdBy: string) =>
  rows.map((r) => ({ id: r.id, email: null, tokenHash: createHash("sha256").update(r.id).digest("hex"), role: "member", expiresAt: new Date(r.expiresAt), usedAt: at(r.usedAt), usedBy: r.usedBy, createdBy, revokedAt: at(r.revokedAt) }));

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

  it(`TC-M3.T3.a ${LABEL[kind]}: 만료 31일·만료 29일·취소 31일·사용됨 90일·유효 + 차지 중 31일·사용·취소·취소 29일(미사용·만료 미래) → 지움 2·남음 6, 임대를 잃으면 0행`, async () => {
    expect(INVITE_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);
    const inv = h.schema.invites;
    const { drop, keep } = t3aRows();
    await h.db.insert(inv).values(values([...Object.values(drop), ...Object.values(keep)], randomUUID()));
    const now = new Date(T3_NOW);
    const lease = await acquireLease(h, "omniroute_jobs", `a-${kind}`, 55_000, now);
    expect(lease).not.toBeNull();
    expect(await pruneInvites(h, now, { lease: lease! })).toBe(2);
    const left = (await h.db.select({ id: inv.id }).from(inv)).map((r: { id: string }) => r.id).sort();
    expect(left).toEqual(Object.values(keep).map((r) => r.id).sort());
    // 두 번째 실행은 지울 것이 없다
    expect(await pruneInvites(h, now, { lease: lease! })).toBe(0);
    // 임대를 다른 실행기가 가져간 뒤 옛 임대로 정리 → 0행 (펜싱)
    const later = new Date(T3_NOW + 60_000);
    const extra = t3aRows().drop.expired31;
    await h.db.insert(inv).values(values([extra], randomUUID()));
    expect(await acquireLease(h, "omniroute_jobs", `b-${kind}`, 55_000, later)).not.toBeNull();
    expect(await pruneInvites(h, later, { lease: lease! })).toBe(0);
    expect((await h.db.select({ id: inv.id }).from(inv)).map((r: { id: string }) => r.id)).toContain(extra.id);
    // 임대 없이(또는 새 임대로) 부르면 지운다
    expect(await pruneInvites(h, later)).toBe(1);
  });
});
