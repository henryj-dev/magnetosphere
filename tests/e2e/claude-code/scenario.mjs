// K5.T1 Claude Code 가 회원 앱이 발급한 키로 동작한다 (TC-K5.T1.a, 계획서 5.1, V16 증거의 방식).
// pnpm e2e --combo docker-sqlite --scenario claude-code
//   설치·관리자(run.mjs) 뒤 회원(DB 직접)·한도 $5 → POST /api/me/keys 로 원문 → 빈 임시 폴더에서
//   claude -p "say hi" --max-turns 1 (stdin 닫음, --setting-sources project, 모델 mka/claude-mock).
//   Claude Code 는 ANTHROPIC_BASE_URL=<Caddy 주소>·ANTHROPIC_AUTH_TOKEN=<원문>(Authorization: Bearer) 로만 붙는다.
// 환경 변수는 이 컴퓨터의 것을 물려주지 않고 새로 만든다 (PATH 만). HOME·CLAUDE_CONFIG_DIR 도 빈 임시 폴더라 사람의 설정·키를 읽지 않는다.
// 단언: 종료코드 0, stdout 에 "hello from mock", Caddy 접근 기록에 POST /v1/messages 200,
//       실행 동안 Claude Code 프로세스 묶음의 TCP 연결(lsof 20ms 간격)에 :20128 이 없다.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN, appHttp, check, dbOps, log, stackCompose, upWithMock } from "../keys/env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.join(HERE, "node_modules/.bin/claude");
const MODEL = "mka/claude-mock";
/** 사람이 쓰는 OmniRoute. Claude Code 가 여기에 붙으면 실패다 */
const FORBIDDEN_PORT = 20128;

/** 고정 버전 설치 (이 폴더의 pnpm-workspace.yaml·잠금 파일). 설치된 버전이 고정 버전과 같을 때만 건너뛴다 (K5 리뷰 L3) */
function installClaude() {
  const want = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).dependencies["@anthropic-ai/claude-code"];
  const installed = path.join(HERE, "node_modules/@anthropic-ai/claude-code/package.json");
  const have = fs.existsSync(installed) ? JSON.parse(fs.readFileSync(installed, "utf8")).version : null;
  if (have === want && fs.existsSync(CLAUDE)) return;
  if (have !== null) log(`설치된 Claude Code ${have} ≠ 고정 ${want}. 다시 설치한다`);
  const r = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: HERE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`Claude Code 설치 실패\n${r.stderr}${r.stdout}`.slice(0, 3000));
  const now = JSON.parse(fs.readFileSync(installed, "utf8")).version;
  if (now !== want) throw new Error(`설치한 Claude Code ${now} ≠ 고정 ${want}`);
}

/**
 * CI(CI=true)에서만 127.0.0.1:20128 에 감시 리스너를 띄운다. 연결이 한 번이라도 오면 실패다 (K5 리뷰 L1).
 * 이 컴퓨터(로컬)의 20128 은 사람이 쓰는 OmniRoute 라 절대 띄우지 않는다 — 로컬은 lsof 관측만 한다.
 */
