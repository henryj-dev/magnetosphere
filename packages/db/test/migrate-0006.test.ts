// TC-M6.T5.b 0006 소급 익명화 (M6 후속 U1). 0005 까지 적용한 DB 에 삭제 회원·수락 초대를 넣고 0006 을 적용한다.
//   pnpm -C packages/db test:migrate -t "TC-M6.T5.b" --db sqlite,mysql,mariadb,pg,d1
// 이미 삭제한 회원(status = 'deleted')이 수락한 초대의 email 만 user 와 같은 익명값으로 바뀐다. used_by·다른 칸·다른 초대는 그대로다.
// 업그레이드 장치(open·fixture)는 migrate-0005.test.ts 와 같은 꼴이다. 0005 시험 파일은 M4 봉인 산출물이라 장치를 거기서 빼내지 않고 옮겨 적었다.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

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
function quote(kind: Kind): string { return kind === "pg" ? '"' : "`"; }
function sqlTime(kind: Kind): string { return kind === "sqlite" || kind === "d1" ? "1767225600000" : "'2026-01-01 00:00:00.000'"; }
function sqlFalse(kind: Kind): string { return kind === "pg" ? "false" : "0"; }
function assertNoCleanupError(errors: unknown[]): void {
  if (errors.length === 0) return;
  throw new AggregateError(errors, `0006 시험 정리 실패 ${errors.length}건`);
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
  throw new Error(`0006 업그레이드 DB를 열 수 없다: ${String(kind)}`);
}
async function openSqlite(): Promise<Upgrade> {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0006-upgrade-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0006-upgrade-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0006-upgrade-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0006-upgrade-"));
  const errors: unknown[] = [];
  try {
    const old = fixture(dir, "sqlite");
    const { getPlatformProxy } = await import("wrangler");
    const config = (folder: string) => {
      const file = path.join(dir, `wrangler-${path.basename(folder)}.jsonc`);
      writeFileSync(file, JSON.stringify({ name: "mg-upgrade-0006", compatibility_date: "2026-07-29", d1_databases: [{ binding: "DB", database_name: "upgrade-0006", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: folder }] }));
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
  // 0005 까지만 남긴다. 0006 뒤 마이그레이션이 더해져도 자리(idx)로 본다
  if (journal.entries[6]?.tag !== "0006_m6_invite_anonymize") throw new Error(`0006 journal 태그가 아니다: ${journal.entries[6]?.tag}`);
  for (const e of journal.entries.slice(6)) rmSync(path.join(old, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, 6);
  writeFileSync(journalFile, JSON.stringify(journal));
  return old;
}

interface InviteSeed { id: string; email: string | null; usedBy: string | null; revoked: boolean }
const DELETED = "u-deleted";
const ACTIVE = "u-active";
const INVITES: InviteSeed[] = [
  { id: "i-deleted-accepted", email: "gone@example.com", usedBy: DELETED, revoked: false }, // 바뀐다
  { id: "i-deleted-old-email", email: "Gone.Old@example.com", usedBy: DELETED, revoked: false }, // 바뀐다 (예전 이메일로 수락)
  { id: "i-deleted-null", email: null, usedBy: DELETED, revoked: false }, // NULL 그대로
  { id: "i-active-accepted", email: "here@example.com", usedBy: ACTIVE, revoked: false }, // 그대로
  { id: "i-pending-gone", email: "gone@example.com", usedBy: null, revoked: false }, // 미사용은 소급 대상이 아니다 (삭제 전 이메일을 알 수 없다)
  { id: "i-revoked-gone", email: "gone@example.com", usedBy: null, revoked: true }, // 그대로
  { id: "i-orphan", email: "orphan@example.com", usedBy: "u-missing", revoked: false }, // user 가 없는 used_by 는 그대로
];

test("0006 업그레이드는 허용한 DB만 하나 이상 선택한다", () => {
  expect(selected.length).toBeGreaterThan(0);
  expect(selected.every((kind) => KINDS.includes(kind))).toBe(true);
});
describe.each(selected)("%s", (kind) => {
  test("TC-M6.T5.b: 0006 은 삭제 회원이 수락한 초대 email 만 익명값으로 바꾸고 used_by 와 다른 초대는 남긴다", async () => {
    const db = await open(kind);
    try {
      await db.first();
      const q = quote(kind);
      const at = sqlTime(kind);
      const no = sqlFalse(kind);
      const str = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
      await db.exec(`INSERT INTO ${q}user${q} (id,name,email,email_verified,created_at,updated_at,role,status) VALUES ('${DELETED}','',${str(`deleted-${DELETED}@invalid`)},${no},${at},${at},'member','deleted')`);
      await db.exec(`INSERT INTO ${q}user${q} (id,name,email,email_verified,created_at,updated_at,role,status) VALUES ('${ACTIVE}','Here','here@example.com',${no},${at},${at},'member','active')`);
      for (const i of INVITES) {
        const used = i.usedBy === null ? "NULL" : at;
        const revoked = i.revoked ? at : "NULL";
        expect(await db.exec(`INSERT INTO ${q}invites${q} (id,email,token_hash,role,expires_at,used_at,created_by,revoked_at,used_by) VALUES ('${i.id}',${str(i.email)},'hash-${i.id}','member',${at},${used},'${ACTIVE}',${revoked},${str(i.usedBy)})`)).toBe(1);
      }
      const snapshot = async () => (await db.rows(`SELECT id,email,used_by,used_at,revoked_at,expires_at,created_by,role FROM ${q}invites${q} ORDER BY id`))
        .map((r) => ({ id: r.id, email: r.email, usedBy: r.used_by, usedAt: r.used_at === null ? null : String(r.used_at), revokedAt: r.revoked_at === null ? null : String(r.revoked_at), expiresAt: String(r.expires_at), createdBy: r.created_by, role: r.role }));
      const before = await snapshot();
      expect(before.map((r) => ({ id: r.id, email: r.email, usedBy: r.usedBy }))).toEqual([...INVITES].sort((a, b) => (a.id < b.id ? -1 : 1)).map((i) => ({ id: i.id, email: i.email, usedBy: i.usedBy })));
      await db.rest();
      const changed = new Set(["i-deleted-accepted", "i-deleted-old-email"]);
      expect(await snapshot()).toEqual(before.map((r) => (changed.has(r.id) ? { ...r, email: `deleted-${DELETED}@invalid` } : r)));
      // user 행은 0006 이 건드리지 않는다
      const users = await db.rows(`SELECT id,email,status FROM ${q}user${q} ORDER BY id`);
      expect(users.map((u) => ({ id: u.id, email: u.email, status: u.status }))).toEqual([
        { id: ACTIVE, email: "here@example.com", status: "active" },
        { id: DELETED, email: `deleted-${DELETED}@invalid`, status: "deleted" },
      ]);
    } finally { await db.close(); }
  });
});
