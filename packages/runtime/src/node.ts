// Node 런타임 어댑터 (Docker 조합 — SQLite·MySQL·MariaDB·Postgres, 계획서 3.2).
// - db(): DATABASE_URL 형식(file:·libsql:, mysql:·mariadb:, postgres:·postgresql:)으로 고른다. 프로세스에 풀 하나.
//   세션 시간대를 항상 UTC 로 맞춘다. DB 기본값(created_at 의 now())이 서버 시간대를 따르기 때문이다 (TC-S4.T1.d).
// - schedule(): 프로세스 안 타이머. 주기 경계마다 job_leases 임대를 잡은 인스턴스 하나만 돈다.
// - clientIp(): 소켓 상대 주소 + 신뢰 프록시 (packages/auth resolveClientIp). Request 에는 소켓이 없으므로
//   listen() 이 요청마다 상대 주소를 묶어 둔다. listen() 을 거치지 않은 요청은 null 이다.
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { findInvalidTrustedProxies } from "@better-auth/core/utils/ip";
import { resolveClientIp } from "@magnetosphere/auth";
import { acquireLease } from "./lease.ts";
import { assertClientIp, cronIntervalMinutes, type DbHandle, type Job, type Runtime } from "./types.ts";

export interface NodeRuntimeOptions {
  /** 환경 변수 (기본 process.env). DATABASE_URL 을 여기서 읽는다 */
  env?: Record<string, string | undefined>;
  /** X-Forwarded-For 를 믿을 프록시 IP·CIDR (예: Caddy). 비우면 X-Forwarded-For 를 보지 않는다 */
  trustedProxies?: readonly string[];
  /** 임대 holder 이름. 기본은 프로세스마다 무작위 */
  instanceId?: string;
  /** 주기 작업 예외 (기본 console.error) */
  onJobError?: (name: string, e: unknown) => void;
}

export interface NodeRuntime extends Runtime {
  /** 요청과 소켓 상대 주소를 묶는다. listen() 이 부른다 */
  bindPeer(req: Request, peer: string | undefined): void;
}

/** DATABASE_URL 로 DB 에 붙는다. 세션 시간대는 UTC */
export async function connectNode(url: string): Promise<DbHandle> {
  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  if (scheme === "file" || scheme === "libsql") {
    // SQLite 드라이버는 libsql 만 쓴다 (V26). 시각은 정수(unixepoch)라 시간대 영향이 없다
    const { createClient } = await import("@libsql/client");
    const { drizzle } = await import("drizzle-orm/libsql");
    const schema = await import("@magnetosphere/db/src/schema/sqlite.ts");
    const client = createClient({ url });
    return { kind: "sqlite", provider: "sqlite", db: drizzle(client, { schema }), schema, close: async () => client.close() };
  }
  if (scheme === "mysql" || scheme === "mariadb") {
    const mysql = (await import("mysql2/promise")).default;
    const { drizzle } = await import("drizzle-orm/mysql2");
    const schema = await import("@magnetosphere/db/src/schema/mysql.ts");
    const pool = mysql.createPool({ uri: url.replace(/^mariadb:/i, "mysql:"), timezone: "Z", connectionLimit: 10 });
    // 새 연결마다 세션 시간대를 UTC 로. 같은 연결의 질의는 순서대로 돌므로 이 SET 이 앱 질의보다 먼저 간다
    pool.pool.on("connection", (conn) => {
      conn.query("SET time_zone = '+00:00'", (e: unknown) => e && console.error("[runtime] SET time_zone 실패", e));
    });
    return { kind: "mysql", provider: "mysql", db: drizzle(pool, { schema, mode: "default" }), schema, close: () => pool.end() };
  }
  if (scheme === "postgres" || scheme === "postgresql") {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const schema = await import("@magnetosphere/db/src/schema/pg.ts");
    // 시작 파라미터 TimeZone 으로 세션 시간대를 UTC 로 둔다 (서버·DB 의 TimeZone 설정보다 우선한다)
    const client = postgres(url, { connection: { TimeZone: "UTC" }, max: 10, onnotice: () => {} });
    return { kind: "pg", provider: "pg", db: drizzle(client, { schema }), schema, close: () => client.end() };
  }
  throw new Error(`DATABASE_URL 형식을 모른다: "${scheme}:" (file:, libsql:, mysql:, mariadb:, postgres: 중 하나)`);
}

