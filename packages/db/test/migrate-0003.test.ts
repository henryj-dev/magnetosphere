// M1.T4: 0003 마이그레이션(invites.revoked_at·used_by·(expires_at) 색인, user.deleted_at)을 다섯 DB 에 적용한다 (Q4·Q9).
// 빈 DB 에 0002 까지 적용 → 기존 행(회원·초대)을 넣음 → 0003 까지 적용 순서로, 2단계까지 돌던 DB 를 올리는 경로를 본다.
// 빈 DB 에 전부 적용하는 경로는 migrate.test.ts(TC-S2.T3.a~d)가 같이 본다. scripts/test-migrate.mjs 가 MG_TEST_DBS(--db)로 고른 DB 만 돈다.
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
/** 0000·0001·0002 */
const BEFORE = 3;

interface Col {
  type: string;
  notNull: boolean;
  default: string | null;
}

/** 0002 까지와 전체 마이그레이션 사이에서 행을 넣고 읽는 DB 하나 */
interface Upgrade {
  applyFirst(): Promise<void>;
  applyRest(): Promise<void>;
  exec(sql: string): Promise<void>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  column(table: string, column: string): Promise<Col | null>;
  /** 그 테이블의 색인 이름 → 칼럼 목록 (기본 키·고유 제약 제외) */
  indexes(table: string): Promise<Record<string, string[]>>;
  close(): Promise<void>;
}

/** 커밋된 마이그레이션 폴더를 복사하고 journal 을 앞 BEFORE 개로 줄인다. 그 뒤 SQL 은 지운다 (wrangler 는 폴더의 .sql 을 모두 읽는다) */
function upTo0002(dialect: string): { dir: string; done(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), `mg-0003-${dialect}-`));
  cpSync(MIGRATIONS(dialect), dir, { recursive: true });
  const journalFile = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalFile, "utf8"));
  expect(journal.entries.map((e: { tag: string }) => e.tag).slice(0, BEFORE + 1)).toEqual(["0000_init", "0001_k1_jobs", "0002_k2_usage_daily", "0003_m1_members"]);
  for (const e of journal.entries.slice(BEFORE)) rmSync(path.join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, BEFORE);
  writeFileSync(journalFile, JSON.stringify(journal));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const sqliteCol = (rows: Record<string, unknown>[], column: string): Col | null => {
  const r = rows.find((x) => x.name === column);
  return r ? { type: String(r.type).toLowerCase(), notNull: Number(r.notnull) === 1, default: r.dflt_value == null ? null : String(r.dflt_value) } : null;
};
async function sqliteIndexes(rows: (sql: string) => Promise<Record<string, unknown>[]>, table: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const ix of await rows(`PRAGMA index_list(${table})`)) {
    if (ix.origin !== "c" || Number(ix.unique) === 1) continue;
    out[String(ix.name)] = (await rows(`PRAGMA index_info(${ix.name})`)).map((c) => String(c.name));
  }
  return out;
}

