// V27: Worker 안에서 Drizzle 로 MySQL·Postgres 에 쓰기·읽기·트랜잭션 롤백을 확인한다.
import { createConnection } from "mysql2/promise";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { mysqlTable, varchar as myVarchar } from "drizzle-orm/mysql-core";
import pg from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { pgTable, varchar as pgVarchar } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";

const myProbe = mysqlTable("v27_probe", {
  id: myVarchar("id", { length: 36 }).primaryKey(),
  note: myVarchar("note", { length: 64 }).notNull(),
});
const pgProbe = pgTable("v27_probe", {
  id: pgVarchar("id", { length: 36 }).primaryKey(),
  note: pgVarchar("note", { length: 64 }).notNull(),
});

class Rollback extends Error {}

async function run(db, table, createSql) {
  await db.execute(sql.raw(createSql));
  const id = crypto.randomUUID();
  const txId = crypto.randomUUID();

  await db.insert(table).values({ id, note: "write" });
  const write = true;

  const rows = await db.select().from(table).where(eq(table.id, id));
  const read = rows.length === 1 && rows[0].note === "write";

  let threw = false;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(table).values({ id: txId, note: "tx" });
      const inside = await tx.select().from(table).where(eq(table.id, txId));
      if (inside.length !== 1) throw new Error("트랜잭션 안에서 삽입한 행이 안 보인다");
      throw new Rollback("의도한 롤백");
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    threw = true;
  }
  const after = await db.select().from(table).where(eq(table.id, txId));
  const txRollback = threw && after.length === 0;

  await db.delete(table).where(eq(table.id, id));
  return { write, read, txRollback };
}

async function probeMysql(env) {
  const hd = env.HYPERDRIVE_MYSQL;
  const conn = await createConnection({
    host: hd.host,
    user: hd.user,
    password: hd.password,
    database: hd.database,
    port: hd.port,
    disableEval: true, // Workers 에는 eval 이 없다
  });
  try {
    const db = drizzleMysql(conn);
    const res = await run(
      db,
      myProbe,
      "CREATE TABLE IF NOT EXISTS v27_probe (id VARCHAR(36) PRIMARY KEY, note VARCHAR(64) NOT NULL) ENGINE=InnoDB",
    );
    const [[v]] = await conn.query("SELECT VERSION() AS v");
    return { ...res, server: v.v, driver: "mysql2 + drizzle-orm/mysql2", binding: { host: hd.host, port: hd.port } };
  } finally {
    await conn.end();
  }
}

async function probePg(env) {
  const hd = env.HYPERDRIVE_PG;
  const client = new pg.Client({ connectionString: hd.connectionString });
  await client.connect();
  try {
    const db = drizzlePg(client);
    const res = await run(
      db,
      pgProbe,
      "CREATE TABLE IF NOT EXISTS v27_probe (id VARCHAR(36) PRIMARY KEY, note VARCHAR(64) NOT NULL)",
    );
    const { rows } = await client.query("SHOW server_version");
    return { ...res, server: rows[0].server_version, driver: "pg + drizzle-orm/node-postgres", binding: { host: hd.host, port: hd.port } };
  } finally {
    await client.end();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/probe") return new Response("not found", { status: 404 });
    const which = url.searchParams.get("db");
    try {
      if (which === "mysql") return Response.json(await probeMysql(env));
      if (which === "pg") return Response.json(await probePg(env));
      return Response.json({ error: "db=mysql|pg" }, { status: 400 });
    } catch (e) {
      return Response.json(
        { write: false, read: false, txRollback: false, error: String(e?.stack ?? e) },
        { status: 500 },
      );
    }
  },
};
