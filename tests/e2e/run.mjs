#!/usr/bin/env node
// 여섯 조합 E2E (실행판 S6.T4, 계획서 9장 1단계 완료 기준). pnpm e2e --combo <이름>
//
//   docker-sqlite · docker-mysql · docker-pg     Compose 묶음(docker-compose.yml + tests/deploy/compose.test.yml)을 빈 볼륨으로 띄운다
//   workers-d1 · workers-mysql · workers-pg       apps/server/wrangler.toml 을 로컬 wrangler dev 로 띄운다
//                                                 (D1 로컬, Hyperdrive 는 localConnectionString 으로 시험용 MySQL·Postgres 의 새 DB)
//
// 조합마다: 띄우기 → 설치 토큰(Docker 는 로그에서 추출, Workers 는 SETUP_TOKEN 시크릿) → POST /api/setup 으로 관리자 생성(201, omniroute "connected")
//          → 로그인 → 로그아웃(세션이 사라짐) → 다시 로그인(200, 세션 쿠키). 끝나면 띄운 것을 내린다.
// Workers 조합의 OmniRoute 는 계약 테스트 환경(tests/contract, 127.0.0.1:20170)에 직접 붙는다. 없으면 띄운다.
// (Workers 운영의 OmniRoute 연결 방식은 V24·계획서 9장 8단계에서 정한다.)
// 시험용 MySQL·Postgres 는 저장소 최상위 docker-compose.test.yml 의 컨테이너를 쓴다 (없으면 띄운다).
// 이 컴퓨터의 localhost:20128(사람이 쓰는 OmniRoute)·80·443 은 쓰지 않는다.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAppImage, createStack, dockerAvailable, ROOT } from "../deploy/stack.mjs";
import { lastSetupToken, startWranglerDev } from "../../apps/server/test/wrangler-dev.mjs";

const COMBOS = ["docker-sqlite", "docker-mysql", "docker-pg", "workers-d1", "workers-mysql", "workers-pg"];
const CONTRACT = { url: "http://127.0.0.1:20170", password: "contract-initial-password-5c1e9a", compose: "tests/contract/docker-compose.yml" };
const TEST_DB = "docker-compose.test.yml";
const ADMIN = { email: "e2e-admin@example.com", password: "e2e-admin-password-1234" };

