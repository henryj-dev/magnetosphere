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
//
// --scenario <이름> (2단계 K5): 위 흐름 뒤에 시나리오 하나를 더 돈다. Docker 묶음에는 가짜 상위 서버를 붙인다 (tests/e2e/keys/compose.mock.yml).
//   keys         회원 키 끄기·여러 키 회원 한도·삭제·재발급 (tests/e2e/keys/scenario.mjs, TC-K5.T2.a~d). 여섯 조합
//   claude-code  Claude Code 가 발급 키로 응답을 받는다 (tests/e2e/claude-code/scenario.mjs, TC-K5.T1.a). docker-sqlite 만
//   members         회원 정책 흐름 (tests/e2e/members/scenario.mjs, TC-M5.T1.a~d). Docker 묶음에 mailpit 도 붙인다 (tests/e2e/members/compose.mail.yml)
//   members-regress 회원 권한 회귀 (tests/e2e/members/regress.mjs, TC-M5.T2.a·b). docker-sqlite·workers-d1 만
//   회원 시나리오는 실패해도 app 로그·wrangler 출력 원문을 내지 않는다 (토큰·초대 링크·키·이메일이 들어 있다). 고정 문구와 상태·코드만 낸다.
//   Workers 조합의 회원 시나리오는 wrangler.toml 사본(tests/e2e/members/env.mjs workersMailConfig, 환경마다 send_email EMAIL remote:false)으로 띄우고
//   메일 설정 API 에 {provider:"cloudflare"} 를 저장한다. 로컬 바인딩이 쓴 메일 파일은 시험 폴더(자식 TMPDIR) 안 것만 읽고 끝나면 폴더째 지운다.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAppImage, createStack, dockerAvailable, ROOT } from "../deploy/stack.mjs";
import { lastSetupToken, startWranglerDev } from "../../apps/server/test/wrangler-dev.mjs";
import { composeUp } from "../../scripts/compose-up.mjs";
import { enroll, rememberSeed } from "./mfa.mjs";

const COMBOS = ["docker-sqlite", "docker-mysql", "docker-pg", "workers-d1", "workers-mysql", "workers-pg"];
const CONTRACT = { url: "http://127.0.0.1:20170", password: "contract-initial-password-5c1e9a", compose: "tests/contract/docker-compose.yml" };
const TEST_DB = "docker-compose.test.yml";
const SCENARIOS = ["keys", "claude-code", "members", "members-regress"];
const MEMBER_SCENARIOS = ["members", "members-regress"];
const ADMIN = { email: "e2e-admin@example.com", password: "e2e-admin-password-1234" };

const log = (msg) => console.log(`[e2e] ${msg}`);
function check(cond, msg) {
  if (!cond) throw new Error(msg);
  log(`ok  ${msg}`);
}
/** docker compose up -d --wait (레지스트리 5xx 는 5초·15초 쉬고 세 번까지, scripts/compose-up.mjs) */
function up(file, services) {
  if (MEMBER_SCENARIOS.includes(scenario)) {
    const r = spawnSync("docker", ["compose", "-f", path.join(ROOT, file), "up", "-d", "--wait", ...services], { cwd: ROOT, encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL" });
    if (r.status !== 0) throw new Error(r.error?.code === "ETIMEDOUT" ? "E_SERVICE_TIMEOUT" : "E_SERVICE_UP");
    return;
  }
  const r = composeUp(path.join(ROOT, file), services);
  if (r.status !== 0) throw new Error(`docker compose -f ${file} up ${services.join(" ")} 실패 (${r.status})`);
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...(MEMBER_SCENARIOS.includes(scenario) ? { timeout: 180_000, killSignal: "SIGKILL" } : {}), ...opts });
  if (r.status !== 0) {
    if (MEMBER_SCENARIOS.includes(scenario)) throw new Error(r.error?.code === "ETIMEDOUT" ? "E_COMMAND_TIMEOUT" : `E_COMMAND_FAILED (${r.status ?? 1})`);
    throw new Error(`${cmd} ${args.join(" ")} 실패 (${r.status})\n${r.stderr}${r.stdout}`.slice(0, 4000));
  }
  return r.stdout;
}

