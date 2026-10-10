// K2.T7: 0002 마이그레이션(usage_daily, api_keys.budget_at)을 빈 DB 다섯에 적용한다 (계획서 v5.7 5.9).
// usage_daily 는 (key_id, day) 기본 키, cost_usd 는 DECIMAL(12,6)(SQLite REAL). 같은 (key_id, day) 는 한 행이다.
// scripts/test-migrate.mjs 가 MG_TEST_DBS(--db)로 고른 DB 만 돈다.
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { DBS, type Handle } from "./dbs.ts";

const selected = (process.env.MG_TEST_DBS ?? DBS.map((d) => d.kind).join(",")).split(",");
const cases = DBS.filter((d) => selected.includes(d.kind));

test("고른 DB 가 하나 이상이다 (0002)", () => {
  expect(cases.length).toBeGreaterThan(0);
});

/** usage_daily 의 칼럼 타입과 기본 키 칼럼 (DB 마다 structure() 모양이 다르다) */
function usageDailyShape(kind: string, s: any): { types: Record<string, string>; pk: string[]; budgetAt: string | null } {
  if (kind === "sqlite" || kind === "d1") {
    const create = String((s as unknown[][]).find((r) => r[0] === "table" && r[1] === "usage_daily")?.[3] ?? "");
    const apiKeys = String((s as unknown[][]).find((r) => r[0] === "table" && r[1] === "api_keys")?.[3] ?? "");
    const types = Object.fromEntries([...create.matchAll(/`(\w+)` (\w+) NOT NULL/g)].map((m) => [m[1], m[2]]));
    const pk = /PRIMARY KEY\(([^)]*)\)/.exec(create)?.[1].replace(/`/g, "").split(",") ?? [];
    return { types, pk, budgetAt: /`budget_at` (\w+)/.exec(apiKeys)?.[1] ?? null };
  }
  if (kind === "pg") {
    const cols = s.columns.filter((c: any) => c.t === "usage_daily");
    const types = Object.fromEntries(cols.map((c: any) => [c.c, c.type === "numeric" ? `numeric(${c.prec},${c.scale})` : c.type]));
    const def = s.constraints.find((c: any) => c.t === "usage_daily" && c.type === "p")?.def ?? "";
    const pk = /PRIMARY KEY \(([^)]*)\)/.exec(def)?.[1].split(", ") ?? [];
    return { types, pk, budgetAt: s.columns.find((c: any) => c.t === "api_keys" && c.c === "budget_at")?.type ?? null };
  }
  const cols = s.columns.filter((c: any) => c.t === "usage_daily");
  const types = Object.fromEntries(cols.map((c: any) => [c.c, String(c.type)]));
  const pk = s.indexes.filter((i: any) => i.t === "usage_daily" && i.i === "PRIMARY").map((i: any) => i.c);
  return { types, pk, budgetAt: s.columns.find((c: any) => c.t === "api_keys" && c.c === "budget_at")?.type ?? null };
}

const EXPECTED: Record<string, { types: Record<string, string>; budgetAt: string }> = {
  sqlite: { types: { key_id: "text", day: "text", cost_usd: "real", updated_at: "integer" }, budgetAt: "integer" },
  d1: { types: { key_id: "text", day: "text", cost_usd: "real", updated_at: "integer" }, budgetAt: "integer" },
  mysql: { types: { key_id: "varchar(255)", day: "varchar(10)", cost_usd: "decimal(12,6)", updated_at: "datetime(3)" }, budgetAt: "datetime(3)" },
  mariadb: { types: { key_id: "varchar(255)", day: "varchar(10)", cost_usd: "decimal(12,6)", updated_at: "datetime(3)" }, budgetAt: "datetime(3)" },
  pg: {
    types: { key_id: "character varying", day: "character varying", cost_usd: "numeric(12,6)", updated_at: "timestamp without time zone" },
    budgetAt: "timestamp without time zone",
  },
};

async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

describe.each(cases)("$label", (d) => {
  test(`TC-K2.T7.e ${d.label}: usage_daily (key_id, day) 기본 키, cost_usd DECIMAL(12,6)·SQLite REAL, 같은 (key_id, day) 두 번 저장은 갱신 1행`, async () => {
    const h: Handle = await d.open();
    try {
      const shape = usageDailyShape(d.kind, await h.structure());
      expect(shape.types).toEqual(EXPECTED[d.kind].types);
      expect(shape.pk).toEqual(["key_id", "day"]);
      expect(shape.budgetAt, "api_keys.budget_at (K2.T4)").toBe(EXPECTED[d.kind].budgetAt);

      const t = h.schema.usageDaily;
      const at = new Date("2026-04-10T00:01:00.000Z");
      await h.db.insert(t).values({ keyId: "ork-A", day: "2026-04-09", costUsd: 0.014633, updatedAt: at });
      await h.db.insert(t).values({ keyId: "ork-A", day: "2026-04-08", costUsd: 0.1, updatedAt: at });
      // 같은 (key_id, day) 를 또 넣으면 기본 키가 막는다. 저장은 갱신이다
      expect(await rejects(h.db.insert(t).values({ keyId: "ork-A", day: "2026-04-09", costUsd: 1, updatedAt: at })), "같은 (key_id, day) 두 번째 INSERT").toBe(true);
      await h.db.update(t).set({ costUsd: 0.012345, updatedAt: at }).where(and(eq(t.keyId, "ork-A"), eq(t.day, "2026-04-09")));
      const rows = await h.db.select().from(t).where(eq(t.keyId, "ork-A"));
      expect(rows.map((r: any) => [r.day, Number(r.costUsd)]).sort()).toEqual([
        ["2026-04-08", 0.1],
        ["2026-04-09", 0.012345],
      ]);
      // 키 id 는 대소문자까지 구분한다 (OmniRoute id, exact)
      await h.db.insert(t).values({ keyId: "ORK-A", day: "2026-04-09", costUsd: 0.5, updatedAt: at });
      expect((await h.db.select().from(t).where(eq(t.day, "2026-04-09"))).length).toBe(2);
    } finally {
      await h.close();
    }
  });
});
