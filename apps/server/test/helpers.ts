// 서버 테스트 공용: 마이그레이션을 적용한 빈 SQLite 파일과 그 DB 를 쓰는 환경 변수.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { startNodeServer } from "../src/node.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/migrations/sqlite", import.meta.url));

export const TEST_SECRET = "mg-server-test-secret-mg-server-test-secret";
/** 테스트 전용 32바이트 키 */
export const TEST_ENCRYPTION_KEY = "CzBVep/E6Q4zWH2ix+wRNluApcrvFDleg6jN8hc8YYY=";

export interface TestEnv {
  dir: string;
  dbFile: string;
  env: Record<string, string>;
  cleanup(): void;
}

export async function makeTestEnv(): Promise<TestEnv> {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-server-"));
  const dbFile = path.join(dir, "app.sqlite");
  const client = createClient({ url: `file:${dbFile}` });
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  client.close();
  return {
    dir,
    dbFile,
    env: {
      DATABASE_URL: `file:${dbFile}`,
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: TEST_SECRET,
      APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      NODE_ENV: "test",
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** SPA 빌드 대신 쓰는 작은 정적 디렉터리 */
export function fakeWebDir(dir: string): string {
  const web = path.join(dir, "web");
  rmSync(web, { recursive: true, force: true });
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>spa</title>");
  writeFileSync(path.join(web, "robots.txt"), "User-agent: *\n");
  return web;
}

// ---- 띄운 Node 서버를 HTTP 로 부르는 도구 (setup·본문 상한 TC 공용) ----

export const ORIGIN = "http://localhost:3000";
export const ADMIN = { email: "Admin@Example.com", password: "correct horse battery", name: "관리자", publicBaseUrl: "https://llm.example.com" };

export interface Running {
  t: TestEnv;
  logs: string[];
  base: string;
  close(): Promise<void>;
}

/** 이 파일에서 띄운 서버. 테스트 파일의 afterEach(closeAll) 이 닫고 DB 를 지운다 */
export const opened: Running[] = [];

export async function boot(t?: TestEnv, hostname = "127.0.0.1"): Promise<Running> {
  const env = t ?? (await makeTestEnv());
  const logs: string[] = [];
  const s = await startNodeServer({ env: env.env, port: 0, hostname, webDir: fakeWebDir(env.dir), log: (l) => logs.push(l) });
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  const r = { t: env, logs, base: `http://${host}:${s.port}`, close: () => s.close() };
  opened.push(r);
  return r;
}

export async function closeAll() {
  for (const r of opened.splice(0)) {
    await r.close();
    r.t.cleanup();
  }
}

export const tokenIn = (logs: string[]) => logs.join("\n").match(/최초 설치 토큰: (\S+)/)?.[1];

export const post = (r: Running, path: string, body: unknown) =>
  fetch(`${r.base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });

export async function sql(t: TestEnv, q: string) {
  const c = createClient({ url: `file:${t.dbFile}` });
  try {
    return (await c.execute(q)).rows;
  } finally {
    c.close();
  }
}