/** 설치 → 관리자 → 부트스트랩 → 로그인 → 로그아웃 → 로그인 */
async function installFlow(baseUrl, readToken, members = false) {
  const fetch = members
    ? (url, opts = {}) => globalThis.fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) })
    : globalThis.fetch;
  const readJson = async (res) => {
    try { return await res.json(); }
    catch { if (members) throw new Error("E_SETUP_RESPONSE"); return null; }
  };
  const status = await fetch(`${baseUrl}/api/setup`);
  check(status.status === 200, `GET /api/setup 200 (${status.status})`);
  check((await readJson(status))?.needed === true, "설치 전: needed true");
  const token = await readToken();
  check(!!token, "로그에서 설치 토큰을 찾음");

  const headers = { "content-type": "application/json", origin: baseUrl };
  const setup = await fetch(`${baseUrl}/api/setup`, { method: "POST", headers, body: JSON.stringify({ token, ...ADMIN, publicBaseUrl: baseUrl }) });
  const setupBody = await readJson(setup);
  check(setup.status === 201, `POST /api/setup 201 (${setup.status}${members ? "" : ` ${JSON.stringify(setupBody)}`})`);
  check(setupBody?.omniroute === "connected", `OmniRoute 부트스트랩 "connected" (${setupBody?.omniroute})`);

  const signIn = async () => {
    const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, { method: "POST", headers, body: JSON.stringify(ADMIN) });
    if (members) await readJson(res);
    const cookie = res.headers.getSetCookie().map((s) => s.split(";")[0]).filter((s) => /session_token=./.test(s)).join("; ");
    return { status: res.status, cookie };
  };
  const session = async (cookie) => readJson(await fetch(`${baseUrl}/api/auth/get-session`, { headers: { cookie } }));

  const first = await signIn();
  check(first.status === 200 && first.cookie, `첫 로그인 200 + 세션 쿠키 (${first.status})`);
  check((await session(first.cookie))?.user?.email === ADMIN.email, "세션 사용자 = 관리자");
  // 관리자 MFA (A1): 비밀번호 세션은 부분 세션이다. 설치 응답의 bootstrap grant 로 등록하면 관리 API 가 열린다.
  // seed 는 기억해 두고 시나리오의 관리자 로그인이 challenge 에 쓴다 (tests/e2e/mfa.mjs). 값은 출력하지 않는다
  const api = async (method, p, cookie, body) => {
    const res = await fetch(`${baseUrl}${p}`, { method, headers: { ...headers, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await readJson(res) };
  };
  check((await api("GET", "/api/admin/users", first.cookie)).status === 403, "MFA 전 관리자 세션의 관리 API 403");
  check(typeof setupBody?.mfaGrant?.grant === "string", "설치 응답에 bootstrap 등록 자격");
  rememberSeed(ADMIN.email, await enroll(api, first.cookie, setupBody.mfaGrant.grant));
  check((await api("GET", "/api/admin/users", first.cookie)).status === 200, "MFA 등록 뒤 관리 API 200");
  const out = await fetch(`${baseUrl}/api/auth/sign-out`, { method: "POST", headers: { ...headers, cookie: first.cookie }, body: "{}" });
  if (members) await readJson(out);
  check(out.status === 200, `로그아웃 200 (${out.status})`);
  check((await session(first.cookie)) === null, "로그아웃 뒤 옛 쿠키의 세션 없음");
  const again = await signIn();
  check(again.status === 200 && again.cookie, `다시 로그인 200 + 세션 쿠키 (${again.status})`);
  check((await session(again.cookie))?.user?.email === ADMIN.email, "새 세션 사용자 = 관리자");
}

/** 시나리오 모듈의 실행 함수 */
async function scenarioRunner(scenario) {
  if (scenario === "keys") return (await import("./keys/scenario.mjs")).runKeys;
  if (scenario === "members") return (await import("./members/scenario.mjs")).runMembers;
  if (scenario === "members-regress") return (await import("./members/regress.mjs")).runMembersRegress;
  return (await import("./claude-code/scenario.mjs")).runClaudeCode;
}

async function dockerCombo(db, scenario) {
  if (MEMBER_SCENARIOS.includes(scenario)) (await import("./members/env.mjs")).buildMembersImage();
  else buildAppImage();
  const stack = createStack({ db, httpPort: 28580, label: "e2e" });
  let primary;
  try {
    log(`Compose 묶음 ${stack.project} (${db}) 띄우는 중`);
    if (MEMBER_SCENARIOS.includes(scenario)) (await import("./members/env.mjs")).upMembersStack(stack);
    else if (scenario) (await import("./keys/env.mjs")).upWithMock(stack);
    else stack.up();
    await installFlow(stack.baseUrl, async () => MEMBER_SCENARIOS.includes(scenario) ? (await import("./members/env.mjs")).membersSetupToken(stack) : stack.setupToken(), MEMBER_SCENARIOS.includes(scenario));
    if (scenario) await (await scenarioRunner(scenario))({ combo, stack, baseUrl: stack.baseUrl });
  } catch (e) {
    if (MEMBER_SCENARIOS.includes(scenario)) {
      const members = await import("./members/env.mjs");
      primary = members.safeFailure(e);
      try { log(await members.membersStackSnapshot(stack)); } catch { /* 진단 실패가 원래 실패 코드를 가리지 않는다 */ }
    } else {
      console.error(`[e2e] app 로그 끝부분:\n${stack.logs("app").slice(-3000)}`);
      throw e;
    }
  } finally {
    if (MEMBER_SCENARIOS.includes(scenario)) {
      const { downMembersStack, safeFailure } = await import("./members/env.mjs");
      let cleanup;
      try { downMembersStack(stack); } catch (e) { cleanup = safeFailure(e); }
      if (primary || cleanup) throw safeFailure(primary, cleanup ? cleanup.message.split(" ") : []);
    } else stack.down();
  }
}

/** 시험용 DB 컨테이너에 새 DB 를 만들고 주소를 돌려준다. drop() 으로 지운다 */
function freshDatabase(kind, members = false) {
  const name = `mg_e2e_${randomBytes(4).toString("hex")}`;
  const service = kind === "mysql" ? "mysql" : "postgres";
  up(TEST_DB, [service]);
  const run = (sql) => {
    const args = kind === "mysql"
      ? ["compose", "-f", TEST_DB, "exec", "-T", "mysql", "mysql", "-uroot", "-pmgroot", "-e", sql]
      : ["compose", "-f", TEST_DB, "exec", "-T", "postgres", "psql", "-Umg", "-dpostgres", "-c", sql];
    return sh("docker", args, members ? { timeout: 30_000, killSignal: "SIGKILL" } : {});
  };
  const drop = () => run(kind === "mysql" ? `DROP DATABASE IF EXISTS ${name}` : `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  try {
    run(`CREATE DATABASE ${name}`);
  } catch (e) {
    if (!members) throw e;
    let cleanup = "";
    try { drop(); } catch { cleanup = " E_CLEANUP_DB_CREATE"; }
    throw new Error(`E_DB_CREATE${cleanup}`);
  }
  const url = kind === "mysql" ? `mysql://root:mgroot@127.0.0.1:33306/${name}` : `postgres://mg:mgpass@127.0.0.1:35432/${name}`;
  return { url, drop };
}

async function workersCombo(env, scenario) {
  // 계약 환경 OmniRoute (이미 떠 있으면 그대로). 시나리오는 가짜 상위 서버 제공자·가격이 필요하다 (멱등)
  up(CONTRACT.compose, ["omniroute"]);
  if (scenario) sh(process.execPath, ["tests/contract/setup.mjs"]);
  sh("pnpm", ["-C", "apps/web", "build"]);
  const members = MEMBER_SCENARIOS.includes(scenario);
  // 생성부터 정리 범위 안이다. 한 자원 정리가 실패해도 나머지를 모두 정리한다.
  let persistTo, mailRoot, db, dev, primary;
  try {
    persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "mg-e2e-workers-"));
    mailRoot = members ? fs.mkdtempSync(path.join(os.tmpdir(), "mg-e2e-mail-")) : null;
    db = env === "d1" ? null : freshDatabase(env === "mysql" ? "mysql" : "pg", members);
    let config;
    if (members) {
      fs.mkdirSync(path.join(mailRoot, "cfg"));
      fs.mkdirSync(path.join(mailRoot, "tmp"));
      fs.mkdirSync(path.join(mailRoot, "runlog"));
      config = (await import("./members/env.mjs")).workersMailConfig(path.join(mailRoot, "cfg"));
    }
    // 배포 스크립트의 로컬 모드로 마이그레이션 (D1 은 로컬 D1, Hyperdrive 대상은 그 DB 에 직접)
    sh(process.execPath, ["deploy/workers-deploy.mjs", "--env", env, "--local", "--persist-to", persistTo], {
      env: { ...process.env, ...(members ? { WRANGLER_LOG_PATH: path.join(mailRoot, "runlog", "migration.log") } : {}), ...(db ? { MIGRATE_DATABASE_URL: db.url } : {}) },
    });
    // Workers 는 SETUP_TOKEN 시크릿이 필수다 (S6 보안 리뷰 M2). 설치 토큰은 로그가 아니라 이 값이다
    const setupToken = randomBytes(32).toString("base64url");
    log(`wrangler dev --env ${env}${members ? " (send_email 로컬 바인딩 시험 설정)" : ""} 띄우는 중`);
    // 자식은 process.env 를 물려받는다. 회원 시나리오는 띄우는 동안만 TMPDIR 을 시험 폴더로 바꿔 로컬 메일 파일이 그 안에 쓰이게 한다
    const savedTmp = process.env.TMPDIR;
    if (members) process.env.TMPDIR = path.join(mailRoot, "tmp");
    try {
      const start = members ? (await import("./members/env.mjs")).startMembersWrangler : startWranglerDev;
      dev = await start({
        env,
        persistTo,
        hyperdrive: db?.url,
        config,
        ...(members ? { logPath: path.join(mailRoot, "runlog", "wrangler.log") } : {}),
        vars: {
          BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
          APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
          OMNIROUTE_URL: CONTRACT.url,
          OMNIROUTE_INITIAL_PASSWORD: CONTRACT.password,
          SETUP_TOKEN: setupToken,
        },
        // 시나리오는 Cron 을 /__scheduled 로 부른다 (wrangler dev 는 Cron 을 스스로 돌리지 않는다)
        testScheduled: !!scenario,
      });
    } finally {
      if (members) {
        if (savedTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = savedTmp;
      }
    }
    await installFlow(dev.baseUrl, async () => setupToken, members);
    check(!dev.output().includes(setupToken) && lastSetupToken(dev.output()) === null, "Workers 로그에 설치 토큰이 나오지 않음");
    if (scenario) {
      const extra = members
        ? {
            mailSettings: (await import("./members/env.mjs")).MAIL_CLOUDFLARE,
            mailRoots: [mailRoot],
            d1File: env === "d1" ? (await import("./members/env.mjs")).d1File(persistTo) : null,
          }
        : {};
      await (await scenarioRunner(scenario))({ combo, dev, baseUrl: dev.baseUrl, persistTo, dbUrl: db?.url ?? null, contract: CONTRACT, ...extra });
    }
  } catch (e) {
    if (members) primary = (await import("./members/env.mjs")).safeFailure(e);
    else {
      if (dev) console.error(`[e2e] wrangler dev 출력 끝부분:\n${dev.output().slice(-3000)}`);
      throw e;
    }
  } finally {
    if (!members) {
      await dev?.close();
      db?.drop();
      if (persistTo) fs.rmSync(persistTo, { recursive: true, force: true });
    } else {
      const errors = [];
      let timer;
      try {
        await Promise.race([dev?.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("E_CLOSE_TIMEOUT")), 15_000); })]);
      } catch { errors.push("E_CLEANUP_WORKER"); }
      finally { clearTimeout(timer); }
      try { db?.drop(); } catch { errors.push("E_CLEANUP_DB"); }
      try { if (persistTo) fs.rmSync(persistTo, { recursive: true, force: true }); } catch { errors.push("E_CLEANUP_PERSIST"); }
      try { if (mailRoot) fs.rmSync(mailRoot, { recursive: true, force: true }); } catch { errors.push("E_CLEANUP_MAIL"); }
      if (primary || errors.length) throw (await import("./members/env.mjs")).safeFailure(primary, errors);
    }
  }
}

