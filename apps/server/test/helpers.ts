// 서버 테스트 공용: 마이그레이션을 적용한 빈 SQLite 파일과 그 DB 를 쓰는 환경 변수.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { enrollHttp, type MfaCall } from "../../../packages/auth/test/mfa-fixture.ts";
import { TEST_MFA_POLICY_ENV } from "../../../packages/auth/test/mfa-policy.ts";
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
      // 관리자 MFA 정책 (A1). 시험 전용 값이다. 빼면 관리자 기능·설치가 503 으로 닫힌다
      ...TEST_MFA_POLICY_ENV,
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

// ---- 관리자 MFA (A1) ----

/** 응답의 세션 쿠키를 요청 머리글 값으로 */
export const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

/** 띄운 서버를 MFA fixture 의 HTTP 꼴로 부른다 (같은 출처·JSON) */
export function httpCall(r: Running): MfaCall {
  return async (method, path, o) => {
    const headers: Record<string, string> = { origin: ORIGIN, ...(o.headers ?? {}) };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${r.base}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // JSON 이 아닌 응답
    }
    return { status: res.status, json };
  };
}

export async function signInCookie(r: Running, email: string, password: string): Promise<string> {
  const res = await post(r, "/api/auth/sign-in/email", { email, password });
  if (res.status !== 200) throw new Error(`로그인 실패 ${res.status}`);
  return cookieOf(res);
}

/**
 * 최초 설치 → 관리자 로그인 → 설치 응답의 bootstrap grant 로 MFA 등록까지 마친 관리자 세션 (A1).
 * 봉인된 단계의 관리자 시험이 비밀번호만으로 관리 API 를 부르지 않게 쓰는 공용 fixture 다
 */
export async function installAdmin(r: Running, extra: Record<string, unknown> = {}): Promise<{ cookie: string; seed: string; recoveryCodes: string[]; setup: any }> {
  const res = await post(r, "/api/setup", { token: tokenIn(r.logs), ...ADMIN, ...extra });
  const setup = await res.json();
  if (res.status !== 201) throw new Error(`설치 실패 ${res.status} ${JSON.stringify(setup)}`);
  const cookie = await signInCookie(r, String(extra.email ?? ADMIN.email), String(extra.password ?? ADMIN.password));
  const enrolled = await enrollHttp(httpCall(r), cookie, setup.mfaGrant.grant);
  return { cookie, seed: enrolled.seed, recoveryCodes: enrolled.recoveryCodes, setup };
}
