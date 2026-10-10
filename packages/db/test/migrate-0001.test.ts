// K1.T1: 0001 마이그레이션(job_leases.fence, omniroute_jobs.failed_at)을 다섯 DB 에 적용한다.
// 빈 DB 에 0000 만 적용 → 기존 행을 넣음 → 0001 까지 적용 순서로, 이미 돌던 DB 를 올리는 경로를 본다.
// scripts/test-migrate.mjs 가 MG_TEST_DBS(--db)로 고른 DB 만 돈다.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = (d: string) => path.join(PKG, "migrations", d);
type Kind = "sqlite" | "mysql" | "mariadb" | "pg" | "d1";
const ALL: Kind[] = ["sqlite", "mysql", "mariadb", "pg", "d1"];
const LABEL: Record<Kind, string> = { sqlite: "SQLite(libsql)", mysql: "MySQL 8.0", mariadb: "MariaDB 10.11", pg: "Postgres 14", d1: "D1(wrangler --local)" };
const selected = (process.env.MG_TEST_DBS ?? ALL.join(",")).split(",");
const cases = ALL.filter((k) => selected.includes(k));

/** 칼럼 하나의 모양. DB 마다 다른 표기를 아래 기대값으로 맞춘다 */
interface Col {
  type: string;
  notNull: boolean;
  default: string | null;
}

/** 0000 까지와 전체 마이그레이션 사이에서 행을 넣고 읽는 DB 하나 */
interface Upgrade {
  /** 0000 까지만 적용 */
  applyFirst(): Promise<void>;
  /** 남은 마이그레이션(0001…) 적용 */
  applyRest(): Promise<void>;
  exec(sql: string): Promise<void>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  column(table: string, column: string): Promise<Col | null>;
  close(): Promise<void>;
}

/** 커밋된 마이그레이션 폴더를 복사하고 journal 을 0000 하나로 줄인다. 0001 이후 SQL 은 지운다 (wrangler 는 폴더의 .sql 을 모두 읽는다) */
function firstOnly(dialect: string): { dir: string; done(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), `mg-0001-${dialect}-`));
  cpSync(MIGRATIONS(dialect), dir, { recursive: true });
  const journalFile = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalFile, "utf8"));
  for (const e of journal.entries.slice(1)) rmSync(path.join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, 1);
  writeFileSync(journalFile, JSON.stringify(journal));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const sqliteCol = (rows: Record<string, unknown>[], column: string): Col | null => {
  const r = rows.find((x) => x.name === column);
  return r ? { type: String(r.type).toLowerCase(), notNull: Number(r.notnull) === 1, default: r.dflt_value == null ? null : String(r.dflt_value) } : null;
};