const args = process.argv.slice(2);
const combo = args[args.indexOf("--combo") + 1];
const scenario = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : null;
if (
  !args.includes("--combo") ||
  !COMBOS.includes(combo) ||
  (scenario !== null && !SCENARIOS.includes(scenario)) ||
  (scenario === "claude-code" && combo !== "docker-sqlite") ||
  (scenario === "members-regress" && combo !== "docker-sqlite" && combo !== "workers-d1")
) {
  console.error(`사용법: pnpm e2e --combo <${COMBOS.join("|")}> [--scenario <${SCENARIOS.join("|")}>] (claude-code 는 docker-sqlite 만, members-regress 는 docker-sqlite·workers-d1 만)`);
  process.exit(2);
}
if (!(MEMBER_SCENARIOS.includes(scenario) ? (await import("./members/env.mjs")).membersDockerAvailable() : dockerAvailable())) {
  console.error("e2e: docker 를 쓸 수 없다 (docker info 실패).");
  process.exit(1);
}
const started = Date.now();
try {
  const [runtime, db] = combo.split("-");
  if (runtime === "docker") await dockerCombo({ sqlite: "sqlite", mysql: "mysql", pg: "postgres" }[db], scenario);
  else await workersCombo(db, scenario);
  log(`${combo}${scenario ? ` --scenario ${scenario}` : ""} 통과 (${Math.round((Date.now() - started) / 1000)}초)`);
} catch (e) {
  // 회원 실패는 안전한 코드만 낸다. 원인 코드 뒤에 정리 실패 코드가 붙는다.
  const why = MEMBER_SCENARIOS.includes(scenario) ? (await import("./members/env.mjs")).safeFailure(e).message : e.message;
  console.error(`[e2e] ${combo}${scenario ? ` --scenario ${scenario}` : ""} 실패: ${why}`);
  process.exit(1);
}
