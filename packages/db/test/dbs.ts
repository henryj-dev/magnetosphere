// 마이그레이션 테스트용 DB 다섯. open() 은 매번 빈 DB 를 새로 만들고 커밋된 마이그레이션을 적용한 뒤 핸들을 돌려준다.
// MySQL·MariaDB·Postgres 는 docker-compose.test.yml 의 컨테이너(scripts/test-migrate.mjs 가 띄움)에 붙는다.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sqliteSchema from "../src/schema/sqlite.ts";
import * as mysqlSchema from "../src/schema/mysql.ts";
import * as pgSchema from "../src/schema/pg.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = (d: string) => path.join(PKG, "migrations", d);
const TEST_DB = "mg_migrate_test";

export interface Handle {
  db: any;
  schema: any;
  /** 마이그레이션 기록 테이블을 뺀 사용자 테이블 이름 */
  tables(): Promise<string[]>;
  close(): Promise<void>;
}

export interface DbCase {
  kind: "sqlite" | "mysql" | "mariadb" | "pg" | "d1";
  label: string;
  open(): Promise<Handle>;
}

const sqliteTables = (names: string[]) => names.filter((n) => !/^(sqlite_|__drizzle|d1_migrations$|_cf_)/.test(n)).sort();

async function openMysql(port: number): Promise<Handle> {
  const mysql = (await import("mysql2/promise")).default;
  const { drizzle } = await import("drizzle-orm/mysql2");
  const { migrate } = await import("drizzle-orm/mysql2/migrator");
  const admin = await mysql.createConnection({ host: "127.0.0.1", port, user: "root", password: "mgroot" });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const pool = mysql.createPool({ host: "127.0.0.1", port, user: "root", password: "mgroot", database: TEST_DB, connectionLimit: 5 });
  const db = drizzle(pool, { schema: mysqlSchema, mode: "default" });
  await migrate(db, { migrationsFolder: MIGRATIONS("mysql") });
  return {
    db,
    schema: mysqlSchema,
    async tables() {
      const [rows] = await pool.query("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE()");
      return (rows as { n: string }[]).map((r) => r.n).filter((n) => n !== "__drizzle_migrations").sort();
    },
    close: () => pool.end(),
  };
}

export const DBS: DbCase[] = [
  {
    kind: "sqlite",
    label: "SQLite(libsql)",
    async open() {
      const { createClient } = await import("@libsql/client");
      const { drizzle } = await import("drizzle-orm/libsql");
      const { migrate } = await import("drizzle-orm/libsql/migrator");
      const dir = mkdtempSync(path.join(tmpdir(), "mg-migrate-sqlite-"));
      const client = createClient({ url: "file:" + path.join(dir, "test.sqlite") });
      const db = drizzle(client, { schema: sqliteSchema });
      await migrate(db, { migrationsFolder: MIGRATIONS("sqlite") });
      return {
        db,
        schema: sqliteSchema,
        async tables() {
          const r = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
          return sqliteTables(r.rows.map((x) => String(x.name)));
        },
        async close() {
          client.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  { kind: "mysql", label: "MySQL 8.0", open: () => openMysql(33306) },
  { kind: "mariadb", label: "MariaDB 10.11", open: () => openMysql(33307) },
  {
    kind: "pg",
    label: "Postgres 14",
    async open() {
      const postgres = (await import("postgres")).default;
      const { drizzle } = await import("drizzle-orm/postgres-js");
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      const conn = { host: "127.0.0.1", port: 35432, username: "mg", password: "mgpass", onnotice: () => {} };
      const admin = postgres({ ...conn, database: "postgres", max: 1 });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
      await admin.end();
      const client = postgres({ ...conn, database: TEST_DB, max: 5 });
      const db = drizzle(client, { schema: pgSchema });
      await migrate(db, { migrationsFolder: MIGRATIONS("pg") });
      return {
        db,
        schema: pgSchema,
        async tables() {
          const rows = await client`SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'`;
          return rows.map((r) => String(r.n)).sort();
        },
        close: () => client.end(),
      };
    },
  },
  {
    kind: "d1",
    label: "D1(wrangler --local)",
    async open() {
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
        async close() {
          await proxy.dispose();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];