async function sqliteUpgrade(): Promise<Upgrade> {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0001-sqlite-db-"));
  const client = createClient({ url: "file:" + path.join(dir, "t.sqlite") });
  const first = firstOnly("sqlite");
  const rows = async (sql: string) => (await client.execute(sql)).rows as unknown as Record<string, unknown>[];
  return {
    applyFirst: () => migrate(drizzle(client), { migrationsFolder: first.dir }),
    applyRest: () => migrate(drizzle(client), { migrationsFolder: MIGRATIONS("sqlite") }),
    exec: async (sql) => void (await client.execute(sql)),
    rows,
    column: async (table, column) => sqliteCol(await rows(`PRAGMA table_info(${table})`), column),
    async close() {
      client.close();
      first.done();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function mysqlUpgrade(port: number): Promise<Upgrade> {
  const mysql = (await import("mysql2/promise")).default;
  const { drizzle } = await import("drizzle-orm/mysql2");
  const { migrate } = await import("drizzle-orm/mysql2/migrator");
  const database = "mg_migrate_0001";
  const root = { host: "127.0.0.1", port, user: "root", password: "mgroot" };
  const admin = await mysql.createConnection(root);
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const pool = mysql.createPool({ ...root, database, connectionLimit: 2 });
  const first = firstOnly("mysql");
  const rows = async (sql: string) => (await pool.query(sql))[0] as Record<string, unknown>[];
  return {
    applyFirst: () => migrate(drizzle(pool), { migrationsFolder: first.dir }),
    applyRest: () => migrate(drizzle(pool), { migrationsFolder: MIGRATIONS("mysql") }),
    exec: async (sql) => void (await pool.query(sql)),
    rows,
    async column(table, column) {
      const [r] = await rows(
        `SELECT column_type AS type, is_nullable AS nullable, column_default AS def FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`,
      );
      return r ? { type: String(r.type), notNull: r.nullable === "NO", default: r.def == null ? null : String(r.def) } : null;
    },
    async close() {
      await pool.end();
      first.done();
    },
  };
}

async function pgUpgrade(): Promise<Upgrade> {
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const database = "mg_migrate_0001";
  const conn = { host: "127.0.0.1", port: 35432, username: "mg", password: "mgpass", onnotice: () => {} };
  const admin = postgres({ ...conn, database: "postgres", max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${database}`);
  await admin.end();
  const client = postgres({ ...conn, database, max: 2 });
  const first = firstOnly("pg");
  const rows = async (sql: string) => [...(await client.unsafe(sql))] as Record<string, unknown>[];
  return {
    applyFirst: () => migrate(drizzle(client), { migrationsFolder: first.dir }),
    applyRest: () => migrate(drizzle(client), { migrationsFolder: MIGRATIONS("pg") }),
    exec: async (sql) => void (await client.unsafe(sql)),
    rows,
    async column(table, column) {
      const [r] = await rows(
        `SELECT data_type AS type, is_nullable AS nullable, column_default AS def FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}'`,
      );
      return r ? { type: String(r.type), notNull: r.nullable === "NO", default: r.def == null ? null : String(r.def) } : null;
    },
    async close() {
      await client.end();
      first.done();
    },
  };
}

async function d1Upgrade(): Promise<Upgrade> {
  // 운영 경로와 같게 wrangler d1 migrations apply 로 적용한다. 같은 persist 폴더에 0000 만 든 폴더 → 전체 폴더 순서로 두 번 적용한다
  const persist = mkdtempSync(path.join(tmpdir(), "mg-0001-d1-"));
  const first = firstOnly("sqlite");
  const config = (migrationsDir: string) => {
    const file = path.join(persist, `wrangler-${path.basename(migrationsDir)}.jsonc`);
    writeFileSync(
      file,
      JSON.stringify({
        name: "magnetosphere-db-test-0001",
        compatibility_date: "2026-07-29",
        d1_databases: [{ binding: "DB", database_name: "mg-test-0001", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: migrationsDir }],
      }),
    );
    return file;
  };
  const apply = (migrationsDir: string) => {
    const r = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", config(migrationsDir), "--persist-to", persist], {
      cwd: PKG,
      encoding: "utf8",
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    });
    if (r.status !== 0) throw new Error(`wrangler d1 migrations apply 종료코드 ${r.status}\n${r.stdout}${r.stderr}`);
  };
  const { getPlatformProxy } = await import("wrangler");
  // 질의 때마다 프록시를 열고 닫는다. 열어 둔 채로 wrangler CLI 가 같은 폴더에 쓰면 잠금이 겹친다
  const withDb = async <T>(fn: (db: any) => Promise<T>): Promise<T> => {
    const proxy = await getPlatformProxy<{ DB: any }>({ configPath: config(MIGRATIONS("sqlite")), persist: { path: path.join(persist, "v3") } });
    try {
      return await fn(proxy.env.DB);
    } finally {
      await proxy.dispose();
    }
  };
  const rows = (sql: string) => withDb(async (db) => (await db.prepare(sql).all()).results as Record<string, unknown>[]);
  return {
    applyFirst: async () => apply(first.dir),
    applyRest: async () => apply(MIGRATIONS("sqlite")),
    exec: (sql) => withDb(async (db) => void (await db.prepare(sql).run())),
    rows,
    column: async (table, column) => sqliteCol(await rows(`PRAGMA table_info(${table})`), column),
    async close() {
      first.done();
      rmSync(persist, { recursive: true, force: true });
    },
  };
}