async function sqliteUpgrade(): Promise<Upgrade> {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0003-sqlite-db-"));
  const client = createClient({ url: "file:" + path.join(dir, "t.sqlite") });
  const first = upTo0002("sqlite");
  const rows = async (sql: string) => (await client.execute(sql)).rows as unknown as Record<string, unknown>[];
  return {
    applyFirst: () => migrate(drizzle(client), { migrationsFolder: first.dir }),
    applyRest: () => migrate(drizzle(client), { migrationsFolder: MIGRATIONS("sqlite") }),
    exec: async (sql) => void (await client.execute(sql)),
    rows,
    column: async (table, column) => sqliteCol(await rows(`PRAGMA table_info(${table})`), column),
    indexes: (table) => sqliteIndexes(rows, table),
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
  const database = "mg_migrate_0003";
  const root = { host: "127.0.0.1", port, user: "root", password: "mgroot" };
  const admin = await mysql.createConnection(root);
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const pool = mysql.createPool({ ...root, database, connectionLimit: 2 });
  const first = upTo0002("mysql");
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
    async indexes(table) {
      const out: Record<string, string[]> = {};
      const rs = await rows(
        `SELECT index_name AS i, column_name AS c FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = '${table}' AND non_unique = 1 ORDER BY i, seq_in_index`,
      );
      for (const r of rs) (out[String(r.i)] ??= []).push(String(r.c));
      return out;
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
  const database = "mg_migrate_0003";
  const conn = { host: "127.0.0.1", port: 35432, username: "mg", password: "mgpass", onnotice: () => {} };
  const admin = postgres({ ...conn, database: "postgres", max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${database}`);
  await admin.end();
  const client = postgres({ ...conn, database, max: 2 });
  const first = upTo0002("pg");
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
    async indexes(table) {
      const out: Record<string, string[]> = {};
      const rs = await rows(
        `SELECT i.relname AS i, a.attname AS c FROM pg_index x
          JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(x.indkey)
          WHERE t.relname = '${table}' AND NOT x.indisunique AND NOT x.indisprimary ORDER BY i.relname, a.attnum`,
      );
      for (const r of rs) (out[String(r.i)] ??= []).push(String(r.c));
      return out;
    },
    async close() {
      await client.end();
      first.done();
    },
  };
}

async function d1Upgrade(): Promise<Upgrade> {
  // 운영 경로와 같게 wrangler d1 migrations apply 로 적용한다. 같은 persist 폴더에 0002 까지 든 폴더 → 전체 폴더 순서로 두 번 적용한다
  const persist = mkdtempSync(path.join(tmpdir(), "mg-0003-d1-"));
  const first = upTo0002("sqlite");
  const config = (migrationsDir: string) => {
    const file = path.join(persist, `wrangler-${path.basename(migrationsDir)}.jsonc`);
    writeFileSync(
      file,
      JSON.stringify({
        name: "magnetosphere-db-test-0003",
        compatibility_date: "2026-07-29",
        d1_databases: [{ binding: "DB", database_name: "mg-test-0003", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: migrationsDir }],
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
    indexes: (table) => sqliteIndexes(rows, table),
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

// 생성기 표: timestamp → sqlite integer · mysql datetime(3) · pg timestamp, id → sqlite text · mysql/pg varchar(36). 셋 다 NULL 허용·기본값 없음
const TIMESTAMP: Record<Kind, Col> = {
  sqlite: { type: "integer", notNull: false, default: null },
  d1: { type: "integer", notNull: false, default: null },
  mysql: { type: "datetime(3)", notNull: false, default: null },
  // MariaDB 는 NULL 허용 칼럼의 기본값을 문자열 "NULL" 로 보여 준다
  mariadb: { type: "datetime(3)", notNull: false, default: "NULL" },
  pg: { type: "timestamp without time zone", notNull: false, default: null },
};
const ID: Record<Kind, Col> = {
  sqlite: { type: "text", notNull: false, default: null },
  d1: { type: "text", notNull: false, default: null },
  mysql: { type: "varchar(36)", notNull: false, default: null },
  mariadb: { type: "varchar(36)", notNull: false, default: "NULL" },
  pg: { type: "character varying", notNull: false, default: null },
};
// 0002 시점의 행. 시각·참거짓 표기만 DB 마다 다르다 (sqlite 는 ms 정수·0/1)
const AT: Record<Kind, string> = { sqlite: "1767225600000", d1: "1767225600000", mysql: "'2026-01-01 00:00:00.000'", mariadb: "'2026-01-01 00:00:00.000'", pg: "'2026-01-01 00:00:00.000'" };
const FALSE: Record<Kind, string> = { sqlite: "0", d1: "0", mysql: "0", mariadb: "0", pg: "false" };
const Q = (k: Kind) => (k === "pg" ? '"' : "`");

test("고른 DB 가 하나 이상이다 (0003)", () => {
  expect(cases.length).toBeGreaterThan(0);
});

describe.each(cases)("%s", (kind) => {
  test(`TC-M1.T4.a ${LABEL[kind]}: 0002 → 기존 행 → 0003 적용 뒤 invites.revoked_at·used_by·user.deleted_at NULL 허용, invites(expires_at) 색인, 기존 값 그대로`, async () => {
    const u = await open[kind]();
    try {
      await u.applyFirst();
      expect(await u.column("invites", "revoked_at"), "0002 에는 revoked_at 이 없다").toBeNull();
      expect(await u.column("user", "deleted_at"), "0002 에는 deleted_at 이 없다").toBeNull();
      const q = Q(kind);
      await u.exec(
        `INSERT INTO ${q}user${q} (id, name, email, email_verified, created_at, updated_at, role, status, monthly_limit_usd, max_keys, is_bootstrap_admin)
          VALUES ('u-1', '회원', 'm@example.com', ${FALSE[kind]}, ${AT[kind]}, ${AT[kind]}, 'admin', 'suspended', 12.5, 3, ${FALSE[kind]})`,
      );
      await u.exec(
        `INSERT INTO ${q}invites${q} (id, email, token_hash, role, expires_at, used_at, created_by) VALUES ('i-1', 'x@example.com', 'Hash-1', 'member', ${AT[kind]}, ${AT[kind]}, 'u-1')`,
      );
      await u.applyRest();

      expect(await u.column("invites", "revoked_at")).toEqual(TIMESTAMP[kind]);
      expect(await u.column("invites", "used_by")).toEqual(ID[kind]);
      expect(await u.column("user", "deleted_at")).toEqual(TIMESTAMP[kind]);
      expect(await u.indexes("invites")).toEqual({ idx_invites_expires: ["expires_at"] });

      const [user] = await u.rows(`SELECT email, role, status, monthly_limit_usd, max_keys, deleted_at FROM ${q}user${q} WHERE id = 'u-1'`);
      expect({ ...user, monthly_limit_usd: Number(user?.monthly_limit_usd), max_keys: Number(user?.max_keys) }).toEqual({
        email: "m@example.com",
        role: "admin",
        status: "suspended",
        monthly_limit_usd: 12.5,
        max_keys: 3,
        deleted_at: null,
      });
      const [invite] = await u.rows(`SELECT email, token_hash, role, used_at IS NOT NULL AS used, revoked_at, used_by FROM ${q}invites${q} WHERE id = 'i-1'`);
      expect({ ...invite, used: Boolean(Number(invite?.used)) }).toEqual({ email: "x@example.com", token_hash: "Hash-1", role: "member", used: true, revoked_at: null, used_by: null });
      // 새 칼럼에 값을 넣고 다시 비울 수 있다 (NULL 허용)
      await u.exec(`UPDATE ${q}invites${q} SET revoked_at = ${AT[kind]}, used_by = 'u-1' WHERE id = 'i-1'`);
      await u.exec(`UPDATE ${q}user${q} SET deleted_at = ${AT[kind]} WHERE id = 'u-1'`);
      await u.exec(`UPDATE ${q}user${q} SET deleted_at = NULL WHERE id = 'u-1'`);
      const [after] = await u.rows(`SELECT used_by, revoked_at IS NOT NULL AS revoked FROM ${q}invites${q} WHERE id = 'i-1'`);
      expect({ usedBy: after?.used_by, revoked: Boolean(Number(after?.revoked)) }).toEqual({ usedBy: "u-1", revoked: true });
    } finally {
      await u.close();
    }
  });
});
