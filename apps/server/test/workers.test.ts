// Workers 진입점을 배포 설정 그대로(apps/server/wrangler.toml, 환경 d1) 로컬 wrangler dev 로 띄워 본다 (pnpm test:workers).
// D1 은 --persist-to 폴더의 로컬 D1 이다. 마이그레이션은 배포 스크립트(deploy/workers-deploy.mjs --local)로 적용한다.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { d1Query, lastSetupToken, ROOT, startWranglerDev } from "./wrangler-dev.mjs";
import { TEST_ENCRYPTION_KEY, TEST_SECRET } from "./helpers.ts";

const SECRETS = { BETTER_AUTH_SECRET: TEST_SECRET, APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY };
const TOKEN_LINE = /최초 설치 토큰: /g;
const cleanups: (() => Promise<void> | void)[] = [];

function freshD1(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-workers-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** 배포 스크립트의 로컬 모드로 D1 마이그레이션을 적용한다 */
function migrateLocal(persistTo: string) {
  const r = spawnSync(process.execPath, ["deploy/workers-deploy.mjs", "--env", "d1", "--local", "--persist-to", persistTo], { cwd: ROOT, encoding: "utf8" });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return r.stdout;
}
async function dev(persistTo: string, vars: Record<string, string> = {}) {
  const d = await startWranglerDev({ env: "d1", persistTo, vars: { ...SECRETS, ...vars } });
  cleanups.push(() => d.close());
  return d;
}
async function setup(baseUrl: string, token: string, email = "admin@example.com") {
  const res = await fetch(`${baseUrl}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ token, email, password: "admin-password-1234", publicBaseUrl: baseUrl }),
  });
  return res.status;
}
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

beforeAll(() => {
  const build = spawnSync("pnpm", ["-C", "apps/web", "build"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`apps/web 빌드 실패\n${build.stdout}${build.stderr}`);
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("TC-S6.T3.b Workers 설치 토큰은 SETUP_TOKEN 시크릿으로만 정한다", () => {
  it("SETUP_TOKEN 시크릿이 있으면 그 값으로 /setup 201, 로그에 토큰 출력 없음", async () => {
    const persist = freshD1();
    migrateLocal(persist);
    const secret = "operator-chosen-setup-token-0123456789";
    const d = await dev(persist, { SETUP_TOKEN: secret });
    expect((await fetch(`${d.baseUrl}/api/setup`)).status).toBe(200);
    expect(await setup(d.baseUrl, "wrong-token")).toBe(401);
    expect(await setup(d.baseUrl, secret)).toBe(201);
    expect(count(await d.waitOutput(TOKEN_LINE, 1, 1500), TOKEN_LINE)).toBe(0);
    expect(d.output()).not.toContain(secret);
  });

  it("SETUP_TOKEN 시크릿이 없으면 GET·POST /api/setup 이 503 setup_token_required, 토큰을 만들지도 출력하지도 않는다", async () => {
    const persist = freshD1();
    migrateLocal(persist);
    const d = await dev(persist);
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${d.baseUrl}/api/setup`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "setup_token_required" });
    }
    expect(await setup(d.baseUrl, "anything-anything-anything-anything")).toBe(503);
    expect(count(await d.waitOutput(TOKEN_LINE, 1, 1500), TOKEN_LINE)).toBe(0);
    await d.close();
    expect(d1Query(persist, "SELECT count(*) AS n FROM app_settings WHERE key = 'setup_token_hash'")[0].n).toBe(0);
  });

  it("관리자 없는 빈 DB 에 처음 GET 두 개가 동시에 오면 둘 다 200, 저장 토큰 행 1개, 출력 0줄", async () => {
    const persist = freshD1();
    migrateLocal(persist);
    const d = await dev(persist, { SETUP_TOKEN: "operator-chosen-setup-token-0123456789" });
    const statuses = await Promise.all([fetch(`${d.baseUrl}/api/setup`), fetch(`${d.baseUrl}/api/setup`)].map(async (p) => (await p).status));
    expect(statuses).toEqual([200, 200]);
    await d.waitOutput(TOKEN_LINE, 1, 1500);
    await d.close();
    const rows = d1Query(persist, "SELECT count(*) AS n FROM app_settings WHERE key = 'setup_token_hash'");
    expect(rows[0].n).toBe(1);
    expect(count(d.output(), TOKEN_LINE)).toBe(0);

    // 실제로 겹치는 경쟁(연결 풀 여러 개)은 pnpm test:db -t "TC-S6.T3.b" --db mysql,pg 가 본다 (test/db.test.ts)
  });
});

describe("TC-S6.T3.e 약한 SETUP_TOKEN 은 시작을 거부한다", () => {
  it("Workers: 짧은 SETUP_TOKEN → 처음 요청이 500 이고 이유가 로그에 남는다, 토큰은 저장되지 않는다", async () => {
    const persist = freshD1();
    migrateLocal(persist);
    const d = await dev(persist, { SETUP_TOKEN: "admin" });
    const res = await fetch(`${d.baseUrl}/api/setup`);
    expect(res.status).toBe(500);
    expect(await d.waitOutput(/SETUP_TOKEN 은 32자 이상/)).toMatch(/SETUP_TOKEN 은 32자 이상/);
    expect(await setup(d.baseUrl, "admin")).toBe(500);
    await d.close();
    expect(d1Query(persist, "SELECT count(*) AS n FROM app_settings WHERE key = 'setup_token_hash'")[0].n).toBe(0);
    expect(d1Query(persist, "SELECT count(*) AS n FROM user")[0].n).toBe(0);
  });
});

describe("TC-S6.T3.f 설치 시도 횟수 제한", () => {
  it("Workers: 같은 클라이언트가 틀린 토큰으로 10회 → 401, 11번째는 맞는 토큰도 429", async () => {
    const persist = freshD1();
    migrateLocal(persist);
    const secret = "operator-chosen-setup-token-0123456789";
    const d = await dev(persist, { SETUP_TOKEN: secret });
    for (let i = 0; i < 10; i++) expect(await setup(d.baseUrl, `wrong-token-${i}`)).toBe(401);
    expect(await setup(d.baseUrl, secret)).toBe(429);
  });
});

describe("TC-S6.T3.d Workers 배포 전에 마이그레이션이 적용된다", () => {
  it("배포 스크립트 --dry-run 은 마이그레이션 단계를 배포보다 먼저 낸다 (d1·mysql·pg)", () => {
    for (const env of ["d1", "mysql", "pg"]) {
      const r = spawnSync(process.execPath, ["deploy/workers-deploy.mjs", "--env", env, "--dry-run"], { cwd: ROOT, encoding: "utf8" });
      expect(r.status).toBe(0);
      const lines = r.stdout.split("\n").filter((l) => l.startsWith("[step] "));
      expect(lines.map((l) => l.slice(7, l.indexOf(":")))).toEqual(["migrate", "deploy"]);
      if (env === "d1") expect(lines[0]).toContain("wrangler d1 migrations apply DB --remote --env d1");
      else expect(lines[0]).toContain("apps/server/src/migrate.ts");
      expect(lines[1]).toContain(`wrangler deploy --env ${env}`);
    }
  });

  it("빈 로컬 D1 → 배포 스크립트(--local) → GET /api/setup 200", async () => {
    const persist = freshD1();
    const out = migrateLocal(persist);
    expect(out).toContain("migrations apply DB --local");
    const d = await dev(persist, { SETUP_TOKEN: "operator-chosen-setup-token-0123456789" });
    const res = await fetch(`${d.baseUrl}/api/setup`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needed: true });
  });
});
