// Workers 런타임 어댑터 (Workers + D1·Hyperdrive MySQL·Postgres, 계획서 3.2).
// - 요청(또는 Cron 호출)마다 하나 만든다. Workers 는 요청 사이에 연결을 들고 있을 수 없어 db() 도 요청마다 새 연결이다 (V27).
//   끝나면 close() 를 ctx.waitUntil 에 넘긴다.
// - Hyperdrive MySQL 은 mysql2 + disableEval: true (Workers 에는 eval 이 없다, V27), nodejs_compat 이 필요하다.
// - 세션 시간대는 Node 와 같이 UTC 로 맞춘다 (TC-S4.T1.d). D1 은 시각이 정수라 해당 없음.
// - clientIp(): CF-Connecting-IP 만 믿는다. X-Forwarded-For 는 클라이언트가 지어낼 수 있어 보지 않는다 (TC-S4.T1.c).
// - schedule(): 등록만 하고, Workers 진입점의 scheduled() 가 runScheduled(cron) 으로 부른다. Cron Trigger 는 같은 cron 에
//   한 번만 불리므로 임대가 필요 없다.
import { isValidIP } from "@better-auth/core/utils/ip";
import { cronIntervalMinutes, type DbHandle, type Job, type Runtime } from "./types.ts";

/** Hyperdrive 바인딩에서 쓰는 필드 */
export interface HyperdriveBinding {
  connectionString: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Workers env. 바인딩 이름은 DB(D1) 또는 HYPERDRIVE. 나머지 문자열은 비밀 값·변수다 */
export interface WorkersEnv {
  DB?: unknown;
  HYPERDRIVE?: HyperdriveBinding;
  [name: string]: unknown;
}

export interface WorkersRuntime extends Runtime {
  /** Cron Trigger 가 부른 cron 에 등록된 작업을 돈다 */
  runScheduled(cron: string): Promise<void>;
}

export async function connectWorkers(env: WorkersEnv): Promise<DbHandle> {
  if (env.DB) {
    const { drizzle } = await import("drizzle-orm/d1");
    const schema = await import("@magnetosphere/db/src/schema/sqlite.ts");
    return { kind: "d1", provider: "sqlite", db: drizzle(env.DB as any, { schema }), schema, close: async () => {} };
  }
  const hd = env.HYPERDRIVE;
  if (!hd) throw new Error("DB 바인딩이 없다 (D1 은 DB, MySQL·Postgres 는 HYPERDRIVE)");
  if (/^mysql:/i.test(hd.connectionString)) {
    const mysql = (await import("mysql2/promise")).default;
    const { drizzle } = await import("drizzle-orm/mysql2");
    const schema = await import("@magnetosphere/db/src/schema/mysql.ts");
    const conn = await mysql.createConnection({
      host: hd.host,
      port: hd.port,
      user: hd.user,
      password: hd.password,
      database: hd.database,
      disableEval: true,
      timezone: "Z",
    });
    await conn.query("SET time_zone = '+00:00'");
    return { kind: "mysql", provider: "mysql", db: drizzle(conn, { schema, mode: "default" }), schema, close: () => conn.end() };
  }
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("@magnetosphere/db/src/schema/pg.ts");
  const client = postgres(hd.connectionString, { connection: { TimeZone: "UTC" }, max: 5, fetch_types: false, onnotice: () => {} });
  return { kind: "pg", provider: "pg", db: drizzle(client, { schema }), schema, close: () => client.end() };
}

/** CF-Connecting-IP 로 클라이언트 IP 를 정한다. 없거나 IP 가 아니면 null */
export function workersClientIp(req: Request): string | null {
  const ip = req.headers.get("cf-connecting-ip")?.trim();
  return ip && isValidIP(ip) ? ip : null;
}

export function createWorkersRuntime(env: WorkersEnv): WorkersRuntime {
  const jobs = new Map<string, { name: string; fn: Job }[]>();
  let handle: Promise<DbHandle> | undefined;
  return {
    db() {
      handle ??= connectWorkers(env);
      return handle;
    },
    schedule(name, cron, fn) {
      cronIntervalMinutes(cron); // Node 와 같은 모양만 받는다
      jobs.set(cron, [...(jobs.get(cron) ?? []), { name, fn }]);
    },
    async runScheduled(cron) {
      // 한 작업이 실패해도 나머지는 돈다. 실패는 모아서 Cron 호출 실패로 드러낸다
      const errors: unknown[] = [];
      for (const job of jobs.get(cron) ?? []) await job.fn().catch((e) => errors.push(new Error(`주기 작업 ${job.name} 실패`, { cause: e })));
      if (errors.length) throw new AggregateError(errors, `cron "${cron}" 작업 ${errors.length}개 실패`);
    },
    rateLimitStore: () => ({ storage: "database" }),
    secret(name) {
      const v = env[name];
      return typeof v === "string" ? v : undefined;
    },
    clientIp: workersClientIp,
    async close() {
      if (handle) await (await handle).close();
      handle = undefined;
    },
  };
}
