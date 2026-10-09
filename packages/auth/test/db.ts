// 테스트용 DB. 열 때마다 이름이 겹치지 않는 빈 DB 를 만들고 packages/db 에 커밋된 마이그레이션을 적용한다.
// MySQL·MariaDB·Postgres 는 저장소 최상위 docker-compose.test.yml 의 컨테이너에 붙는다 (scripts/test.mjs 가 띄운다).
// 여러 테스트 파일이 동시에 돌아도 서로의 DB 를 지우지 않게 DB 이름에 무작위 꼬리를 붙인다.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sqliteSchema from "@magnetosphere/db/src/schema/sqlite.ts";
import * as mysqlSchema from "@magnetosphere/db/src/schema/mysql.ts";
import * as pgSchema from "@magnetosphere/db/src/schema/pg.ts";
import type { AuthDatabase } from "../src/index.ts";

const MIGRATIONS = (d: string) => fileURLToPath(new URL(`../../db/migrations/${d}`, import.meta.url));

export interface TestDb extends AuthDatabase {
  label: string;
  close(): Promise<void>;
}

export type DbKind = "sqlite" | "mysql" | "mariadb" | "pg";

async function openSqlite(): Promise<TestDb> {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  const dir = mkdtempSync(path.join(tmpdir(), "mg-auth-sqlite-"));
  const client = createClient({ url: "file:" + path.join(dir, "auth.sqlite") });
  const db = drizzle(client, { schema: sqliteSchema });
  await migrate(db, { migrationsFolder: MIGRATIONS("sqlite") });
  return {
    label: "SQLite(libsql)",
    db,
    provider: "sqlite",
    schema: sqliteSchema,
    async close() {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function openMysql(port: number, label: string): Promise<TestDb> {
  const mysql = (await import("mysql2/promise")).default;
  const { drizzle } = await import("drizzle-orm/mysql2");
  const { migrate } = await import("drizzle-orm/mysql2/migrator");
  const database = `mg_auth_${randomBytes(4).toString("hex")}`;
  const conn = { host: "127.0.0.1", port, user: "root", password: "mgroot" };
  const admin = await mysql.createConnection(conn);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const pool = mysql.createPool({ ...conn, database, connectionLimit: 5 });
  const db = drizzle(pool, { schema: mysqlSchema, mode: "default" });
  await migrate(db, { migrationsFolder: MIGRATIONS("mysql") });
  return {
    label,
    db,
    provider: "mysql",
    schema: mysqlSchema,
    async close() {
      await pool.end();
      const a = await mysql.createConnection(conn);
      await a.query(`DROP DATABASE IF EXISTS ${database}`);
      await a.end();
    },
  };
}

async function openPg(): Promise<TestDb> {
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const database = `mg_auth_${randomBytes(4).toString("hex")}`;
  const conn = { host: "127.0.0.1", port: 35432, username: "mg", password: "mgpass", onnotice: () => {} };
  const admin = postgres({ ...conn, database: "postgres", max: 1 });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  await admin.end();
  const client = postgres({ ...conn, database, max: 5 });
  const db = drizzle(client, { schema: pgSchema });
  await migrate(db, { migrationsFolder: MIGRATIONS("pg") });
  return {
    label: "Postgres 14",
    db,
    provider: "pg",
    schema: pgSchema,
    async close() {
      await client.end();
      const a = postgres({ ...conn, database: "postgres", max: 1 });
      await a.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await a.end();
    },
  };
}

export const OPEN: Record<DbKind, () => Promise<TestDb>> = {
  sqlite: openSqlite,
  mysql: () => openMysql(33306, "MySQL 8.0"),
  mariadb: () => openMysql(33307, "MariaDB 10.11"),
  pg: openPg,
};

/** DB 차이가 결과를 바꿀 수 있는 TC 는 네 DB 모두에서 돈다 */
export const ALL_DBS: DbKind[] = ["sqlite", "mysql", "mariadb", "pg"];
