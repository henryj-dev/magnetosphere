// H1: 0003까지의 기존 회원·세션은 0004 적용 뒤 legacy·NULL fingerprint로 보존한다.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
type Kind = "sqlite" | "mysql" | "mariadb" | "pg" | "d1";
const selected = (process.env.MG_TEST_DBS ?? "sqlite").split(",") as Kind[];
const migrations = (dialect: string) => path.join(PKG, "migrations", dialect);
interface Upgrade {
  first(): Promise<void>;
  rest(): Promise<void>;
  rows(sql: string): Promise<any[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
async function open(kind: Kind): Promise<Upgrade> {
  const dialect = kind === "d1" ? "sqlite" : kind === "mariadb" ? "mysql" : kind;
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0004-upgrade-"));
  const old = path.join(dir, "old");
  cpSync(migrations(dialect), old, { recursive: true });
  const journalFile = path.join(old, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalFile, "utf8"));
  expect(journal.entries.at(-1).tag).toBe("0004_m2_confirmation");
  for (const e of journal.entries.slice(4)) rmSync(path.join(old, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, 4);
  writeFileSync(journalFile, JSON.stringify(journal));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  if (kind === "sqlite") {
    const { createClient } = await import("@libsql/client");
    const { drizzle } = await import("drizzle-orm/libsql");
    const { migrate } = await import("drizzle-orm/libsql/migrator");
    const c = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
    return {
      first: () => migrate(drizzle(c), { migrationsFolder: old }),
      rest: () => migrate(drizzle(c), { migrationsFolder: migrations(dialect) }),
      rows: async (sql) => (await c.execute(sql)).rows as any[],
      exec: async (sql) => { await c.execute(sql); },
      close: async () => { c.close(); cleanup(); },
    };
  }
  const database = `mg_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  if (kind === "mysql" || kind === "mariadb") {
    const mysql = (await import("mysql2/promise")).default;
    const { drizzle } = await import("drizzle-orm/mysql2");
    const { migrate } = await import("drizzle-orm/mysql2/migrator");
    const config = { host: "127.0.0.1", port: kind === "mysql" ? 33306 : 33307, user: "root", password: "mgroot" };
    const admin = await mysql.createConnection(config);
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    const c = mysql.createPool({ ...config, database, connectionLimit: 2 });
    return {
      first: () => migrate(drizzle(c), { migrationsFolder: old }),
      rest: () => migrate(drizzle(c), { migrationsFolder: migrations(dialect) }),
      rows: async (sql) => (await c.query(sql))[0] as any[],
      exec: async (sql) => { await c.query(sql); },
      close: async () => {
        await c.end();
        const admin = await mysql.createConnection(config);
        await admin.query(`DROP DATABASE ${database}`);
        await admin.end();
        cleanup();
      },
    };
  }
  if (kind === "pg") {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const config = { host: "127.0.0.1", port: 35432, username: "mg", password: "mgpass", max: 2, onnotice: () => {} };
    const admin = postgres({ ...config, database: "postgres" });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    await admin.end();
    const c = postgres({ ...config, database });
    return {
      first: () => migrate(drizzle(c), { migrationsFolder: old }),
      rest: () => migrate(drizzle(c), { migrationsFolder: migrations(dialect) }),
      rows: async (sql) => [...await c.unsafe(sql)],
      exec: async (sql) => { await c.unsafe(sql); },
      close: async () => {
        await c.end();
        const admin = postgres({ ...config, database: "postgres" });
        await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
        await admin.end();
        cleanup();
      },
    };
  }
  const { getPlatformProxy } = await import("wrangler");
  const config = (folder: string) => {
    const file = path.join(dir, `wrangler-${path.basename(folder)}.jsonc`);
    writeFileSync(file, JSON.stringify({ name: "mg-upgrade-0004", compatibility_date: "2026-07-29", d1_databases: [{ binding: "DB", database_name: "upgrade-0004", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: folder }] }));
    return file;
  };
  const apply = async (folder: string) => {
    const r = spawnSync(process.execPath, [path.join(PKG, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--local", "--config", config(folder), "--persist-to", dir], { cwd: PKG, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
    if (r.status !== 0) throw new Error(`D1 migration exit ${r.status}\n${r.stdout}${r.stderr}`);
  };
  const query = async (sql: string) => {
    const proxy = await getPlatformProxy<{ DB: any }>({ configPath: config(migrations(dialect)), persist: { path: path.join(dir, "v3") } });
    try { return (await proxy.env.DB.prepare(sql).all()).results; }
    finally { await proxy.dispose(); }
  };
  return { first: () => apply(old), rest: () => apply(migrations(dialect)), rows: query, exec: async (sql) => { await query(sql); }, close: async () => { cleanup(); } };
}

test("0004 업그레이드는 DB를 하나 이상 선택한다", () => expect(selected.length).toBeGreaterThan(0));
describe.each(selected)("%s", (kind) => {
  test("TC-M2.T8.migration: 기존 미인증 행 legacy·기존 세션 NULL, 계정·권한·비밀번호·세션 값 보존", async () => {
    const db = await open(kind);
    try {
      await db.first();
      const q = kind === "pg" ? '"' : "`";
      const at = kind === "sqlite" || kind === "d1" ? "1767225600000" : "'2026-01-01 00:00:00.000'";
      const no = kind === "pg" ? "false" : "0";
      await db.exec(`INSERT INTO ${q}user${q} (id,name,email,email_verified,created_at,updated_at,role,status) VALUES ('u-old','Old','old@example.com',${no},${at},${at},'member','pending')`);
      await db.exec(`INSERT INTO ${q}account${q} (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES ('a-old','u-old','credential','u-old','preserved-test-hash',${at},${at})`);
      await db.exec(`INSERT INTO ${q}session${q} (id,token,user_id,expires_at,created_at,updated_at) VALUES ('s-old','old-test-token','u-old',${at},${at},${at})`);
      await db.rest();
      const [user] = await db.rows(`SELECT signup_origin,email,email_verified,role,status FROM ${q}user${q} WHERE id='u-old'`);
      expect({ ...user, email_verified: Boolean(user.email_verified) }).toEqual({ signup_origin: "legacy", email: "old@example.com", email_verified: false, role: "member", status: "pending" });
      expect(await db.rows(`SELECT credential_fingerprint,token,user_id FROM ${q}session${q} WHERE id='s-old'`)).toEqual([{ credential_fingerprint: null, token: "old-test-token", user_id: "u-old" }]);
      expect(await db.rows(`SELECT password FROM ${q}account${q} WHERE id='a-old'`)).toEqual([{ password: "preserved-test-hash" }]);
      await db.exec(`UPDATE ${q}session${q} SET credential_fingerprint='${"a".repeat(64)}' WHERE id='s-old'`);
      expect((await db.rows(`SELECT credential_fingerprint FROM ${q}session${q}`))[0].credential_fingerprint).toHaveLength(64);
    } finally { await db.close(); }
  });
});
