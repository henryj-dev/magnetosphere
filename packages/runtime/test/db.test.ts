// 런타임 어댑터 DB TC (pnpm test:db). DB 는 --db 로 고른다 (scripts/test-db.mjs → MG_TEST_DBS).
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireLease } from "../src/lease.ts";
import { createNodeRuntime, type NodeRuntime } from "../src/node.ts";
import type { DbHandle } from "../src/types.ts";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "./dbs.ts";

const MINUTE = 60_000;

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  const runtimes: NodeRuntime[] = [];
  /** 인스턴스 하나 = 런타임 하나 = 풀 하나 */
  const instance = async (): Promise<DbHandle> => {
    const rt = createNodeRuntime({ env: { DATABASE_URL: t.url } });
    runtimes.push(rt);
    return rt.db();
  };

  beforeAll(async () => {
    t = await createTestDb(kind);
  });
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((rt) => rt.close()));
  });
  afterAll(async () => {
    await t?.drop();
  });

  describe("TC-S4.T1.a job_leases 임대는 동시에 한 인스턴스만 잡는다", () => {
    it(`${LABEL[kind]}: 두 연결이 같은 이름을 동시에 임대 → 정확히 하나 성공 (빈 행·만료 행 각각 20번)`, async () => {
      const [a, b] = [await instance(), await instance()];
      const past = new Date(Date.now() - MINUTE);
      for (let i = 0; i < 20; i++) {
        // 행이 없을 때 (INSERT 경쟁)
        const fresh = await Promise.all([acquireLease(a, `fresh-${i}`, "A", MINUTE), acquireLease(b, `fresh-${i}`, "B", MINUTE)]);
        expect(fresh.filter(Boolean)).toHaveLength(1);
        // 만료된 행이 있을 때 (UPDATE 경쟁)
        await a.db.insert(a.schema.jobLeases).values({ name: `expired-${i}`, holder: "dead", lockedUntil: past });
        const expired = await Promise.all([acquireLease(a, `expired-${i}`, "A", MINUTE), acquireLease(b, `expired-${i}`, "B", MINUTE)]);
        expect(expired.filter(Boolean)).toHaveLength(1);
      }
      // 잡은 쪽이 아닌 인스턴스는 만료 전까지 다시 못 잡는다
      const [row] = await a.db.select().from(a.schema.jobLeases).where(eq(a.schema.jobLeases.name, "fresh-0"));
      const other = row.holder === "A" ? { h: b, id: "B" } : { h: a, id: "A" };
      expect(await acquireLease(other.h, "fresh-0", other.id, MINUTE)).toBe(false);
    });
  });

  describe("TC-S4.T1.b 임대 만료 후에는 다른 인스턴스가 잡는다", () => {
    it(`${LABEL[kind]}: locked_until 이 지난 임대 → 다른 holder 성공, 지나지 않은 임대 → 실패`, async () => {
      const h = await instance();
      const now = new Date();
      expect(await acquireLease(h, "reconcile", "dead", MINUTE, new Date(now.getTime() - 2 * MINUTE))).toBe(true);
      // dead 의 임대는 now - 1분에 끝났다
      expect(await acquireLease(h, "reconcile", "alive", MINUTE, now)).toBe(true);
      const [row] = await h.db.select().from(h.schema.jobLeases).where(eq(h.schema.jobLeases.name, "reconcile"));
      expect(row.holder).toBe("alive");
      // alive 의 임대는 아직 살아 있다
      expect(await acquireLease(h, "reconcile", "third", MINUTE, now)).toBe(false);
    });
  });

  // SQLite 는 시각을 정수(unixepoch)로 둬 세션 시간대가 없다
  if (kind !== "sqlite") describe("TC-S4.T1.d DB 연결이 세션 시간대를 UTC 로 강제한다", () => {
    it(`${LABEL[kind]}: 서버 시간대가 UTC 가 아니어도 created_at 기본값이 행을 만든 시각과 1초 안`, async () => {
      await t.setNonUtcTimeZone();
      // 대조: 런타임을 거치지 않은 연결은 UTC 가 아닌 시간대로 시작하고, created_at 이 9시간 어긋난다
      expect(["+09:00", "Asia/Seoul"]).toContain(await t.rawSessionTimeZone());
      const rawAt = Date.now();
      const raw = await t.rawInsertUserCreatedAt("tz-raw");
      expect(Math.abs(raw.getTime() - rawAt)).toBeGreaterThan(8 * 3600_000);

      const h = await instance();
      const before = Date.now();
      await h.db.insert(h.schema.user).values({ id: "tz-runtime", name: "tz", email: "tz-runtime@example.com" });
      const [row] = await h.db.select().from(h.schema.user).where(eq(h.schema.user.id, "tz-runtime"));
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(Math.abs(row.createdAt.getTime() - before)).toBeLessThan(1000);
    });
  });
});
