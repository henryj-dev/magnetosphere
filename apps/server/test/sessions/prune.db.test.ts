// TC-M6.T5.f 세션 주기 정리 (M6 후속 L1, Node DB 넷). pnpm -C apps/server test:db -t "TC-M6.T5.f" --db sqlite,mysql,mariadb,pg
// 지움: 만료(expires_at < now)·삭제 회원(status = 'deleted')의 세션. 남음: 유효·먼 미래·정지 회원의 유효 세션·만료 시각이 정확히 now.
// 한 번에 PRUNE_BATCH(500)행까지 만료 시각 오래된 것부터 지우고, 임대를 잃으면 0행이다. 새 cron 없이 1분 queueJob 에서 돈다.
// 세션 token 은 무작위 값이며 실패 출력에는 id 만 쓴다.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLease } from "@magnetosphere/runtime/lease";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle, Runtime } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { PRUNE_BATCH } from "../../src/queue/index.ts";
import { queueJob } from "../../src/queue/runner.ts";
import { pruneSessions } from "../../src/sessions/prune.ts";

const NOW = new Date("2026-10-13T00:00:00.000Z").getTime();
const MIN = 60_000;
const DAY = 86_400_000;

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let h: DbHandle;
  beforeEach(async () => {
    t = await createTestDb(kind);
    h = await connectNode(t.url);
  });
  afterEach(async () => {
    await h?.close();
    await t?.drop();
  });

  const users = async (base: number) => {
    const ids = { active: randomUUID(), suspended: randomUUID(), deleted: randomUUID() };
    const at = new Date(base);
    await h.db.insert(h.schema.user).values([
      { id: ids.active, name: "active", email: `active-${ids.active}@example.com`, emailVerified: true, role: "member", status: "active", createdAt: at, updatedAt: at },
      { id: ids.suspended, name: "suspended", email: `suspended-${ids.suspended}@example.com`, emailVerified: true, role: "member", status: "suspended", createdAt: at, updatedAt: at },
      { id: ids.deleted, name: "", email: `deleted-${ids.deleted}@invalid`, emailVerified: true, role: "member", status: "deleted", createdAt: at, updatedAt: at },
    ]);
    return ids;
  };
  const sessions = async (rows: { id: string; userId: string; expiresAt: number }[], base: number) => {
    const at = new Date(base);
    for (let i = 0; i < rows.length; i += 100) {
      await h.db.insert(h.schema.session).values(rows.slice(i, i + 100).map((r) => ({ id: r.id, token: randomUUID(), userId: r.userId, expiresAt: new Date(r.expiresAt), createdAt: at, updatedAt: at })));
    }
  };
  const sorted = (ids: string[]) => [...ids].sort();
  // DB 마다 문자열 정렬 규칙(collation)이 달라 JS 에서 정렬한다
  const left = async () => sorted((await h.db.select({ id: h.schema.session.id }).from(h.schema.session)).map((r: { id: string }) => r.id));

  it(`TC-M6.T5.f ${LABEL[kind]}: 만료·삭제 회원 세션만 지우고 유효·미래·정지 회원·정확히 now 는 남기며, 임대를 잃으면 0행이다`, async () => {
    const u = await users(NOW);
    const drop = { expired: `s-expired-${kind}`, expiredLong: `s-expired-long-${kind}`, deletedValid: `s-deleted-valid-${kind}`, deletedExpired: `s-deleted-expired-${kind}` };
    const keep = { valid: `s-valid-${kind}`, future: `s-future-${kind}`, suspendedValid: `s-suspended-valid-${kind}`, exactlyNow: `s-now-${kind}` };
    await sessions([
      { id: drop.expired, userId: u.active, expiresAt: NOW - MIN },
      { id: drop.expiredLong, userId: u.suspended, expiresAt: NOW - 90 * DAY },
      { id: drop.deletedValid, userId: u.deleted, expiresAt: NOW + DAY },
      { id: drop.deletedExpired, userId: u.deleted, expiresAt: NOW - DAY },
      { id: keep.valid, userId: u.active, expiresAt: NOW + MIN },
      { id: keep.future, userId: u.active, expiresAt: NOW + 30 * DAY },
      { id: keep.suspendedValid, userId: u.suspended, expiresAt: NOW + DAY },
      { id: keep.exactlyNow, userId: u.active, expiresAt: NOW },
    ], NOW);
    const now = new Date(NOW);
    const lease = await acquireLease(h, "omniroute_jobs", `m6-a-${kind}`, 55_000, now);
    expect(lease).not.toBeNull();
    expect(await pruneSessions(h, now, { lease: lease! })).toBe(4);
    expect(await left()).toEqual(sorted(Object.values(keep)));
    // 두 번째 실행은 지울 것이 없다
    expect(await pruneSessions(h, now, { lease: lease! })).toBe(0);
    // 다른 실행기가 임대를 가져간 뒤 옛 임대로 정리 → 0행 (펜싱)
    const later = new Date(NOW + MIN + 1);
    const extra = `s-extra-${kind}`;
    await sessions([{ id: extra, userId: u.deleted, expiresAt: NOW + DAY }], NOW);
    expect(await acquireLease(h, "omniroute_jobs", `m6-b-${kind}`, 55_000, later)).not.toBeNull();
    expect(await pruneSessions(h, later, { lease: lease! })).toBe(0);
    expect(await left()).toContain(extra);
    // 임대 없이 부르면 later 기준으로 다시 고른다: extra(삭제 회원)·keep.valid·keep.exactlyNow(만료)를 지운다
    expect(await pruneSessions(h, later)).toBe(3);
    expect(await left()).toEqual(sorted([keep.future, keep.suspendedValid]));
  });

  it(`TC-M6.T5.f ${LABEL[kind]}: 한 번에 ${PRUNE_BATCH}행까지 만료 시각 오래된 것부터 지운다 (600행 → 500·100·0)`, async () => {
    expect(PRUNE_BATCH).toBe(500);
    const u = await users(NOW);
    // 만료 시각이 모두 다르다. 가장 오래된 500행이 먼저 지워지고 최근 100행이 남는다
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: `s-batch-${kind}-${String(i).padStart(4, "0")}`, userId: u.active, expiresAt: NOW - (600 - i) * MIN }));
    const valid = `s-batch-valid-${kind}`;
    await sessions([...rows, { id: valid, userId: u.active, expiresAt: NOW + DAY }], NOW);
    const now = new Date(NOW);
    expect(await pruneSessions(h, now)).toBe(500);
    expect(await left()).toEqual(sorted([...rows.slice(500).map((r) => r.id), valid]));
    expect(await pruneSessions(h, now)).toBe(100);
    expect(await pruneSessions(h, now)).toBe(0);
    expect(await left()).toEqual([valid]);
  });

  it(`TC-M6.T5.f ${LABEL[kind]}: OmniRoute 연결 없이 실제 queueJob 한 번 → 만료·삭제 회원 세션만 지운다`, async () => {
    // queueJob 은 실제 시각을 쓴다. 행을 지금 기준으로 만든다
    const base = Date.now();
    const u = await users(base);
    const drop = [`s-job-expired-${kind}`, `s-job-deleted-${kind}`];
    const keep = [`s-job-valid-${kind}`, `s-job-suspended-${kind}`];
    await sessions([
      { id: drop[0], userId: u.active, expiresAt: base - DAY },
      { id: drop[1], userId: u.deleted, expiresAt: base + DAY },
      { id: keep[0], userId: u.active, expiresAt: base + DAY },
      { id: keep[1], userId: u.suspended, expiresAt: base + DAY },
    ], base);
    const lease = await acquireLease(h, "omniroute_jobs", `m6-job-${kind}`, 55_000);
    expect(lease).not.toBeNull();
    const rt = { secret: () => undefined } as unknown as Runtime;
    await queueJob(rt)({ db: h, lease: lease!, signal: new AbortController().signal });
    expect(await left()).toEqual(sorted(keep));
  });
});
