// 만료·취소한 초대 정리 (M3.T3) — SQLite 파일 DB (pnpm test). 한 번에 PRUNE_BATCH(500)행까지만 지운다 (pruneDone 과 같은 경계).
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { pruneInvites } from "../../src/invites/prune.ts";
import { PRUNE_BATCH } from "../../src/queue/index.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";
import { oldRows, T3_NOW } from "./prune-checks.ts";

let t: TestEnv;
let h: DbHandle;
beforeEach(async () => {
  t = await makeTestEnv();
  h = await connectNode(t.env.DATABASE_URL);
});
afterEach(async () => {
  await h?.close();
  t?.cleanup();
});

describe("TC-M3.T3 만료·취소한 초대 정리", () => {
  it("TC-M3.T3.b 한 번에 최대 500행만 지운다 — 501행이면 500 → 1 → 0", async () => {
    expect(PRUNE_BATCH).toBe(500);
    const createdBy = randomUUID();
    const rows = oldRows(501).map((r) => ({ id: r.id, email: null, tokenHash: createHash("sha256").update(r.id).digest("hex"), role: "member", expiresAt: new Date(r.expiresAt), usedAt: null, usedBy: null, createdBy, revokedAt: null }));
    for (let i = 0; i < rows.length; i += 100) await h.db.insert(h.schema.invites).values(rows.slice(i, i + 100));
    const now = new Date(T3_NOW);
    expect(await pruneInvites(h, now)).toBe(500);
    expect(await pruneInvites(h, now)).toBe(1);
    expect(await pruneInvites(h, now)).toBe(0);
    expect(await h.db.select().from(h.schema.invites)).toHaveLength(0);
  });
});
