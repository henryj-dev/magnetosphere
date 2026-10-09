// 런타임 DB 테스트용 빈 DB. 열 때마다 이름이 겹치지 않는 DB 를 만들고 packages/db 에 커밋된 마이그레이션을 적용한 뒤
// DATABASE_URL 을 돌려준다. 런타임 어댑터(createNodeRuntime)가 이 주소로 붙는다.
// MySQL·MariaDB·Postgres 는 저장소 최상위 docker-compose.test.yml 의 컨테이너에 붙는다 (scripts/test-db.mjs 가 띄운다).
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DbKind = "sqlite" | "mysql" | "mariadb" | "pg";

const MIGRATIONS = (d: string) => fileURLToPath(new URL(`../../db/migrations/${d}`, import.meta.url));
const MYSQL_PORT = { mysql: 33306, mariadb: 33307 } as const;
const PG = { host: "127.0.0.1", port: 35432, username: "mg", password: "mgpass", onnotice: () => {} };

export interface TestDb {
  kind: DbKind;
  url: string;
  /** 서버(MySQL 전역)·DB(Postgres) 시간대를 UTC 가 아닌 값으로 바꾼다. drop() 이 되돌린다 */
  setNonUtcTimeZone(): Promise<void>;
  /** 런타임을 거치지 않은 연결의 세션 시간대 (대조용) */
  rawSessionTimeZone(): Promise<string>;
  /** 런타임을 거치지 않은 연결로 user 행을 DB now() 로 넣고 읽는다 (대조용: 세션 시간대가 그대로 드러난다) */
  rawInsertUserCreatedAt(id: string): Promise<Date>;
  /** 런타임을 거치지 않은(세션 시간대를 강제하지 않은) 연결로 생성 스키마 그대로 user 행을 넣고 읽는다 (TC-S6.T3.c) */
  rawSchemaInsertUserCreatedAt(id: string): Promise<Date>;
  drop(): Promise<void>;
}

export const enabledDbs = (): DbKind[] => (process.env.MG_TEST_DBS ?? "").split(",").filter(Boolean) as DbKind[];

export const LABEL: Record<DbKind, string> = { sqlite: "SQLite(libsql)", mysql: "MySQL 8.0", mariadb: "MariaDB 10.11", pg: "Postgres 14" };

export async function createTestDb(kind: DbKind): Promise<TestDb> {
  if (kind === "sqlite") return sqlite();
  if (kind === "pg") return pg();
  return mysqlLike(kind);
}

async function sqlite(): Promise<TestDb> {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  const dir = mkdtempSync(path.join(tmpdir(), "mg-runtime-sqlite-"));
  const url = "file:" + path.join(dir, "rt.sqlite");
  const client = createClient({ url });
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS("sqlite") });
  client.close();
  const unsupported = async (): Promise<never> => {
    throw new Error("SQLite 에는 세션 시간대가 없다");
  };
  return {
    kind: "sqlite",
    url,
    setNonUtcTimeZone: unsupported,
    rawSessionTimeZone: unsupported,
    rawInsertUserCreatedAt: unsupported,
    rawSchemaInsertUserCreatedAt: unsupported,
    async drop() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function mysqlLike(kind: "mysql" | "mariadb"): Promise<TestDb> {
  const mysql = (await import("mysql2/promise")).default;
  const { drizzle } = await import("drizzle-orm/mysql2");
  const { migrate } = await import("drizzle-orm/mysql2/migrator");
  const schema = await import("@magnetosphere/db/src/schema/mysql.ts");
  const port = MYSQL_PORT[kind];
  const root = { host: "127.0.0.1", port, user: "root", password: "mgroot" };
  const database = `mg_rt_${randomBytes(4).toString("hex")}`;
  const admin = await mysql.createConnection(root);
  await admin.query(`CREATE DATABASE ${database}`);
  const [[{ tz }]] = (await admin.query("SELECT @@GLOBAL.time_zone AS tz")) as unknown as [[{ tz: string }]];
  const pool = mysql.createPool({ ...root, database, connectionLimit: 2 });
  await migrate(drizzle(pool, { schema, mode: "default" }), { migrationsFolder: MIGRATIONS("mysql") });
  await pool.end();
  let changed = false;
  // 시간대 설정 없이 붙는 평범한 연결 (서버 시간대를 그대로 따른다)
  const raw = () => mysql.createConnection({ ...root, database });
  return {
    kind,
    url: `mysql://root:mgroot@127.0.0.1:${port}/${database}`,
    async setNonUtcTimeZone() {
      // 세션 시간대는 연결할 때 전역 값에서 온다. 이 뒤에 연 연결은 '+09:00' 으로 시작한다
      await admin.query("SET GLOBAL time_zone = '+09:00'");
      changed = true;
    },
    async rawSessionTimeZone() {
      const c = await raw();
      const [[{ tz: s }]] = (await c.query("SELECT @@SESSION.time_zone AS tz")) as unknown as [[{ tz: string }]];
      await c.end();
      return s;
    },
    async rawInsertUserCreatedAt(id) {
      const c = await raw();
      const db = drizzle(c, { schema, mode: "default" });
      await c.query("INSERT INTO `user` (id, name, email, created_at, updated_at) VALUES (?, ?, ?, NOW(3), NOW(3))", [id, id, `${id}@example.com`]);
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select().from(schema.user).where(eq(schema.user.id, id));
      await c.end();
      return row.createdAt;
    },
    async rawSchemaInsertUserCreatedAt(id) {
      const c = await raw();
      const db = drizzle(c, { schema, mode: "default" });
      await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select().from(schema.user).where(eq(schema.user.id, id));
      await c.end();
      return row.createdAt;
    },
    async drop() {
      if (changed) await admin.query(`SET GLOBAL time_zone = ${admin.escape(tz)}`);
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    },
  };
}

async function pg(): Promise<TestDb> {
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const schema = await import("@magnetosphere/db/src/schema/pg.ts");
  const database = `mg_rt_${randomBytes(4).toString("hex")}`;
  const admin = postgres({ ...PG, database: "postgres", max: 1 });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const mig = postgres({ ...PG, database, max: 1 });
  await migrate(drizzle(mig, { schema }), { migrationsFolder: MIGRATIONS("pg") });
  await mig.end();
  const raw = () => postgres({ ...PG, database, max: 1 });
  return {
    kind: "pg",
    url: `postgres://mg:mgpass@127.0.0.1:35432/${database}`,
    async setNonUtcTimeZone() {
      // 이 DB 에 새로 붙는 연결의 기본 TimeZone. DB 를 지우면 같이 사라진다
      await admin.unsafe(`ALTER DATABASE ${database} SET TimeZone = 'Asia/Seoul'`);
    },
    async rawSessionTimeZone() {
      const c = raw();
      const [{ TimeZone }] = await c.unsafe("SHOW TimeZone");
      await c.end();
      return String(TimeZone);
    },
    async rawInsertUserCreatedAt(id) {
      const c = raw();
      const db = drizzle(c, { schema });
      await c.unsafe(`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ($1, $2, $3, now(), now())`, [id, id, `${id}@example.com`]);
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select().from(schema.user).where(eq(schema.user.id, id));
      await c.end();
      return row.createdAt;
    },
    async rawSchemaInsertUserCreatedAt(id) {
      const c = raw();
      const db = drizzle(c, { schema });
      await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select().from(schema.user).where(eq(schema.user.id, id));
      await c.end();
      return row.createdAt;
    },
    async drop() {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    },
  };
}
