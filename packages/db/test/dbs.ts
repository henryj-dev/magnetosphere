// 마이그레이션 테스트용 DB 다섯. open() 은 매번 빈 DB 를 새로 만들고 커밋된 마이그레이션을 적용한 뒤 핸들을 돌려준다.
// openFromSchema() 는 커밋된 마이그레이션 대신 지금 스키마(src/schema/*.ts)에서 drizzle-kit 이 바로 만든 DDL 로
// 빈 DB 를 만든다 (TC-S2.T3.d 의 기준). MySQL·MariaDB·Postgres 는 docker-compose.test.yml 의 컨테이너
// (scripts/test-migrate.mjs 가 띄움)에 붙는다.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sqliteSchema from "../src/schema/sqlite.ts";
import * as mysqlSchema from "../src/schema/mysql.ts";
import * as pgSchema from "../src/schema/pg.ts";

const kit = createRequire(import.meta.url)("drizzle-kit/api"); // CJS 모듈
const PKG = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = (d: string) => path.join(PKG, "migrations", d);
const DB_NAME = { migrations: "mg_migrate_test", schema: "mg_schema_ref" } as const;
type Via = keyof typeof DB_NAME;

export interface Handle {
  db: any;
  schema: any;
  /** 마이그레이션 기록 테이블을 뺀 사용자 테이블 이름 */
  tables(): Promise<string[]>;
  /** 테이블·칼럼(타입·NULL·기본값·정렬)·인덱스·제약을 정렬한 목록. 같은 구조면 같은 값 */
  structure(): Promise<unknown>;
  close(): Promise<void>;
}

export interface DbCase {
  kind: "sqlite" | "mysql" | "mariadb" | "pg" | "d1";
  label: string;
  open(): Promise<Handle>;
  openFromSchema(): Promise<Handle>;
}

const SKIP_SQLITE = /^(sqlite_|__drizzle|d1_migrations$|_cf_)/;
const norm = (sql: unknown) => String(sql ?? "").replace(/\s+/g, " ").trim();
const sqliteTables = (names: string[]) => names.filter((n) => !SKIP_SQLITE.test(n)).sort();
const SQLITE_MASTER = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name";
const sqliteStructure = (rows: Record<string, unknown>[]) =>
  rows.filter((r) => !SKIP_SQLITE.test(String(r.name)) && !SKIP_SQLITE.test(String(r.tbl_name))).map((r) => [r.type, r.name, r.tbl_name, norm(r.sql)]);