export function createNodeRuntime(opts: NodeRuntimeOptions = {}): NodeRuntime {
  const env = opts.env ?? process.env;
  const trustedProxies = [...(opts.trustedProxies ?? [])];
  // Better Auth 의 IP 해석은 잘못된 항목을 조용히 무시한다. 오설정을 시작 때 드러낸다
  const invalid = findInvalidTrustedProxies(trustedProxies);
  if (invalid.length) throw new Error(`신뢰 프록시 설정이 잘못됐다: ${invalid.join(", ")}`);
  const holder = opts.instanceId ?? `node-${randomUUID()}`;
  const onJobError = opts.onJobError ?? ((name, e) => console.error(`[runtime] 주기 작업 ${name} 실패`, e));
  const peers = new WeakMap<Request, string>();
  const timers = new Set<NodeJS.Timeout>();
  let handle: Promise<DbHandle> | undefined;

  const db = () => {
    if (!handle) {
      const url = env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL 이 없다");
      handle = connectNode(url);
    }
    return handle;
  };

  return {
    db,
    schedule(name: string, cron: string, fn: Job) {
      const period = cronIntervalMinutes(cron) * 60_000;
      // 다음 경계까지 임대를 잡는다. 경계 직전에 풀려야 다음 경계에서 어느 인스턴스든 잡는다
      const ttl = period - 5_000;
      const tick = async () => {
        try {
          if (await acquireLease(await db(), name, holder, ttl)) await fn();
        } catch (e) {
          onJobError(name, e);
        }
      };
      // 인스턴스마다 같은 경계(분 단위)에 깨어나 임대를 다툰다
      const first = setTimeout(() => {
        timers.delete(first);
        void tick();
        const every = setInterval(() => void tick(), period);
        every.unref();
        timers.add(every);
      }, period - (Date.now() % period));
      first.unref();
      timers.add(first);
    },
    rateLimitStore: () => ({ storage: "database" }),
    secret: (name) => env[name],
    clientIp(req) {
      return resolveClientIp(peers.get(req), req.headers.get("x-forwarded-for"), trustedProxies);
    },
    bindPeer(req, peer) {
      if (peer) peers.set(req, peer);
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (handle) await (await handle).close();
      handle = undefined;
    },
  };
}

export type ListenTarget = { port: number; hostname?: string } | { path: string };

export interface Listening {
  server: http.Server;
  /** TCP 로 열었을 때 실제 포트 */
  port?: number;
  close(): Promise<void>;
}

const PROBE_HEADER = "x-magnetosphere-probe";

/**
 * fetch 처리기를 Node HTTP 서버로 연다. 요청마다 소켓 상대 주소를 runtime 에 묶는다.
 * 연 직후 자기 자신에게 실제 요청을 하나 보내 clientIp 가 IP 를 정하는지 확인하고, 못 정하면 닫고 예외를 던진다
 * (TC-S4.T1.e). 소켓 주소가 없는 연결(유닉스 소켓 등)이나 상대 주소를 묶지 못한 구성이 여기서 걸린다.
 */
export async function listen(rt: NodeRuntime, fetch: (req: Request) => Response | Promise<Response>, target: ListenTarget): Promise<Listening> {
  // 시작 확인 요청만 알아보는 일회용 값. 확인이 끝나면 지워 외부 요청이 이 경로를 쓰지 못한다
  let probeToken: string | null = randomUUID();
  const server = createAdaptorServer({
    fetch: async (req, bindings) => {
      rt.bindPeer(req, bindings.incoming.socket.remoteAddress);
      if (probeToken && req.headers.get(PROBE_HEADER) === probeToken) return Response.json({ ip: await rt.clientIp(req) });
      return fetch(req);
    },
  }) as http.Server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen("path" in target ? { path: target.path } : { port: target.port, host: target.hostname }, () => resolve());
  });
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  try {
    const ip = await probe(server, target, probeToken);
    probeToken = null;
    await assertClientIp(() => ip, new Request("http://probe.invalid/"));
  } catch (e) {
    await close();
    throw e;
  }
  const addr = server.address();
  return { server, port: typeof addr === "object" && addr ? (addr as AddressInfo).port : undefined, close };
}

function probe(server: http.Server, target: ListenTarget, token: string): Promise<string | null> {
  const addr = server.address() as AddressInfo | string;
  const where =
    "path" in target ? { socketPath: target.path } : { host: target.hostname && target.hostname !== "0.0.0.0" ? target.hostname : "127.0.0.1", port: (addr as AddressInfo).port };
  return new Promise((resolve, reject) => {
    const req = http.request({ ...where, agent: false, path: "/", method: "GET", headers: { [PROBE_HEADER]: token } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve((JSON.parse(body) as { ip: string | null }).ip);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}