const log = (msg) => console.log(`[e2e] ${msg}`);
function check(cond, msg) {
  if (!cond) throw new Error(msg);
  log(`ok  ${msg}`);
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 실패 (${r.status})\n${r.stderr}${r.stdout}`.slice(0, 4000));
  return r.stdout;
}

/** 설치 → 관리자 → 부트스트랩 → 로그인 → 로그아웃 → 로그인 */
async function installFlow(baseUrl, readToken) {
  const status = await fetch(`${baseUrl}/api/setup`);
  check(status.status === 200, `GET /api/setup 200 (${status.status})`);
  check((await status.json()).needed === true, "설치 전: needed true");
  const token = await readToken();
  check(!!token, "로그에서 설치 토큰을 찾음");

  const headers = { "content-type": "application/json", origin: baseUrl };
  const setup = await fetch(`${baseUrl}/api/setup`, { method: "POST", headers, body: JSON.stringify({ token, ...ADMIN, publicBaseUrl: baseUrl }) });
  const setupBody = await setup.json().catch(() => null);
  check(setup.status === 201, `POST /api/setup 201 (${setup.status} ${JSON.stringify(setupBody)})`);
  check(setupBody?.omniroute === "connected", `OmniRoute 부트스트랩 "connected" (${setupBody?.omniroute})`);

  const signIn = async () => {
    const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, { method: "POST", headers, body: JSON.stringify(ADMIN) });
    const cookie = res.headers.getSetCookie().map((s) => s.split(";")[0]).filter((s) => /session_token=./.test(s)).join("; ");
    return { status: res.status, cookie };
  };
  const session = async (cookie) => (await fetch(`${baseUrl}/api/auth/get-session`, { headers: { cookie } })).json().catch(() => null);

  const first = await signIn();
  check(first.status === 200 && first.cookie, `첫 로그인 200 + 세션 쿠키 (${first.status})`);
  check((await session(first.cookie))?.user?.email === ADMIN.email, "세션 사용자 = 관리자");
  const out = await fetch(`${baseUrl}/api/auth/sign-out`, { method: "POST", headers: { ...headers, cookie: first.cookie }, body: "{}" });
  check(out.status === 200, `로그아웃 200 (${out.status})`);
  check((await session(first.cookie)) === null, "로그아웃 뒤 옛 쿠키의 세션 없음");
  const again = await signIn();
  check(again.status === 200 && again.cookie, `다시 로그인 200 + 세션 쿠키 (${again.status})`);
  check((await session(again.cookie))?.user?.email === ADMIN.email, "새 세션 사용자 = 관리자");
}

async function dockerCombo(db) {
  buildAppImage();
  const stack = createStack({ db, httpPort: 28580, label: "e2e" });
  try {
    log(`Compose 묶음 ${stack.project} (${db}) 띄우는 중`);
    stack.up();
    await installFlow(stack.baseUrl, async () => stack.setupToken());
  } catch (e) {
    console.error(`[e2e] app 로그 끝부분:\n${stack.logs("app").slice(-3000)}`);
    throw e;
  } finally {
    stack.down();
  }
}

/** 시험용 DB 컨테이너에 새 DB 를 만들고 주소를 돌려준다. drop() 으로 지운다 */
function freshDatabase(kind) {
  const name = `mg_e2e_${randomBytes(4).toString("hex")}`;
  const service = kind === "mysql" ? "mysql" : "postgres";
  sh("docker", ["compose", "-f", TEST_DB, "up", "-d", "--wait", service]);
  const run = (sql) =>
    kind === "mysql"
      ? sh("docker", ["compose", "-f", TEST_DB, "exec", "-T", "mysql", "mysql", "-uroot", "-pmgroot", "-e", sql])
      : sh("docker", ["compose", "-f", TEST_DB, "exec", "-T", "postgres", "psql", "-Umg", "-dpostgres", "-c", sql]);
  run(`CREATE DATABASE ${name}`);
  const url = kind === "mysql" ? `mysql://root:mgroot@127.0.0.1:33306/${name}` : `postgres://mg:mgpass@127.0.0.1:35432/${name}`;
  return { url, drop: () => run(kind === "mysql" ? `DROP DATABASE IF EXISTS ${name}` : `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) };
}

async function workersCombo(env) {
  // 계약 환경 OmniRoute (이미 떠 있으면 그대로)
  sh("docker", ["compose", "-f", CONTRACT.compose, "up", "-d", "--wait", "omniroute"]);
  sh("pnpm", ["-C", "apps/web", "build"]);
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "mg-e2e-workers-"));
  const db = env === "d1" ? null : freshDatabase(env === "mysql" ? "mysql" : "pg");
  let dev;
  try {
    // 배포 스크립트의 로컬 모드로 마이그레이션 (D1 은 로컬 D1, Hyperdrive 대상은 그 DB 에 직접)
    sh(process.execPath, ["deploy/workers-deploy.mjs", "--env", env, "--local", "--persist-to", persistTo], {
      env: { ...process.env, ...(db ? { MIGRATE_DATABASE_URL: db.url } : {}) },
    });
    // Workers 는 SETUP_TOKEN 시크릿이 필수다 (S6 보안 리뷰 M2). 설치 토큰은 로그가 아니라 이 값이다
    const setupToken = randomBytes(32).toString("base64url");
    log(`wrangler dev --env ${env} 띄우는 중`);
    dev = await startWranglerDev({
      env,
      persistTo,
      hyperdrive: db?.url,
      vars: {
        BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
        APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        OMNIROUTE_URL: CONTRACT.url,
        OMNIROUTE_INITIAL_PASSWORD: CONTRACT.password,
        SETUP_TOKEN: setupToken,
      },
    });
    await installFlow(dev.baseUrl, async () => setupToken);
    check(!dev.output().includes(setupToken) && lastSetupToken(dev.output()) === null, "Workers 로그에 설치 토큰이 나오지 않음");
  } catch (e) {
    if (dev) console.error(`[e2e] wrangler dev 출력 끝부분:\n${dev.output().slice(-3000)}`);
    throw e;
  } finally {
    await dev?.close();
    db?.drop();
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const combo = args[args.indexOf("--combo") + 1];
if (!args.includes("--combo") || !COMBOS.includes(combo)) {
  console.error(`사용법: pnpm e2e --combo <${COMBOS.join("|")}>`);
  process.exit(2);
}
if (!dockerAvailable()) {
  console.error("e2e: docker 를 쓸 수 없다 (docker info 실패).");
  process.exit(1);
}
const started = Date.now();
try {
  const [runtime, db] = combo.split("-");
  if (runtime === "docker") await dockerCombo({ sqlite: "sqlite", mysql: "mysql", pg: "postgres" }[db]);
  else await workersCombo(db);
  log(`${combo} 통과 (${Math.round((Date.now() - started) / 1000)}초)`);
} catch (e) {
  console.error(`[e2e] ${combo} 실패: ${e.message}`);
  process.exit(1);
}