async function openSqlite(via: Via): Promise<Handle> {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  const dir = mkdtempSync(path.join(tmpdir(), `mg-${via}-sqlite-`));
  const client = createClient({ url: "file:" + path.join(dir, "test.sqlite") });
  const db = drizzle(client, { schema: sqliteSchema });
  if (via === "migrations") await migrate(db, { migrationsFolder: MIGRATIONS("sqlite") });
  else for (const s of await kit.generateSQLiteMigration(await kit.generateSQLiteDrizzleJson({}), await kit.generateSQLiteDrizzleJson(sqliteSchema))) await client.execute(s);
  return {
    db,
    schema: sqliteSchema,
    async tables() {
      const r = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
      return sqliteTables(r.rows.map((x) => String(x.name)));
    },
    async structure() {
      return sqliteStructure((await client.execute(SQLITE_MASTER)).rows as unknown as Record<string, unknown>[]);
    },
    async close() {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// information_schema 에서 구조를 읽는 질의. 별칭을 소문자로 둬 MySQL·MariaDB 의 열 이름 대소문자 차이를 없앤다.
const MYSQL_STRUCTURE = {
  columns: `SELECT table_name AS t, column_name AS c, ordinal_position AS pos, column_type AS type, is_nullable AS nullable,
      column_default AS def, character_set_name AS charset, collation_name AS coll, extra AS extra
    FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name <> '__drizzle_migrations' ORDER BY t, pos`,
  indexes: `SELECT table_name AS t, index_name AS i, non_unique AS nu, seq_in_index AS seq, column_name AS c
    FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name <> '__drizzle_migrations' ORDER BY t, i, seq`,
  constraints: `SELECT table_name AS t, constraint_name AS n, constraint_type AS type
    FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name <> '__drizzle_migrations' ORDER BY t, n`,
  checks: `SELECT constraint_name AS n, check_clause AS clause FROM information_schema.check_constraints WHERE constraint_schema = DATABASE() ORDER BY n`,
  foreignKeys: `SELECT k.table_name AS t, k.constraint_name AS n, k.column_name AS c, k.referenced_table_name AS rt, k.referenced_column_name AS rc,
      r.update_rule AS upd, r.delete_rule AS del
    FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r
      ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
    WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL ORDER BY t, n, c`,
};

async function openMysql(port: number, via: Via): Promise<Handle> {
  const mysql = (await import("mysql2/promise")).default;
  const { drizzle } = await import("drizzle-orm/mysql2");
  const { migrate } = await import("drizzle-orm/mysql2/migrator");
  const database = DB_NAME[via];
  const admin = await mysql.createConnection({ host: "127.0.0.1", port, user: "root", password: "mgroot" });
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const pool = mysql.createPool({ host: "127.0.0.1", port, user: "root", password: "mgroot", database, connectionLimit: 5 });
  const db = drizzle(pool, { schema: mysqlSchema, mode: "default" });
  if (via === "migrations") await migrate(db, { migrationsFolder: MIGRATIONS("mysql") });
  else for (const s of await kit.generateMySQLMigration(await kit.generateMySQLDrizzleJson({}), await kit.generateMySQLDrizzleJson(mysqlSchema))) await pool.query(s);
  return {
    db,
    schema: mysqlSchema,
    async tables() {
      const [rows] = await pool.query("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE()");
      return (rows as { n: string }[]).map((r) => r.n).filter((n) => n !== "__drizzle_migrations").sort();
    },
    async structure() {
      const out: Record<string, unknown> = {};
      for (const [k, q] of Object.entries(MYSQL_STRUCTURE)) out[k] = (await pool.query(q))[0];
      return out;
    },
    close: () => pool.end(),
  };
}

async function openPg(via: Via): Promise<Handle> {
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const database = DB_NAME[via];
  const conn = { host: "127.0.0.1", port: 35432, username: "mg", password: "mgpass", onnotice: () => {} };
  const admin = postgres({ ...conn, database: "postgres", max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${database}`);
  await admin.end();
  const client = postgres({ ...conn, database, max: 5 });
  const db = drizzle(client, { schema: pgSchema });
  if (via === "migrations") await migrate(db, { migrationsFolder: MIGRATIONS("pg") });
  else for (const s of await kit.generateMigration(await kit.generateDrizzleJson({}), await kit.generateDrizzleJson(pgSchema))) await client.unsafe(s);
  return {
    db,
    schema: pgSchema,
    async tables() {
      const rows = await client`SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'`;
      return rows.map((r) => String(r.n)).sort();
    },
    async structure() {
      const columns = await client`SELECT table_name AS t, column_name AS c, ordinal_position AS pos, data_type AS type,
          character_maximum_length AS len, numeric_precision AS prec, numeric_scale AS scale, datetime_precision AS dtp,
          is_nullable AS nullable, column_default AS def, collation_name AS coll
        FROM information_schema.columns WHERE table_schema = 'public' ORDER BY t, pos`;
      const indexes = await client`SELECT tablename AS t, indexname AS i, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' ORDER BY t, i`;
      const constraints = await client`SELECT conrelid::regclass::text AS t, conname AS n, contype AS type, pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY t, n`;
      return { columns: [...columns], indexes: [...indexes], constraints: [...constraints] };
    },
    close: () => client.end(),
  };
}

async function openD1(): Promise<Handle> {
  // 운영 경로와 같게 wrangler 로 적용한다. 마이그레이션 폴더는 test/d1/wrangler.jsonc 의 migrations_dir(sqlite).
  const dir = mkdtempSync(path.join(tmpdir(), "mg-migrate-d1-"));
  const config = path.join(PKG, "test/d1/wrangler.jsonc");
  const r = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", config, "--persist-to", dir], {
    cwd: PKG,
    encoding: "utf8",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  if (r.status !== 0) throw new Error(`wrangler d1 migrations apply 종료코드 ${r.status}\n${r.stdout}${r.stderr}`);
  const { getPlatformProxy } = await import("wrangler");
  const { drizzle } = await import("drizzle-orm/d1");
  const proxy = await getPlatformProxy<{ DB: any }>({ configPath: config, persist: { path: path.join(dir, "v3") } });
  const db = drizzle(proxy.env.DB, { schema: sqliteSchema });
  return {
    db,
    schema: sqliteSchema,
    async tables() {
      const res = await proxy.env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      return sqliteTables(res.results.map((x: { name: string }) => x.name));
    },
    async structure() {
      return sqliteStructure((await proxy.env.DB.prepare(SQLITE_MASTER).all()).results);
    },
    async close() {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const DBS: DbCase[] = [
  { kind: "sqlite", label: "SQLite(libsql)", open: () => openSqlite("migrations"), openFromSchema: () => openSqlite("schema") },
  { kind: "mysql", label: "MySQL 8.0", open: () => openMysql(33306, "migrations"), openFromSchema: () => openMysql(33306, "schema") },
  { kind: "mariadb", label: "MariaDB 10.11", open: () => openMysql(33307, "migrations"), openFromSchema: () => openMysql(33307, "schema") },
  { kind: "pg", label: "Postgres 14", open: () => openPg("migrations"), openFromSchema: () => openPg("schema") },
  // D1 은 같은 sqlite 스키마로 만든 libsql DB 를 기준으로 비교한다 (sqlite_master 의 테이블·인덱스 정의).
  { kind: "d1", label: "D1(wrangler --local)", open: openD1, openFromSchema: () => openSqlite("schema") },
];