async function ciTrap() {
  if (process.env.CI !== "true") return null;
  const accepted = [];
  const server = net.createServer((sock) => {
    accepted.push(`${sock.remoteAddress}:${sock.remotePort}`);
    sock.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", (e) => reject(new Error(`CI 감시 리스너를 127.0.0.1:${FORBIDDEN_PORT} 에 띄우지 못했다 (${e.code})`)));
    server.listen(FORBIDDEN_PORT, "127.0.0.1", resolve);
  });
  log(`CI 감시 리스너 127.0.0.1:${FORBIDDEN_PORT}`);
  return {
    accepted,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Caddy 접근 기록을 켠다 (deploy/Caddyfile 은 접근 기록이 없다). 컨테이너 안 관리 API 로 그 서버에만 logs 를 단다 */
function enableCaddyAccessLog(stack) {
  const servers = JSON.parse(stackCompose(stack, ["exec", "-T", "caddy", "wget", "-q", "-O-", "http://127.0.0.1:2019/config/apps/http/servers"]));
  const names = Object.keys(servers);
  check(names.length === 1, `Caddy HTTP 서버 하나 (${names.join(", ")})`);
  stackCompose(stack, ["exec", "-T", "caddy", "wget", "-q", "-O-", "--header", "Content-Type: application/json", "--post-data", "{}", `http://127.0.0.1:2019/config/apps/http/servers/${names[0]}/logs`]);
}

/** 접근 기록 한 줄씩 { method, path, status } */
function caddyAccess(stack) {
  const out = stackCompose(stack, ["logs", "--no-color", "--no-log-prefix", "caddy"]);
  return out
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((j) => j?.logger?.startsWith("http.log.access"))
    .map((j) => ({ method: j.request?.method, path: String(j.request?.uri ?? "").split("?")[0], status: j.status }));
}

/** 프로세스 묶음(pgid)의 TCP 연결을 짧은 간격으로 모은다. stop() 이 모은 상대 주소 집합을 돌려준다 */
function watchConnections(pgid) {
  const seen = new Set();
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const r = spawnSync("lsof", ["-nP", "-a", "-g", String(pgid), "-iTCP"], { encoding: "utf8" });
      if (r.error) throw new Error(`lsof 를 돌리지 못했다 (${r.error.message}). 연결을 볼 수 없으면 20128 접속 0 을 단언할 수 없다`);
      for (const line of (r.stdout ?? "").split("\n").slice(1)) {
        const m = /TCP (\S+)/.exec(line);
        if (m) seen.add(m[1]);
      }
      await new Promise((res) => setTimeout(res, 20));
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    return seen;
  };
}

export async function runClaudeCode({ combo, stack, baseUrl }) {
  if (combo !== "docker-sqlite") throw new Error("claude-code 시나리오는 docker-sqlite 묶음(Caddy 경유)에서만 돈다 (G-K5.1)");
  installClaude();
  const http = appHttp(baseUrl);
  const db = dbOps({ stack });
  const admin = await http.signIn(ADMIN.email, ADMIN.password);
  const email = `e2e-cc-${Date.now()}@example.com`;
  const password = "e2e claude code member password";
  const memberId = db.addMember(email, password);
  const lim = await http.api("PATCH", `/api/admin/users/${memberId}`, admin, { monthlyLimitUsd: 5 });
  check(lim.status === 200, `관리자 한도 $5 (${lim.status} ${JSON.stringify(lim.json)})`);
  const cookie = await http.signIn(email, password);
  const issued = await http.api("POST", "/api/me/keys", cookie, { label: "claude code" });
  check(issued.status === 201 && typeof issued.json?.secret === "string", `회원 키 발급 201 (${issued.status} ${JSON.stringify(issued.json?.error ?? null)})`);

  enableCaddyAccessLog(stack);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mg-e2e-claude-"));
  const home = path.join(work, "home");
  const cwd = path.join(work, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    TMPDIR: work,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: issued.json.secret,
    ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
  check(!Object.values(env).some((v) => String(v).includes(String(FORBIDDEN_PORT))), `Claude Code 환경 변수에 ${FORBIDDEN_PORT} 이 없음`);
  const trap = await ciTrap();
  try {
    const started = Date.now();
    const child = spawn(CLAUDE, ["-p", "say hi", "--max-turns", "1", "--model", MODEL, "--setting-sources", "project"], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = watchConnections(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // 이미 끝났다
      }
    }, 120_000);
    const code = await new Promise((r) => child.once("exit", (c) => r(c)));
    clearTimeout(timer);
    const conns = await stop();
    log(`claude 종료 ${code} (${Date.now() - started}ms) stdout=${JSON.stringify(stdout.trim()).slice(0, 300)}`);
    if (stderr.trim()) log(`claude stderr: ${stderr.trim().slice(0, 1000)}`);
    log(`Claude Code TCP 연결: ${[...conns].join(", ") || "(관측 없음)"}`);
    check(code === 0, `claude 종료코드 0 (${code})`);
    check(stdout.includes("hello from mock"), `stdout 에 "hello from mock"`);
    const port = new URL(baseUrl).port;
    check([...conns].some((c) => new RegExp(`:${port}\\b`).test(c)), `연결 관측이 동작한다: Caddy(:${port}) 연결이 보인다`);
    check(![...conns].some((c) => new RegExp(`:${FORBIDDEN_PORT}\\b`).test(c)), `localhost:${FORBIDDEN_PORT} 접속 0 (lsof 관측)`);
    if (trap) check(trap.accepted.length === 0, `CI 감시 리스너 127.0.0.1:${FORBIDDEN_PORT} 에 들어온 연결 0 (${trap.accepted.join(", ")})`);
    // 접근 기록은 응답 뒤에 남는다. 잠깐 기다린다
    let access = [];
    for (let i = 0; i < 20; i++) {
      access = caddyAccess(stack);
      if (access.some((a) => a.method === "POST" && a.path === "/v1/messages" && a.status === 200)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    log(`Caddy 접근 기록: ${access.map((a) => `${a.method} ${a.path} ${a.status}`).join(", ")}`);
    check(access.some((a) => a.method === "POST" && a.path === "/v1/messages" && a.status === 200), "Caddy 접근 기록에 POST /v1/messages 200");
  } finally {
    await trap?.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export { upWithMock };
