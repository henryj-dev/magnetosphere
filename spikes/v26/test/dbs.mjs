// 네 DB 연결과 테이블 생성. 테이블은 Better Auth 생성기가 만든 Drizzle 스키마(schema/*.ts)를
// drizzle-kit 의 generate*Migration 으로 DDL 로 바꿔 빈 DB 에 적용한다. 매번 지우고 다시 만든다.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql, count, eq } from "drizzle-orm";
import { createRequire } from "node:module";
const kit = createRequire(import.meta.url)("drizzle-kit/api"); // CJS 모듈
import * as sqliteSchema from "../schema/sqlite.ts";
import * as mysqlSchema from "../schema/mysql.ts";
import * as pgSchema from "../schema/pg.ts";

const TABLES = ["sso_provider", "verification", "account", "session", "user"]; // FK 역순
const SQLITE_FILE = fileURLToPath(new URL("../v26.sqlite", import.meta.url));

export const DBS = [
  { kind: "sqlite", label: "SQLite(libsql)" },
  { kind: "mysql", label: "MySQL 8.0", url: "mysql://v26:v26pass@127.0.0.1:13306/v26" },
  { kind: "mariadb", label: "MariaDB 10.11", url: "mysql://v26:v26pass@127.0.0.1:13307/v26" },
  { kind: "pg", label: "Postgres 14", url: "postgres://v26:v26pass@127.0.0.1:15432/v26" },
];

export async function openDb(kind) {
  if (kind === "sqlite") {
    for (const f of [SQLITE_FILE, SQLITE_FILE + "-wal", SQLITE_FILE + "-shm", SQLITE_FILE + "-journal"]) rmSync(f, { force: true });
    const { createClient } = await import("@libsql/client");
    const { drizzle } = await import("drizzle-orm/libsql");
    const client = createClient({ url: "file:" + SQLITE_FILE });
    const db = drizzle(client, { schema: sqliteSchema });
    const ddl = await kit.generateSQLiteMigration(await kit.generateSQLiteDrizzleJson({}), await kit.generateSQLiteDrizzleJson(sqliteSchema));
    for (const s of ddl) await client.execute(s);
    return wrap({ kind, provider: "sqlite", db, schema: sqliteSchema, ddl, raw: async (q) => (await client.execute(q)).rows, close: () => client.close() });
  }
  if (kind === "mysql" || kind === "mariadb") {
    const mysql = (await import("mysql2/promise")).default;
    const { drizzle } = await import("drizzle-orm/mysql2");
    const url = DBS.find((d) => d.kind === kind).url;
    const pool = mysql.createPool({ uri: url, connectionLimit: 5 });
    await pool.query("SET FOREIGN_KEY_CHECKS=0");
    for (const t of TABLES) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    const db = drizzle(pool, { schema: mysqlSchema, mode: "default" });
    const ddl = await kit.generateMySQLMigration(await kit.generateMySQLDrizzleJson({}), await kit.generateMySQLDrizzleJson(mysqlSchema));
    const conn = await pool.getConnection();
    for (const s of ddl) await conn.query(s);
    conn.release();
    return wrap({ kind, provider: "mysql", db, schema: mysqlSchema, ddl, raw: async (q) => (await pool.query(q))[0], close: () => pool.end() });
  }
  if (kind === "pg") {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(DBS.find((d) => d.kind === kind).url, { max: 5, onnotice: () => {} });
    for (const t of TABLES) await client.unsafe(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    const db = drizzle(client, { schema: pgSchema });
    const ddl = await kit.generateMigration(await kit.generateDrizzleJson({}), await kit.generateDrizzleJson(pgSchema));
    for (const s of ddl) await client.unsafe(s);
    return wrap({ kind, provider: "pg", db, schema: pgSchema, ddl, raw: (q) => client.unsafe(q), close: () => client.end() });
  }
  throw new Error("unknown db " + kind);
}

function wrap(h) {
  const n = async (table) => (await h.db.select({ n: count() }).from(h.schema[table]))[0].n;
  h.counts = async () => ({ user: Number(await n("user")), account: Number(await n("account")) });
  h.userByEmail = async (email) => (await h.db.select().from(h.schema.user).where(eq(h.schema.user.email, email)))[0];
  h.sessionByToken = async (token) => (await h.db.select().from(h.schema.session).where(eq(h.schema.session.token, token)))[0];
  h.sql = sql;
  return h;
}