const open: Record<Kind, () => Promise<Upgrade>> = {
  sqlite: sqliteUpgrade,
  mysql: () => mysqlUpgrade(33306),
  mariadb: () => mysqlUpgrade(33307),
  pg: pgUpgrade,
  d1: d1Upgrade,
};

// DB 마다의 기대 칼럼 모양 (생성기 표: integer → sqlite integer · mysql int · pg integer, timestamp → sqlite integer · mysql datetime(3) · pg timestamp)
const FENCE: Record<Kind, Col> = {
  sqlite: { type: "integer", notNull: true, default: "0" },
  d1: { type: "integer", notNull: true, default: "0" },
  mysql: { type: "int", notNull: true, default: "0" },
  mariadb: { type: "int(11)", notNull: true, default: "0" },
  pg: { type: "integer", notNull: true, default: "0" },
};
const FAILED_AT: Record<Kind, Col> = {
  sqlite: { type: "integer", notNull: false, default: null },
  d1: { type: "integer", notNull: false, default: null },
  mysql: { type: "datetime(3)", notNull: false, default: null },
  // MariaDB 는 NULL 허용 칼럼의 기본값을 문자열 "NULL" 로 보여 준다
  mariadb: { type: "datetime(3)", notNull: false, default: "NULL" },
  pg: { type: "timestamp without time zone", notNull: false, default: null },
};
// 0000 시점의 행. 시각 표기만 DB 마다 다르다 (sqlite 는 ms 정수)
const AT: Record<Kind, string> = { sqlite: "1767225600000", d1: "1767225600000", mysql: "'2026-01-01 00:00:00.000'", mariadb: "'2026-01-01 00:00:00.000'", pg: "'2026-01-01 00:00:00.000'" };
const Q = (k: Kind) => (k === "pg" ? '"' : "`");

test("고른 DB 가 하나 이상이다 (0001)", () => {
  expect(cases.length).toBeGreaterThan(0);
});

describe.each(cases)("%s", (kind) => {
  test(`TC-K1.T1.a ${LABEL[kind]}: 0000 → 기존 행 → 0001 적용 뒤 job_leases.fence 정수 NOT NULL 기본 0·기존 행 0, omniroute_jobs.failed_at 시각 NULL 허용·기존 행 NULL`, async () => {
    const u = await open[kind]();
    try {
      await u.applyFirst();
      expect(await u.column("job_leases", "fence"), "0000 에는 fence 가 없다").toBeNull();
      const q = Q(kind);
      await u.exec(`INSERT INTO ${q}job_leases${q} (name, holder, locked_until) VALUES ('reconcile', 'node-a', ${AT[kind]})`);
      await u.exec(
        `INSERT INTO ${q}omniroute_jobs${q} (id, action, payload, attempts, next_run_at) VALUES ('job-1', 'key.apply_state', '{}', 2, ${AT[kind]})`,
      );
      await u.applyRest();

      expect(await u.column("job_leases", "fence")).toEqual(FENCE[kind]);
      expect(await u.column("omniroute_jobs", "failed_at")).toEqual(FAILED_AT[kind]);
      const [lease] = await u.rows(`SELECT holder, fence FROM ${q}job_leases${q} WHERE name = 'reconcile'`);
      expect({ holder: lease?.holder, fence: Number(lease?.fence) }).toEqual({ holder: "node-a", fence: 0 });
      const [job] = await u.rows(`SELECT attempts, failed_at FROM ${q}omniroute_jobs${q} WHERE id = 'job-1'`);
      expect({ attempts: Number(job?.attempts), failedAt: job?.failed_at }).toEqual({ attempts: 2, failedAt: null });
      // 새로 넣는 임대 행은 fence 를 주지 않아도 0 이다
      await u.exec(`INSERT INTO ${q}job_leases${q} (name, holder, locked_until) VALUES ('budget_rebalance', 'node-b', ${AT[kind]})`);
      const [fresh] = await u.rows(`SELECT fence FROM ${q}job_leases${q} WHERE name = 'budget_rebalance'`);
      expect(Number(fresh?.fence)).toBe(0);
    } finally {
      await u.close();
    }
  });
});
