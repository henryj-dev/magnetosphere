// TC-A1.T1.migration 0007 관리자 MFA (A1). 0006 까지 적용한 DB 에 회원·세션을 넣고 0007 을 적용한다.
//   pnpm -C packages/db test:migrate -t "TC-A1.T1.migration" --db sqlite,mysql,mariadb,pg,d1
// 기존 세션의 MFA 칼럼은 NULL 이라 MFA 충족으로 소급되지 않는다. 새 테이블의 고유 키·시간 step CAS 문장의 행 수·회원 삭제 cascade 를 DB 마다 본다
// (D1 은 packages/auth 저장소 시험이 돌지 않아 CAS 문장 행 수를 여기서 본다).
// 업그레이드 장치(open·fixture)는 migrate-0006.test.ts 와 같은 꼴이다. 0006 시험 파일은 M6 봉인 산출물이라 장치를 거기서 빼내지 않고 옮겨 적었다.
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
  throw new AggregateError(errors, `0007 시험 정리 실패 ${errors.length}건`);
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
  throw new Error(`0007 업그레이드 DB를 열 수 없다: ${String(kind)}`);
}
async function openSqlite(): Promise<Upgrade> {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0007-upgrade-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0007-upgrade-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0007-upgrade-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "mg-0007-upgrade-"));
  const errors: unknown[] = [];
  try {
    const old = fixture(dir, "sqlite");
    const { getPlatformProxy } = await import("wrangler");
    const config = (folder: string) => {
      const file = path.join(dir, `wrangler-${path.basename(folder)}.jsonc`);
      writeFileSync(file, JSON.stringify({ name: "mg-upgrade-0007", compatibility_date: "2026-07-29", d1_databases: [{ binding: "DB", database_name: "upgrade-0007", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: folder }] }));
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
  // 0006 까지만 남긴다. 0007 뒤 마이그레이션이 더해져도 자리(idx)로 본다
  if (journal.entries[7]?.tag !== "0007_a1_mfa") throw new Error(`0007 journal 태그가 아니다: ${journal.entries[7]?.tag}`);
  for (const e of journal.entries.slice(7)) rmSync(path.join(old, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, 7);
  writeFileSync(journalFile, JSON.stringify(journal));
  return old;
}


test("0007 업그레이드는 허용한 DB만 하나 이상 선택한다", () => {
  expect(selected.length).toBeGreaterThan(0);
  expect(selected.every((kind) => KINDS.includes(kind))).toBe(true);
});
describe.each(selected)("%s", (kind) => {
  test("TC-A1.T1.migration: 0007 뒤 기존 세션은 MFA 미충족이고 slot·복구 코드 고유 키와 step CAS 가 행 수를 지킨다", async () => {
    const db = await open(kind);
    try {
      await db.first();
      const q = quote(kind);
      const at = sqlTime(kind);
      const no = sqlFalse(kind);
      await db.exec(`INSERT INTO ${q}user${q} (id,name,email,email_verified,created_at,updated_at,role,status) VALUES ('u-admin','Admin','admin@example.com',${no},${at},${at},'admin','active')`);
      await db.exec(`INSERT INTO ${q}session${q} (id,token,user_id,expires_at,created_at,updated_at) VALUES ('s-old','old-test-token','u-admin',${at},${at},${at})`);
      await db.rest();
      // 기존 세션은 보존되고 MFA 칼럼은 비어 있다
      expect(await db.rows(`SELECT id,token,auth_version,mfa_verified_at,mfa_factor_id,mfa_method,mfa_policy_version FROM ${q}session${q} WHERE id='s-old'`)).toEqual([
        { id: "s-old", token: "old-test-token", auth_version: 0, mfa_verified_at: null, mfa_factor_id: null, mfa_method: null, mfa_policy_version: null },
      ]);
      for (const table of ["mfa_factor", "mfa_recovery_code", "mfa_enrollment_grant", "mfa_proof"]) expect(await db.rows(`SELECT * FROM ${q}${table}${q}`)).toEqual([]);

      const factor = (id: string, state: string, active: string | null, pending: string | null) =>
        `INSERT INTO ${q}mfa_factor${q} (id,user_id,kind,state,secret_enc,period_s,digits,algorithm,active_slot,pending_slot,created_at) VALUES ('${id}','u-admin','totp','${state}','v1:test',30,6,'SHA-1',${active === null ? "NULL" : `'${active}'`},${pending === null ? "NULL" : `'${pending}'`},${at})`;
      expect(await db.exec(factor("f-active", "active", "u-admin", null))).toBe(1);
      expect(await db.exec(factor("f-pending", "pending", null, "u-admin"))).toBe(1);
      // 폐기 행은 slot 이 NULL 이라 여러 개 둘 수 있다
      expect(await db.exec(factor("f-old-1", "revoked", null, null))).toBe(1);
      expect(await db.exec(factor("f-old-2", "revoked", null, null))).toBe(1);
      // 회원당 active 하나·pending 하나
      await expect(db.exec(factor("f-active-2", "active", "u-admin", null))).rejects.toThrow();
      await expect(db.exec(factor("f-pending-2", "pending", null, "u-admin"))).rejects.toThrow();

      // 시간 step CAS: 같은 step·과거 step 은 0행
      const cas = (step: number) => `UPDATE ${q}mfa_factor${q} SET last_used_step = ${step} WHERE id = 'f-active' AND user_id = 'u-admin' AND state = 'active' AND (last_used_step IS NULL OR last_used_step < ${step})`;
      expect(await db.exec(cas(100))).toBe(1);
      expect(await db.exec(cas(100))).toBe(0);
      expect(await db.exec(cas(99))).toBe(0);
      expect(await db.exec(cas(101))).toBe(1);
      // bigint 칸은 2^31 을 넘는 step 도 담는다
      expect(await db.exec(cas(2 ** 40))).toBe(1);
      expect(Number((await db.rows(`SELECT last_used_step FROM ${q}mfa_factor${q} WHERE id='f-active'`))[0].last_used_step)).toBe(2 ** 40);

      // 복구 코드: 같은 factor 의 같은 해시는 한 번만, 소비는 used_at IS NULL 조건 UPDATE 한 번
      const code = (id: string, factorId: string, hash: string) => `INSERT INTO ${q}mfa_recovery_code${q} (id,factor_id,user_id,code_hash) VALUES ('${id}','${factorId}','u-admin','${hash}')`;
      expect(await db.exec(code("rc-1", "f-active", "a".repeat(64)))).toBe(1);
      await expect(db.exec(code("rc-2", "f-active", "a".repeat(64)))).rejects.toThrow();
      expect(await db.exec(code("rc-3", "f-old-1", "a".repeat(64)))).toBe(1);
      // code_hash 는 대소문자를 구분한다 (MySQL utf8mb4_bin)
      expect(await db.exec(code("rc-4", "f-active", "A".repeat(64)))).toBe(1);
      const consume = `UPDATE ${q}mfa_recovery_code${q} SET used_at = ${at}, used_session_id = 's-old' WHERE factor_id = 'f-active' AND code_hash = '${"a".repeat(64)}' AND used_at IS NULL`;
      expect(await db.exec(consume)).toBe(1);
      expect(await db.exec(consume)).toBe(0);

      // grant 토큰 해시 고유
      const grant = (id: string) => `INSERT INTO ${q}mfa_enrollment_grant${q} (id,user_id,token_hash,purpose,auth_version,expires_at) VALUES ('${id}','u-admin','${"b".repeat(64)}','bootstrap',0,${at})`;
      expect(await db.exec(grant("g-1"))).toBe(1);
      await expect(db.exec(grant("g-2"))).rejects.toThrow();
      // proof 도 토큰 해시만 두고 고유하다
      const proof = (id: string) => `INSERT INTO ${q}mfa_proof${q} (id,token_hash,session_id,user_id,auth_version,factor_id,purpose,target,expires_at) VALUES ('${id}','${"c".repeat(64)}','s-old','u-admin',0,'f-active','mfa.reset','u-x',${at})`;
      expect(await db.exec(proof("p-1"))).toBe(1);
      await expect(db.exec(proof("p-2"))).rejects.toThrow();

      // 가입 거절처럼 회원 행을 지워도 MFA 행이 막지 않는다 (ON DELETE CASCADE).
      // foreign_keys 가 꺼진 SQLite 연결은 cascade 가 돌지 않아 행이 남는다 — 그 정리는 삭제 경로가 맡는다
      const enforced = kind === "sqlite" || kind === "d1" ? Number(Object.values((await db.rows("PRAGMA foreign_keys"))[0])[0]) === 1 : true;
      // D1 의 changes 는 cascade 로 지운 행까지 센다. 행 수 대신 회원 행이 사라졌는지 본다
      expect(await db.exec(`DELETE FROM ${q}user${q} WHERE id = 'u-admin'`)).toBeGreaterThanOrEqual(1);
      expect(await db.rows(`SELECT id FROM ${q}user${q} WHERE id = 'u-admin'`)).toEqual([]);
      const left = async (table: string) => Number(Object.values((await db.rows(`SELECT COUNT(*) AS n FROM ${q}${table}${q}`))[0])[0]);
      const counts = { factor: await left("mfa_factor"), code: await left("mfa_recovery_code"), grant: await left("mfa_enrollment_grant"), proof: await left("mfa_proof") };
      expect(counts).toEqual(enforced ? { factor: 0, code: 0, grant: 0, proof: 0 } : { factor: 4, code: 3, grant: 1, proof: 1 });
    } finally { await db.close(); }
  });
});
