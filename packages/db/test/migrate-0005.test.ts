// M4: 0004까지의 기존 회원·계정·세션은 0005 적용 뒤 인증 버전 0으로 보존한다.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionInput, parseSessionOutput, parseUserInput, parseUserOutput } from "better-auth/db";
import type { Session, User } from "better-auth";
import { describe, expect, test } from "vitest";
import { AUTH_SCHEMA_OPTIONS } from "../src/auth-options.ts";
import { AUTH_VERSION_DEFAULT, AUTH_VERSION_MAX } from "../src/schema/common.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const KINDS = ["sqlite", "mysql", "mariadb", "pg", "d1"] as const;
type Kind = (typeof KINDS)[number];
function selectedKinds(): Kind[] {
  const raw = process.env.MG_TEST_DBS ?? "sqlite";
  const kinds = raw.split(",").map((kind) => kind.trim()).filter((kind) => kind !== "");
  if (kinds.length === 0) throw new Error("MG_TEST_DBS 가 비어 있다");
  for (const kind of kinds) if (!KINDS.includes(kind as Kind)) throw new Error(`MG_TEST_DBS 의 알 수 없는 DB: ${kind}`);
  return kinds as Kind[];
}
const selected = selectedKinds();
const migrations = (dialect: string) => path.join(PKG, "migrations", dialect);
interface Upgrade {
  first(): Promise<void>;
  rest(): Promise<void>;
  rows(sql: string): Promise<any[]>;
  exec(sql: string): Promise<number>;
  close(): Promise<void>;
}
interface ColumnMeta { type: string; notNull: boolean; defaultValue: string | null }
const AT = "2026-01-01T00:00:00.000Z";
function quote(kind: Kind): string { return kind === "pg" ? '"' : "`"; }
function sqlTime(kind: Kind): string { return kind === "sqlite" || kind === "d1" ? "1767225600000" : "'2026-01-01 00:00:00.000'"; }
function sqlFalse(kind: Kind): string { return kind === "pg" ? "false" : "0"; }
function assertNoCleanupError(errors: unknown[]): void {
  if (errors.length === 0) return;
  throw new AggregateError(errors, `0005 시험 정리 실패 ${errors.length}건`);
}
async function finish(steps: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { await step(); }
    catch (error) { errors.push(error); }
  }
  assertNoCleanupError(errors);
}
async function open(kind: Kind): Promise<Upgrade> {
  if (kind === "sqlite") return openSqlite();
  if (kind === "mysql" || kind === "mariadb") return openMysql(kind);
  if (kind === "pg") return openPg();
  if (kind === "d1") return openD1();
  throw new Error(`0005 업그레이드 DB를 열 수 없다: ${String(kind)}`);
}
async function openSqlite(): Promise<Upgrade> {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0005-upgrade-"));
  const errors: unknown[] = [];
  try {
    const old = fixture(dir, "sqlite");
    const { createClient } = await import("@libsql/client");
    const { drizzle } = await import("drizzle-orm/libsql");
    const { migrate } = await import("drizzle-orm/libsql/migrator");
    const c = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
    return {
      first: () => migrate(drizzle(c), { migrationsFolder: old }),
      rest: () => migrate(drizzle(c), { migrationsFolder: migrations("sqlite") }),
      rows: async (sql) => (await c.execute(sql)).rows as any[],
      exec: async (sql) => Number((await c.execute(sql)).rowsAffected),
      close: async () => finish([async () => c.close(), async () => rmSync(dir, { recursive: true, force: true })]),
    };
  } catch (error) {
    errors.push(error);
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (cleanup) { errors.push(cleanup); }
    assertNoCleanupError(errors);
    throw error;
  }
}
async function openMysql(kind: "mysql" | "mariadb"): Promise<Upgrade> {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0005-upgrade-"));
  const database = `mg_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  const errors: unknown[] = [];
  let created = false;
  let admin: any;
  let pool: any;
  try {
    const old = fixture(dir, "mysql");
    const mysql = (await import("mysql2/promise")).default;
    const { drizzle } = await import("drizzle-orm/mysql2");
    const { migrate } = await import("drizzle-orm/mysql2/migrator");
    const config = { host: "127.0.0.1", port: kind === "mysql" ? 33306 : 33307, user: "root", password: "mgroot" };
    admin = await mysql.createConnection(config);
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    await admin.end();
    admin = undefined;
    pool = mysql.createPool({ ...config, database, connectionLimit: 2 });
    return {
      first: () => migrate(drizzle(pool), { migrationsFolder: old }),
      rest: () => migrate(drizzle(pool), { migrationsFolder: migrations("mysql") }),
      rows: async (sql) => (await pool.query(sql))[0] as any[],
      exec: async (sql) => Number((await pool.query(sql))[0].affectedRows),
      close: async () => finish([
        async () => { if (pool) await pool.end(); },
        async () => { if (!created) return; const drop = await mysql.createConnection(config); try { await drop.query(`DROP DATABASE ${database}`); } finally { await drop.end(); } },
        async () => rmSync(dir, { recursive: true, force: true }),
      ]),
    };
  } catch (error) {
    errors.push(error);
    await finish([
      async () => { if (pool) await pool.end(); },
      async () => { if (admin) await admin.end(); },
      async () => {
        if (!created) return;
        const mysql = (await import("mysql2/promise")).default;
        const drop = await mysql.createConnection({ host: "127.0.0.1", port: kind === "mysql" ? 33306 : 33307, user: "root", password: "mgroot" });
        try { await drop.query(`DROP DATABASE ${database}`); }
        finally { await drop.end(); }
      },
      async () => rmSync(dir, { recursive: true, force: true }),
    ]).catch((cleanup) => errors.push(cleanup));
    assertNoCleanupError(errors);
    throw error;
  }
}
async function openPg(): Promise<Upgrade> {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0005-upgrade-"));
  const database = `mg_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  const errors: unknown[] = [];
  let created = false;
  let admin: any;
  let client: any;
  try {
    const old = fixture(dir, "pg");
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const config = { host: "127.0.0.1", port: 35432, username: "mg", password: "mgpass", max: 2, onnotice: () => {} };
    admin = postgres({ ...config, database: "postgres" });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    created = true;
    await admin.end();
    admin = undefined;
    client = postgres({ ...config, database });
    return {
      first: () => migrate(drizzle(client), { migrationsFolder: old }),
      rest: () => migrate(drizzle(client), { migrationsFolder: migrations("pg") }),
      rows: async (sql) => [...await client.unsafe(sql)],
      exec: async (sql) => Number((await client.unsafe(sql) as unknown as { count: number }).count),
      close: async () => finish([
        async () => { if (client) await client.end(); },
        async () => { if (!created) return; const drop = postgres({ ...config, database: "postgres" }); try { await drop.unsafe(`DROP DATABASE ${database} WITH (FORCE)`); } finally { await drop.end(); } },
        async () => rmSync(dir, { recursive: true, force: true }),
      ]),
    };
  } catch (error) {
    errors.push(error);
    await finish([
      async () => { if (client) await client.end(); },
      async () => { if (admin) await admin.end(); },
      async () => {
        if (!created) return;
        const postgres = (await import("postgres")).default;
        const drop = postgres({ host: "127.0.0.1", port: 35432, username: "mg", password: "mgpass", max: 1, database: "postgres", onnotice: () => {} });
        try { await drop.unsafe(`DROP DATABASE ${database} WITH (FORCE)`); }
        finally { await drop.end(); }
      },
      async () => rmSync(dir, { recursive: true, force: true }),
    ]).catch((cleanup) => errors.push(cleanup));
    assertNoCleanupError(errors);
    throw error;
  }
}
async function openD1(): Promise<Upgrade> {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0005-upgrade-"));
  const errors: unknown[] = [];
  try {
    const old = fixture(dir, "sqlite");
    const { getPlatformProxy } = await import("wrangler");
    const config = (folder: string) => {
      const file = path.join(dir, `wrangler-${path.basename(folder)}.jsonc`);
      writeFileSync(file, JSON.stringify({ name: "mg-upgrade-0005", compatibility_date: "2026-07-29", d1_databases: [{ binding: "DB", database_name: "upgrade-0005", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: folder }] }));
      return file;
    };
    const apply = async (folder: string) => {
      const r = spawnSync(process.execPath, [path.join(PKG, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--local", "--config", config(folder), "--persist-to", dir], { cwd: PKG, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
      if (r.status !== 0) throw new Error(`D1 migration exit ${r.status}\n${r.stdout}${r.stderr}`);
    };
    const query = async (sql: string) => {
      const proxy = await getPlatformProxy<{ DB: any }>({ configPath: config(migrations("sqlite")), persist: { path: path.join(dir, "v3") } });
      try { return await proxy.env.DB.prepare(sql).all(); }
      finally { await proxy.dispose(); }
    };
    return {
      first: () => apply(old),
      rest: () => apply(migrations("sqlite")),
      rows: async (sql) => (await query(sql)).results,
      exec: async (sql) => Number((await query(sql)).meta.changes),
      close: async () => finish([async () => rmSync(dir, { recursive: true, force: true })]),
    };
  } catch (error) {
    errors.push(error);
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (cleanup) { errors.push(cleanup); }
    assertNoCleanupError(errors);
    throw error;
  }
}
function fixture(dir: string, dialect: "sqlite" | "mysql" | "pg"): string {
  const old = path.join(dir, "old");
  cpSync(migrations(dialect), old, { recursive: true });
  const journalFile = path.join(old, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalFile, "utf8"));
  // 0005 뒤 마이그레이션(0006~)이 더해져도 0005 자리를 본다. 0004 까지만 남기는 아래 slice 는 그대로다
  if (journal.entries[5]?.tag !== "0005_m4_auth_version") throw new Error(`0005 journal 태그가 아니다: ${journal.entries[5]?.tag}`);
  for (const e of journal.entries.slice(5)) rmSync(path.join(old, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, 5);
  writeFileSync(journalFile, JSON.stringify(journal));
  return old;
}
async function column(db: Upgrade, kind: Kind, table: string, name: string): Promise<ColumnMeta> {
  if (kind === "sqlite" || kind === "d1") {
    const row = (await db.rows(`PRAGMA table_info(${table})`)).find((item) => item.name === name);
    if (!row) throw new Error(`${table}.${name} 칼럼이 없다`);
    return { type: String(row.type).toLowerCase(), notNull: Number(row.notnull) === 1, defaultValue: row.dflt_value == null ? null : String(row.dflt_value) };
  }
  if (kind === "mysql" || kind === "mariadb") {
    const [row] = await db.rows(`SELECT column_type AS type, is_nullable AS nullable, column_default AS def FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${name}'`);
    if (!row) throw new Error(`${table}.${name} 칼럼이 없다`);
    return { type: String(row.type).toLowerCase(), notNull: row.nullable === "NO", defaultValue: row.def == null ? null : String(row.def) };
  }
  const [row] = await db.rows(`SELECT data_type AS type, is_nullable AS nullable, column_default AS def FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${name}'`);
  if (!row) throw new Error(`${table}.${name} 칼럼이 없다`);
  return { type: String(row.type).toLowerCase(), notNull: row.nullable === "NO", defaultValue: row.def == null ? null : String(row.def) };
}

test("0005 업그레이드는 허용한 DB만 하나 이상 선택한다", () => {
  expect(selected.length).toBeGreaterThan(0);
  expect(selected.every((kind) => KINDS.includes(kind))).toBe(true);
});
describe.each(selected)("%s", (kind) => {
  test("TC-M4.T1.migration: 기존 회원·계정·세션은 보존되고 auth_version 은 0, 조건 증가는 행 수를 지킨다", async () => {
    const db = await open(kind);
    try {
      await db.first();
      const q = quote(kind);
      const at = sqlTime(kind);
      const no = sqlFalse(kind);
      await db.exec(`INSERT INTO ${q}user${q} (id,name,email,email_verified,created_at,updated_at,role,status) VALUES ('u-old','Old','old@example.com',${no},${at},${at},'member','pending')`);
      await db.exec(`INSERT INTO ${q}account${q} (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES ('a-old','u-old','credential','u-old','preserved-test-hash',${at},${at})`);
      await db.exec(`INSERT INTO ${q}session${q} (id,token,user_id,expires_at,created_at,updated_at) VALUES ('s-old','old-test-token','u-old',${at},${at},${at})`);
      await db.rest();
      const expected = kind === "sqlite" || kind === "d1"
        ? { type: "integer", notNull: true, defaultValue: "0" }
        : kind === "pg"
          ? { type: "integer", notNull: true, defaultValue: "0" }
          : { type: kind === "mariadb" ? "int(11)" : "int", notNull: true, defaultValue: "0" };
      expect(await column(db, kind, "user", "auth_version")).toEqual(expected);
      expect(await column(db, kind, "session", "auth_version")).toEqual(expected);
      const [user] = await db.rows(`SELECT auth_version,signup_origin,email,email_verified,role,status FROM ${q}user${q} WHERE id='u-old'`);
      expect({ ...user, auth_version: Number(user.auth_version), email_verified: Boolean(user.email_verified) }).toEqual({ auth_version: AUTH_VERSION_DEFAULT, signup_origin: "legacy", email: "old@example.com", email_verified: false, role: "member", status: "pending" });
      expect(await db.rows(`SELECT auth_version,credential_fingerprint,token,user_id FROM ${q}session${q} WHERE id='s-old'`)).toEqual([{ auth_version: AUTH_VERSION_DEFAULT, credential_fingerprint: null, token: "old-test-token", user_id: "u-old" }]);
      expect(await db.rows(`SELECT password FROM ${q}account${q} WHERE id='a-old'`)).toEqual([{ password: "preserved-test-hash" }]);
      expect(await db.exec(`UPDATE ${q}session${q} SET credential_fingerprint='${"a".repeat(64)}' WHERE id='s-old'`)).toBe(1);
      expect((await db.rows(`SELECT credential_fingerprint FROM ${q}session${q}`))[0].credential_fingerprint).toHaveLength(64);

      for (const [table, id] of [["user", "u-old"], ["session", "s-old"]] as const) {
        const version = async () => Number((await db.rows(`SELECT auth_version FROM ${q}${table}${q} WHERE id='${id}'`))[0].auth_version);
        expect(await db.exec(`UPDATE ${q}${table}${q} SET auth_version = auth_version + 1 WHERE id='${id}' AND auth_version = ${AUTH_VERSION_DEFAULT}`)).toBe(1);
        expect(await version()).toBe(1);
        expect(await db.exec(`UPDATE ${q}${table}${q} SET auth_version = ${AUTH_VERSION_MAX} WHERE id='${id}'`)).toBe(1);
        expect(await db.exec(`UPDATE ${q}${table}${q} SET auth_version = auth_version + 1 WHERE id='${id}' AND auth_version < ${AUTH_VERSION_MAX}`)).toBe(0);
        expect(await version()).toBe(AUTH_VERSION_MAX);
      }
      expect(await db.exec(`INSERT INTO ${q}user${q} (id,name,email,email_verified,created_at,updated_at) VALUES ('u-new','New','new@example.com',${no},${at},${at})`)).toBe(1);
      expect(await db.exec(`INSERT INTO ${q}session${q} (id,token,user_id,expires_at,created_at,updated_at) VALUES ('s-new','new-test-token','u-new',${at},${at},${at})`)).toBe(1);
      expect(await db.rows(`SELECT auth_version FROM ${q}user${q} WHERE id='u-new'`)).toEqual([{ auth_version: AUTH_VERSION_DEFAULT }]);
      expect(await db.rows(`SELECT auth_version FROM ${q}session${q} WHERE id='s-new'`)).toEqual([{ auth_version: AUTH_VERSION_DEFAULT }]);
      await expect(db.exec(`INSERT INTO ${q}user${q} (id,name,email,email_verified,created_at,updated_at,auth_version) VALUES ('u-null','Null','null-user@example.com',${no},${at},${at},NULL)`)).rejects.toThrow();
      await expect(db.exec(`INSERT INTO ${q}session${q} (id,token,user_id,expires_at,created_at,updated_at,auth_version) VALUES ('s-null','null-test-token','u-new',${at},${at},${at},NULL)`)).rejects.toThrow();
      // SQLite integer 는 64비트라 상한+1 도 저장된다. 32비트 넘침 거부는 MySQL·Postgres 만 따로 확인한다.
      if (kind === "sqlite" || kind === "d1") {
        expect(await db.exec(`UPDATE ${q}user${q} SET auth_version = auth_version + 1 WHERE id='u-old'`)).toBe(1);
        expect(Number((await db.rows(`SELECT auth_version FROM ${q}user${q} WHERE id='u-old'`))[0].auth_version)).toBe(AUTH_VERSION_MAX + 1);
        expect(await db.exec(`UPDATE ${q}session${q} SET auth_version = ${AUTH_VERSION_MAX + 1} WHERE id='s-old'`)).toBe(1);
        expect(Number((await db.rows(`SELECT auth_version FROM ${q}session${q} WHERE id='s-old'`))[0].auth_version)).toBe(AUTH_VERSION_MAX + 1);
      } else {
        for (const [table, id] of [["user", "u-old"], ["session", "s-old"]] as const) {
          await expect(db.exec(`UPDATE ${q}${table}${q} SET auth_version = auth_version + 1 WHERE id='${id}'`)).rejects.toThrow();
          expect(Number((await db.rows(`SELECT auth_version FROM ${q}${table}${q} WHERE id='${id}'`))[0].auth_version)).toBe(AUTH_VERSION_MAX);
        }
      }
    } finally { await db.close(); }
  });
});

test("인증 버전 additional field 는 생성 입력을 0 으로 바꾸고 수정 값과 응답은 거부한다", () => {
  expect(AUTH_VERSION_DEFAULT).toBe(0);
  expect(AUTH_VERSION_MAX).toBe(2147483647);
  expect(Number.isSafeInteger(AUTH_VERSION_MAX + 1)).toBe(true);
  const options = { ...AUTH_SCHEMA_OPTIONS, plugins: [...AUTH_SCHEMA_OPTIONS.plugins] };
  const user: User = { id: "u", name: "회원", email: "a@example.com", emailVerified: false, createdAt: new Date(AT), updatedAt: new Date(AT) };
  const session: Session = { id: "s", token: "session-token", userId: "u", expiresAt: new Date(AT), createdAt: new Date(AT), updatedAt: new Date(AT) };
  const versionedUser: User & { authVersion: number } = { ...user, authVersion: 4 };
  const versionedSession: Session & { authVersion: number } = { ...session, authVersion: 4 };
  const sessionInput: Session & { authVersion: number } = { ...session, authVersion: 9 };
  // 입력 파서는 additionalFields 만 돈다. name·token 같은 코어 필드는 반환하지 않는다 (better-auth 1.7.7 schema.mjs).
  expect(parseUserInput(options, { ...user, authVersion: 9 }, "create")).toEqual({
    role: "member", status: "active", isBootstrapAdmin: false, signupOrigin: "legacy", authVersion: 0,
  });
  expect(() => parseUserInput(options, { ...user, authVersion: 9 }, "update")).toThrow(/authVersion is not allowed to be set/);
  expect(parseUserOutput(options, versionedUser)).toEqual(user);
  expect(parseSessionInput(options, sessionInput, "create")).toEqual({ authVersion: 0 });
  expect(() => parseSessionInput(options, sessionInput, "update")).toThrow(/authVersion is not allowed to be set/);
  expect(parseSessionOutput(options, versionedSession)).toEqual(session);
});
