// 3단계 회원 E2E 공용 (M5). 회원 정책 시나리오(scenario.mjs, TC-M5.T1)와 권한 회귀(regress.mjs, TC-M5.T2)가 쓴다.
//   - 회원은 가입·초대 API 로만 만든다. DB 는 읽기만 한다 (dbRead: 회원 행 수·감사 행 수·하루 가입 칸·회원 한 명의 권한 필드).
//   - 메일: Docker 는 묶음 안 mailpit 이 SMTP 로 받고 시험은 mailpit HTTP API 로 읽는다 (compose.mail.yml).
//     Workers 는 로컬 send_email 바인딩(remote:false)이 파일로 남긴 메일 본문을 읽는다 (wranglerBox, workersMailConfig).
//     둘 다 { clear, count, waitFor } 같은 모양이다.
//   - 출력 규칙: 토큰·초대 링크·키 원문·비밀번호·이메일·오류 본문·docker/wrangler 원문 출력을 내지 않는다.
//     실패 메시지는 고정 코드·HTTP 상태·짧은 오류 코드만 담는다 (run.mjs 가 e.message 를 그대로 낸다).
//   - 요청 수 제한: Better Auth 인증 경로 한도(packages/auth/src/rate-limit.ts)를 넘지 않게 시험이 먼저 기다린다 (pacer).
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APP_IMAGE, ROOT } from "../../deploy/stack.mjs";
import { commandFailureCode, dbReadFailureCode, dbReadTimeoutCode, formatStackSnapshot, keepStackForCleanup, ownedStackDir, READ_SCRIPT } from "./diagnostics.mjs";
import { MOCK_OVERRIDE, sleep, STACK_OMNI_URL } from "../keys/env.mjs";

export { ADMIN, d1File, permissionDenied, sleep } from "../keys/env.mjs";

const REQUEST_MS = 10_000;
const DB_MS = 5_000;
/** 헤더와 본문이 같은 deadline 을 쓴다. 오류 원문은 버린다. */
async function request(url, opts = {}, remainingMs = REQUEST_MS) {
  const signal = AbortSignal.timeout(Math.max(1, Math.min(REQUEST_MS, Math.ceil(remainingMs))));
  try {
    const res = await fetch(url, { ...opts, signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* JSON 이 아닌 응답 */ }
    return { res, status: res.status, json };
  } catch {
    throw new Error(signal.aborted ? "E_HTTP_TIMEOUT" : "E_HTTP_REQUEST");
  }
}

/** keys/env.mjs 와 같은 요청 본문. 폴링의 남은 시간까지 취소 상한에 넣는다. */
export async function infer(v1Base, key, real = true, remainingMs = REQUEST_MS) {
  const { status, json } = await request(`${v1Base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: real ? "mko/mock-gpt" : "e2e-probe-no-such-model", messages: [{ role: "user", content: "e2e ping" }] }),
  }, remainingMs);
  return { status, json };
}

export const MAIL_OVERRIDE = path.join(ROOT, "tests/e2e/members/compose.mail.yml");
const TEST_OVERRIDE = path.join(ROOT, "tests/deploy/compose.test.yml");
/** Docker 묶음의 메일 설정 (PUT /api/admin/settings/mail). compose.mail.yml 의 mailpit 과 같은 값이다 */
export const MAIL_SMTP = { provider: "smtp", host: "mailpit", port: 1025, secure: false, requireTLS: false, user: "mg", password: "mgpass-fixed-test", from: "no-reply@mg.test" };
/** Workers 조합 메일 설정 API 본문. 시험 설정의 로컬 send_email 바인딩 EMAIL(remote:false)로 보낸다. 저장할 비밀 값이 없다 */
export const MAIL_CLOUDFLARE = { provider: "cloudflare", from: "no-reply@mg.test" };
/** 가입 확인 메일 제목 (packages/auth/src/mail/messages.ts VERIFY_SUBJECT) */
export const VERIFY_SUBJECT = "[Magnetosphere] 이메일 주소 인증";

/** 오류 원문을 보존하지 않는다. 고정 코드·검증된 TC 식별자·정리 코드만 전달한다. */
export function safeFailure(primary, cleanupCodes = []) {
  const message = typeof primary?.message === "string" ? primary.message : "";
  const codes = primary?.code === "E_MEMBERS_ASSERTION"
    ? ["E_MEMBERS_ASSERTION", ...(message.match(/\bE_CLEANUP_[A-Z_]+\b/g) ?? [])]
    : /^E_[A-Z][A-Z0-9_]*(?:\s|$)/.test(message) ? (message.match(/\bE_[A-Z][A-Z0-9_]*\b/g) ?? []).slice(0, 8) : [];
  const caseId = typeof primary?.caseId === "string" && /^TC-M5\.T\d+\.[a-z]$/.test(primary.caseId) ? primary.caseId : null;
  const cleanup = cleanupCodes.filter((code) => /^E_[A-Z][A-Z0-9_]*$/.test(code));
  const error = new Error([...(primary ? (codes.length ? codes : ["E_MEMBERS_FAILED"]) : []), ...(caseId ? [caseId] : []), ...cleanup].join(" "));
  if (primary?.code === "E_MEMBERS_ASSERTION") error.code = "E_MEMBERS_ASSERTION";
  if (caseId) error.caseId = caseId;
  return error;
}

export const log = (msg) => console.log(`[e2e] ${msg}`);
let checkSequence = 0;
export function check(cond, msg) {
  const caseId = /^TC-M5\.T\d+\.[a-z](?=\s|$)/.exec(msg)?.[0];
  const sequence = ++checkSequence;
  if (!cond) {
    const error = new Error("E_MEMBERS_ASSERTION");
    error.code = "E_MEMBERS_ASSERTION";
    if (caseId) error.caseId = caseId;
    throw error;
  }
  log(`ok  ${caseId ?? "회원 사전 검사"} 검사 ${sequence}`);
}

/** 오류 본문에서 짧은 코드만 (error·code 필드가 영문 코드 모양일 때). 그 밖은 "-" */
export function codeOf(json) {
  const v = json?.error?.code ?? json?.error ?? json?.code;
  return typeof v === "string" && /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : "-";
}
/** 메시지용: HTTP 상태와 짧은 코드 */
export const st = (r) => `${r.status} ${codeOf(r.json)}`;

/** 시험 회원 이메일. 실행마다 다르다 */
export const testEmail = (tag, domain = "e2e.test") => `m5-${randomBytes(4).toString("hex")}-${tag}@${domain}`;
export const testPassword = () => `m5-pw-${randomBytes(12).toString("base64url")}`;

/** 자식 프로세스. 출력은 메모리에만 두고 던지지 않는다 (부르는 쪽이 고정 코드로 던진다) */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], timeout: 180_000, killSignal: "SIGKILL", ...opts });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "", timedOut: r.error?.code === "ETIMEDOUT" };
}

// ---------- Docker 묶음 ----------
export const membersDockerAvailable = () => run("docker", ["info"], { timeout: 10_000 }).code === 0;
export function buildMembersImage() {
  const r = run("docker", ["build", "-q", "-f", "apps/server/Dockerfile", "-t", APP_IMAGE, "."], { timeout: 600_000 });
  if (r.code !== 0) throw new Error(r.timedOut ? "E_IMAGE_TIMEOUT" : "E_IMAGE_BUILD");
}

/** 묶음의 docker compose 인자 (stack.mjs 와 같은 프로젝트·.env 에 가짜 상위 서버·mailpit 덧씌우기를 얹는다) */
function composeArgs(stack) {
  return ["compose", "-p", stack.project, "--env-file", path.join(stack.dir, ".env"), "-f", "docker-compose.yml", "-f", TEST_OVERRIDE, "-f", MOCK_OVERRIDE, "-f", MAIL_OVERRIDE];
}
const compose = (stack, args, opts = {}) => run("docker", [...composeArgs(stack), ...args], { ...opts, env: { ...process.env, MG_ENV_DIR: stack.dir } });

/**
 * 가짜 상위 서버·mailpit 을 붙여 묶음을 띄우고 묶음 OmniRoute 에 제공자·가격을 넣는다 (keys/env.mjs upWithMock 과 같은 순서·재시도 간격).
 * stack.down() 이 같은 프로젝트를 down -v --remove-orphans 로 내리므로 mock·mailpit 까지 지운다.
 */
export function upMembersStack(stack) {
  for (const [n, ms] of [[1, 5_000], [2, 15_000], [3, 0]]) {
    const r = compose(stack, ["up", "-d", "--wait", "--no-build"]);
    if (r.code === 0) break;
    if (n === 3) throw new Error(`E_COMPOSE_UP 묶음 띄우기 실패 (종료코드 ${r.code})`);
    console.error(`::warning title=docker compose up 재시도::[e2e] docker compose up 실패 (종료코드 ${r.code}). ${ms / 1000}초 뒤 다시 띄운다 (${n}/3)`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
  const setup = run(process.execPath, ["tests/contract/setup.mjs"], {
    env: { ...process.env, OMNI_URL: STACK_OMNI_URL, OMNI_PASSWORD: stack.env.INITIAL_PASSWORD, MOCK_UPSTREAM_URL: "http://mock:18080" },
  });
  if (setup.code !== 0) throw new Error(`E_OMNI_SETUP 묶음 OmniRoute 제공자·가격 등록 실패 (종료코드 ${setup.code})`);
}

/** 정리 실패 때 남기는 manifest 폴더 (<임시 폴더>/mg-e2e-members-cleanup/<프로젝트>.json) */
export const CLEANUP_MANIFEST_ROOT = path.join(os.tmpdir(), "mg-e2e-members-cleanup");

/**
 * 이번 시험 프로젝트만 내린다. 내리기에 성공했을 때만, 이 시험이 만든 폴더(임시 폴더 바로 아래 mg-e2e-*)를 지운다.
 * 내리기가 실패하면 폴더(.env 포함)를 0700 으로 남기고 프로젝트 이름·경로만 담은 manifest 를 남긴다 (원문은 내지 않는다).
 */
export function downMembersStack(stack) {
  const errors = [];
  try {
    const r = compose(stack, ["down", "-v", "--remove-orphans", "-t", "5"], { timeout: 30_000 });
    if (r.timedOut || r.code !== 0) errors.push(commandFailureCode("E_CLEANUP_STACK", r));
  } catch { errors.push("E_CLEANUP_STACK_EXIT_UNKNOWN"); }
  if (errors.length) {
    const kept = keepStackForCleanup(stack, CLEANUP_MANIFEST_ROOT);
    errors.push(kept);
    if (kept === "E_CLEANUP_STACK_KEPT") console.error(`[e2e] 묶음 정리 실패: 다시 정리할 manifest 를 남겼다 (임시 폴더/mg-e2e-members-cleanup/${stack.project}.json)`);
  } else if (!ownedStackDir(stack.dir, os.tmpdir())) errors.push("E_CLEANUP_STACK_DIR_SCOPE");
  else {
    try { fs.rmSync(stack.dir, { recursive: true, force: true }); } catch { errors.push("E_CLEANUP_STACK_DIR"); }
  }
  if (errors.length) throw new Error(errors.join(" "));
}
/**
 * 실패 뒤·정리 전 묶음 상태 한 줄 (diagnostics.mjs formatStackSnapshot). 던지지 않는다.
 * app 컨테이너 .State, GET /api/setup 한 번(5초), 호스트 1분 부하만 읽는다. 원문은 버린다.
 */
export async function membersStackSnapshot(stack) {
  let state;
  try {
    const id = compose(stack, ["ps", "-a", "-q", "app"], { timeout: 10_000 });
    const cid = id.code === 0 ? id.out.trim().split("\n")[0] : "";
    if (/^[0-9a-f]{12,64}$/.test(cid)) {
      const r = run("docker", ["inspect", "--format", "{{json .State}}", cid], { timeout: 10_000 });
      if (r.code === 0) state = JSON.parse(r.out);
    }
  } catch { /* 상태를 못 읽으면 unknown */ }
  const t0 = performance.now();
  let probe;
  try {
    const res = await fetch(`${stack.baseUrl}/api/setup`, { signal: AbortSignal.timeout(5_000) });
    await res.arrayBuffer();
    probe = { result: "ok", status: res.status, ms: performance.now() - t0 };
  } catch (e) {
    probe = { result: e?.name === "TimeoutError" ? "timeout" : "error", ms: performance.now() - t0 };
  }
  return formatStackSnapshot({ state, probe, load1: os.loadavg()[0] });
}

export function membersSetupToken(stack) {
  const r = compose(stack, ["logs", "--no-color", "--no-log-prefix", "app"], { timeout: DB_MS });
  if (r.code !== 0) throw new Error("E_SETUP_TOKEN_LOG");
  const token = [...(r.out + r.err).matchAll(/최초 설치 토큰: (\S+)/g)].at(-1)?.[1];
  if (!token) throw new Error("E_SETUP_TOKEN_MISSING");
  return token;
}

/** mailpit HTTP API (127.0.0.1 의 compose 가 정한 포트) */
export function mailpitBox(stack) {
  const p = compose(stack, ["port", "mailpit", "8025"], { timeout: DB_MS });
  const addr = p.out.trim().split("\n").find((l) => /^127\.0\.0\.1:\d+$/.test(l.trim()))?.trim();
  if (p.code !== 0 || !addr) throw new Error(`E_MAILPIT_PORT mailpit HTTP 포트를 찾지 못함 (종료코드 ${p.code})`);
  const base = `http://${addr}`;
  async function list(remainingMs = REQUEST_MS) {
    const { status, json } = await request(`${base}/api/v1/messages?limit=500`, {}, remainingMs);
    if (status !== 200 || !Array.isArray(json?.messages)) throw new Error(`E_MAILPIT_LIST (${status})`);
    return json.messages;
  }
  const matches = (m, to, subject) => m.Subject === subject && (m.To ?? []).some((a) => String(a.Address).toLowerCase() === to.toLowerCase());
  return {
    async clear() {
      const { status } = await request(`${base}/api/v1/messages`, { method: "DELETE" });
      if (status !== 200) throw new Error(`E_MAILPIT_CLEAR (${status})`);
    },
    /** to·subject 가 맞는 메일 수 */
    async count(to, subject) {
      return (await list()).filter((m) => matches(m, to, subject)).length;
    },
    /** to·subject 가 맞는 첫 메일의 본문(text). timeoutMs 안에 없으면 던진다 */
    async waitFor(to, subject, timeoutMs = 30_000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const hit = (await list(end - Date.now())).find((m) => matches(m, to, subject));
        if (hit) {
          if (Date.now() >= end) break;
          const { status, json } = await request(`${base}/api/v1/message/${encodeURIComponent(hit.ID)}`, {}, end - Date.now());
          if (status !== 200 || typeof json?.Text !== "string") throw new Error(`E_MAILPIT_READ (${status})`);
          return json.Text;
        }
        await sleep(Math.min(500, Math.max(0, end - Date.now())));
      }
      throw new Error("E_MAIL_TIMEOUT");
    },
  };
}

// ---------- Workers 로컬 메일 ----------

/** 포트 획득도 최대 5초. 실패한 리스너는 닫는다. */
function memberPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    const timer = setTimeout(() => { s.close(); reject(new Error("E_PORT_TIMEOUT")); }, 5_000);
    s.once("error", () => { clearTimeout(timer); s.close(); reject(new Error("E_PORT")); });
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => { clearTimeout(timer); resolve(port); });
    });
  });
}

/** 회원 전용: 공용 helper 와 같은 옵션, 상태 확인·본문까지 90초 deadline 안에서 취소한다. */
export async function startMembersWrangler({ env, persistTo, vars, hyperdrive, config, testScheduled, logPath }) {
  const port = await memberPort();
  let inspector = await memberPort();
  for (let n = 0; inspector === port && n < 3; n++) inspector = await memberPort();
  if (inspector === port) throw new Error("E_PORT_COLLISION");
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = ["exec", "wrangler", "dev", "--config", config, "--env", env, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", persistTo, "--show-interactive-dev-session=false", "--log-level", "log"];
  for (const [k, v] of Object.entries({ BETTER_AUTH_URL: baseUrl, ...vars })) args.push("--var", `${k}:${v}`);
  if (testScheduled) args.push("--test-scheduled");
  const child = spawn("pnpm", args, {
    cwd: path.join(ROOT, "apps/server"), detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: logPath, NO_COLOR: "1", FORCE_COLOR: "0", ...(hyperdrive ? { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: hyperdrive } : {}) },
  });
  let out = "", failed = false, overflow = false;
  child.on("error", () => { failed = true; });
  const collect = (d) => {
    if (out.length + d.length > 16 * 1024 * 1024) { overflow = true; return; }
    out += d.toString("utf8");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  function groupSignal(signal) {
    if (!child.pid) return false;
    try { process.kill(-child.pid, signal); return true; }
    catch (e) {
      if (e?.code === "ESRCH") return false;
      throw new Error("E_WORKER_STOP");
    }
  }
  async function close() {
    // pnpm 이 먼저 끝나도 wrangler/workerd 가 속한 프로세스 그룹을 끝까지 확인한다.
    if (!groupSignal("SIGTERM")) return;
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      if (!groupSignal(0)) return;
      await sleep(100);
    }
    if (!groupSignal("SIGKILL")) return;
    const hardEnd = Date.now() + 2_000;
    while (Date.now() < hardEnd) {
      if (!groupSignal(0)) return;
      await sleep(100);
    }
    if (groupSignal(0)) throw new Error("E_WORKER_STOP_TIMEOUT");
  }
  try {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      if (failed || child.exitCode !== null || child.signalCode !== null) throw new Error("E_WORKER_EXIT");
      if (overflow) throw new Error("E_WORKER_LOG_LIMIT");
      try {
        const r = await request(`${baseUrl}/healthz`, {}, Math.min(2_000, end - Date.now()));
        if (r.status === 200) return { baseUrl, output: () => { if (overflow) throw new Error("E_WORKER_LOG_LIMIT"); return out; }, close };
      } catch { /* 기동 중인 서버는 남은 시간 안에 다시 확인 */ }
      await sleep(Math.min(300, Math.max(0, end - Date.now())));
    }
    throw new Error("E_WORKER_START_TIMEOUT");
  } catch (e) {
    const cleanup = [];
    try { await close(); } catch { cleanup.push("E_WORKER_START_CLEANUP"); }
    throw safeFailure(e, cleanup);
  }
}

/**
 * apps/server/wrangler.toml 에 환경마다 send_email 바인딩 EMAIL(remote:false)을 더한 시험 설정을 dir 에 쓴다. 그 경로를 돌려준다.
 * 운영 wrangler.toml 은 바꾸지 않는다. 설정 파일이 dir 에 있으므로 상대 경로(main·assets·migrations_dir)는 절대 경로로 바꾼다.
 * send_email 은 환경으로 물려지지 않는 바인딩이라 [env.<이름>] 마다 적는다.
 */
export function workersMailConfig(dir) {
  const server = path.join(ROOT, "apps/server");
  let toml = fs.readFileSync(path.join(server, "wrangler.toml"), "utf8");
  const swaps = [
    [/^main = "src\/workers\.ts"$/m, `main = ${JSON.stringify(path.join(server, "src/workers.ts"))}`],
    [/^directory = "\.\.\/web\/build"$/m, `directory = ${JSON.stringify(path.join(ROOT, "apps/web/build"))}`],
    [/^migrations_dir = "\.\.\/\.\.\/packages\/db\/migrations\/sqlite"$/m, `migrations_dir = ${JSON.stringify(path.join(ROOT, "packages/db/migrations/sqlite"))}`],
  ];
  for (const [re, to] of swaps) {
    if ((toml.match(new RegExp(re.source, "gm")) ?? []).length !== 1) throw new Error("E_WRANGLER_CONFIG wrangler.toml 상대 경로 모양이 바뀜");
    toml = toml.replace(re, to);
  }
  if (/send_email/.test(toml)) throw new Error("E_WRANGLER_CONFIG wrangler.toml 에 이미 send_email 이 있음");
  const envs = [...toml.matchAll(/^\[env\.([a-z0-9]+)\]$/gm)].map((m) => m[1]);
  if (envs.length === 0) throw new Error("E_WRANGLER_CONFIG 환경이 없음");
  toml += envs.map((e) => `\n[[env.${e}.send_email]]\nname = "EMAIL"\nremote = false\n`).join("");
  const file = path.join(dir, "wrangler.e2e.toml");
  fs.writeFileSync(file, toml);
  return file;
}

function inside(root, p) {
  const rel = path.relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** JWT 의 payload (서명은 보지 않는다. 받는 사람 맞추기만) */
function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * 로컬 send_email 바인딩 메일함. wrangler 출력(메모리)의 "Text: <절대 경로>" 줄에서 경로만 꺼내, 실제 경로가 roots(시험이 만든 폴더) 안일 때만 읽는다.
 * 로컬 파일에는 본문만 있어 받는 사람은 확인 링크 JWT 의 email 로 맞춘다. 그래서 확인 메일(VERIFY_SUBJECT)만 다룬다.
 * clear() 는 지금까지 나온 줄을 건너뛴다 (파일은 roots 정리 때 지운다).
 */
export function wranglerBox(dev, roots) {
  const realRoots = roots.map((r) => fs.realpathSync(r));
  let skip = 0;
  function texts() {
    const out = dev.output().replace(/\x1b\[[0-9;]*m/g, "");
    const found = [...out.matchAll(/^\s*Text: (\/.+)$/gm)].map((m) => m[1].trim());
    const bodies = [];
    for (const p of found.slice(skip)) {
      let real;
      try {
        real = fs.realpathSync(p);
      } catch {
        continue;
      }
      if (!realRoots.some((r) => inside(r, real))) continue;
      bodies.push(fs.readFileSync(real, "utf8"));
    }
    return { total: found.length, bodies };
  }
  const forTo = (bodies, to) => bodies.filter((t) => jwtPayload(confirmationToken(t, false) ?? "")?.email === to.toLowerCase());
  const onlyVerify = (subject) => {
    if (subject !== VERIFY_SUBJECT) throw new Error("E_MAIL_SUBJECT 로컬 바인딩 메일함은 확인 메일만 다룬다");
  };
  return {
    async clear() {
      skip = texts().total;
    },
    async count(to, subject) {
      onlyVerify(subject);
      return forTo(texts().bodies, to).length;
    },
    async waitFor(to, subject, timeoutMs = 30_000) {
      onlyVerify(subject);
      const end = Date.now() + timeoutMs;
      for (;;) {
        const hit = forTo(texts().bodies, to)[0];
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`E_MAIL_TIMEOUT ${timeoutMs}ms 안에 메일이 오지 않음`);
        await sleep(500);
      }
    },
  };
}

/** 확인 메일 본문의 /api/auth/signup-confirmation?token=… 값 (JWT). strict 면 없을 때 던진다 */
export function confirmationToken(text, strict = true) {
  const m = /\/api\/auth\/signup-confirmation\?token=([A-Za-z0-9._~%-]+)/.exec(text);
  const token = m ? decodeURIComponent(m[1]) : null;
  if (strict && !token) throw new Error("E_MAIL_TOKEN 확인 메일에 확인 링크가 없음");
  return token;
}

// ---------- 요청 수 제한 맞추기 ----------

/**
 * Better Auth database rate limiter 와 같은 셈 (키 IP|경로): 마지막 요청 뒤 window 가 지나면 0 부터, 아니면 max 번째 다음 요청이 429.
 * 시험의 모든 요청은 한 IP 라 경로마다 하나다. 앞 판정(Hono)이 막은 요청이 세지는지 몰라 모두 센다 (기다림만 늘어난다).
 * 기다림 한 번은 window + 1.5초를 넘지 않는다.
 */
export function pacer() {
  const rules = { "sign-in": { window: 60, max: 5 }, "sign-up": { window: 60, max: 5 }, "signup-confirmation": { window: 300, max: 5 } };
  const state = Object.fromEntries(Object.keys(rules).map((k) => [k, { count: 0, last: 0 }]));
  return {
    /** run.mjs 설치 흐름의 관리자 로그인 두 번처럼 이미 한 요청 */
    seed(key, count) {
      state[key] = { count, last: Date.now() };
    },
    async room(key, count) {
      const r = rules[key];
      const s = state[key];
      if (Date.now() - s.last > r.window * 1000) s.count = 0;
      if (s.count + count > r.max) {
        await sleep(Math.max(0, s.last + r.window * 1000 + 1500 - Date.now()));
        s.count = 0;
      }
    },
    async before(key) {
      const r = rules[key];
      const s = state[key];
      if (Date.now() - s.last > r.window * 1000) s.count = 0;
      if (s.count >= r.max) {
        const wait = s.last + r.window * 1000 + 1500 - Date.now();
        if (wait > 0) {
          log(`${key} 요청 수 제한 창이 찰 때까지 ${Math.ceil(wait / 1000)}초 기다린다`);
          await sleep(wait);
        }
        s.count = 0;
      }
      s.count++;
      s.last = Date.now();
    },
  };
}

// ---------- 회원 앱 HTTP ----------

/** 회원 앱 HTTP. 변경 요청은 같은 출처(Origin = BETTER_AUTH_URL)로 보낸다. 던지지 않고 { status, json } 을 돌려준다 */
export function membersHttp(baseUrl, pace = pacer()) {
  const origin = baseUrl;
  async function call(method, p, { cookie, body } = {}) {
    const headers = { origin };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    return request(baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  return {
    pace,
    api: async (method, p, cookie, body) => {
      const { status, json } = await call(method, p, { cookie, body });
      return { status, json };
    },
    /** { status, cookie, json } (cookie 는 200 일 때만) */
    async signIn(email, password) {
      await pace.before("sign-in");
      const { res, status, json } = await call("POST", "/api/auth/sign-in/email", { body: { email, password } });
      const cookie = res.headers.getSetCookie().map((s) => s.split(";")[0]).filter((s) => /session_token=./.test(s)).join("; ");
      return { status, json, cookie: status === 200 && cookie ? cookie : null };
    },
    /** 공개 가입. extra 는 본문에 더 넣을 필드 (권한 필드 회귀) */
    async signUp(email, password, extra = {}) {
      await pace.before("sign-up");
      const { status, json } = await call("POST", "/api/auth/sign-up/email", { body: { email, password, name: "e2e member", ...extra } });
      return { status, json };
    },
    async confirm(token, password) {
      await pace.before("signup-confirmation");
      const { status, json } = await call("POST", "/api/auth/signup-confirmation", { body: { token, password } });
      return { status, json };
    },
    async accept(token, email, password, extra = {}) {
      const { status, json } = await call("POST", "/api/invites/accept", { body: { token, email, name: "e2e member", password, ...extra } });
      return { status, json };
    },
  };
}

/** 초대 링크(<공개 주소>/invite#<토큰>)의 토큰 */
export function inviteToken(link) {
  const t = typeof link === "string" ? link.split("#")[1] : undefined;
  if (!t) throw new Error("E_INVITE_LINK 초대 링크 모양이 다름");
  return t;
}

/** 관리자 회원 목록에서 이메일로 id 찾기 (상태 거르기). 없으면 던진다 */
export async function memberId(http, adminCookie, email, status) {
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ status });
    if (cursor) q.set("cursor", cursor);
    const r = await http.api("GET", `/api/admin/users?${q}`, adminCookie);
    if (r.status !== 200 || !Array.isArray(r.json?.users)) throw new Error(`E_MEMBER_LIST (${st(r)})`);
    const hit = r.json.users.find((u) => u.email === email.toLowerCase());
    if (hit) return hit.id;
    cursor = r.json.nextCursor;
    if (!cursor) break;
  }
  throw new Error(`E_MEMBER_NOT_FOUND 목록(${status})에 시험 회원이 없음`);
}

/** 가입 정책 PATCH. 바꾸는 필드의 updatedAt 은 방금 읽은 값을 쓴다 */
export async function patchSignup(http, adminCookie, change) {
  const g = await http.api("GET", "/api/admin/settings/signup", adminCookie);
  if (g.status !== 200 || !g.json?.updatedAt) throw new Error(`E_SIGNUP_SETTINGS_GET (${st(g)})`);
  const updatedAt = Object.fromEntries(Object.keys(change).map((k) => [k, g.json.updatedAt[k] ?? null]));
  return http.api("PATCH", "/api/admin/settings/signup", adminCookie, { ...change, updatedAt });
}

// ---------- DB 읽기 ----------

// 회원 앱 DB 읽기 스크립트(READ_SCRIPT)는 diagnostics.mjs 에 있다. runtime 을 불러오지 않고 SQL 드라이버 하나로 고정 SELECT 만 보낸다.
// 시간 초과는 stderr 의 단계 marker 만 읽어 멈춘 단계로, 그 밖의 실패는 종료 번호만 읽어 고정 코드로 진단한다
function parseOut(kind, r) {
  if (r.timedOut) throw new Error(dbReadTimeoutCode(r.err));
  const line = r.code === 0 ? r.out.split("\n").find((l) => l.startsWith("@@")) : undefined;
  if (!line) throw new Error(`${dbReadFailureCode(r)} ${kind}`);
  return JSON.parse(line.slice(2));
}

/**
 * 회원 앱 DB 읽기. 감사·행 수·하루 가입 칸·단언에 필요한 회원 필드만 읽는다.
 * @param {{ stack: any } | { url: string } | { d1: string }} where Docker 묶음(app 컨테이너 안), 이 컴퓨터에서 붙을 DATABASE_URL, 로컬 D1 파일(읽기 전용으로 연다)
 */
export function dbRead(where) {
  let read;
  if ("d1" in where) {
    read = (op) => {
      const db = new DatabaseSync(where.d1, { readOnly: true });
      try {
        if (op.kind === "userCount") return Number(db.prepare('SELECT count(*) AS n FROM "user"').get().n);
        if (op.kind === "auditCount") return Number(db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = ?").get(op.action).n);
        if (op.kind === "counter") {
          const row = db.prepare("SELECT count FROM rate_limit WHERE key = ?").get(op.key);
          return row ? Number(row.count) : null;
        }
        const row = db.prepare('SELECT role, status, monthly_limit_usd, is_bootstrap_admin, email_verified FROM "user" WHERE email = ?').get(op.email);
        return row ? { role: row.role, status: row.status, monthlyLimitUsd: row.monthly_limit_usd == null ? null : Number(row.monthly_limit_usd), isBootstrapAdmin: !!row.is_bootstrap_admin, emailVerified: !!row.email_verified } : null;
      } catch {
        throw new Error(`E_DB_READ ${op.kind} (D1 파일)`);
      } finally {
        db.close();
      }
    };
  } else if ("stack" in where) {
    read = (op, timeoutMs) => parseOut(op.kind, compose(where.stack, ["exec", "-T", "-w", "/repo/apps/server", "-e", `MG_E2E_OP=${JSON.stringify(op)}`, "app", "node", "--input-type=module", "-"], { input: READ_SCRIPT, timeout: Math.max(1, Math.min(DB_MS, timeoutMs ?? DB_MS)) }));
  } else {
    read = (op, timeoutMs) => parseOut(op.kind, run(process.execPath, ["--input-type=module", "-"], { cwd: path.join(ROOT, "apps/server"), input: READ_SCRIPT, timeout: Math.max(1, Math.min(DB_MS, timeoutMs ?? DB_MS)), env: { PATH: process.env.PATH, MG_E2E_OP: JSON.stringify(op), MG_E2E_DB: where.url } }));
  }
  return {
    userCount: () => read({ kind: "userCount" }),
    auditCount: (action, timeoutMs) => read({ kind: "auditCount", action }, timeoutMs),
    /** rate_limit 칸 값 (없으면 null). 오늘 공개 가입 수는 signup-day|<UTC 날짜> */
    counter: (key, timeoutMs) => read({ kind: "counter", key }, timeoutMs),
    /** 회원 한 명의 권한 필드 { role, status, monthlyLimitUsd, isBootstrapAdmin, emailVerified } (없으면 null) */
    user: (email) => read({ kind: "user", email: email.toLowerCase() }),
  };
}

/** 오늘(UTC) 공개 가입 칸 키 (packages/db/src/signup.ts signupDayKey) */
export const signupDayKey = () => `signup-day|${new Date().toISOString().slice(0, 10)}`;

/** cond() 가 참이 될 때까지 기다린다 (timeoutMs 안). 마지막 값을 돌려준다 */
export async function until(get, cond, timeoutMs, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  let v;
  while (Date.now() < end) {
    const remaining = end - Date.now();
    let timer;
    try {
      v = await Promise.race([
        get(remaining),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("E_POLL_TIMEOUT")), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
    if (cond(v)) return v;
    await sleep(Math.min(everyMs, Math.max(0, end - Date.now())));
  }
  return v;
}

/** 상한 시험에 120초를 확보한다. 자정 직전이면 새날까지 최대 120초만 기다린다. */
export async function stableSignupDay() {
  const now = Date.now();
  const next = Date.parse(new Date(now).toISOString().slice(0, 10)) + 86_400_000;
  if (next - now <= 120_000) await sleep(Math.min(120_000, next - now + 50));
  return signupDayKey();
}
export function sameSignupDay(key) {
  if (signupDayKey() !== key) throw new Error("E_DATE_BOUNDARY 환경 판정 불가: UTC 날짜가 바뀜; 자동 재시도 안 함");
}

/**
 * 시나리오 환경 (Docker·Workers 같은 모양): { http, v1Base, mail, db, mailSettings }.
 * Workers 는 run.mjs 가 ctx.mailSettings(MAIL_CLOUDFLARE)·ctx.mailRoots(시험이 만든 메일 파일 폴더)·ctx.d1File(D1 조합) 을 줘야 한다. 없으면 던진다.
 */
export function membersEnv(ctx) {
  const http = membersHttp(ctx.baseUrl);
  // 원문은 메모리에서 계수만 한다. production fallback 거부는 고정 실패 문구로, 개발 fallback 은 console marker 로 관측한다.
  // 읽기 한 번마다 고정 상한 DB_MS 를 준다 (남은 관측 시간으로 줄이지 않는다). 실패는 고정 코드만 남긴다.
  const mailAttempts = () => {
    const r = ctx.stack ? compose(ctx.stack, ["logs", "--no-color", "--no-log-prefix", "app"], { timeout: DB_MS }) : null;
    if (r && (r.timedOut || r.code !== 0)) throw new Error(commandFailureCode("E_MAIL_LOG_READ", r));
    const text = r ? r.out + r.err : ctx.dev.output();
    return (text.match(/\[mail\] 메일을 보내지 못했다|\[mail:console\] 받는 사람:|^\s*Text: \/.+$/gm) ?? []).length;
  };
  // run.mjs 설치 흐름이 관리자 로그인을 두 번 했다
  http.pace.seed("sign-in", 2);
  if (ctx.stack) return { http, mailAttempts, v1Base: ctx.baseUrl, mail: mailpitBox(ctx.stack), db: dbRead({ stack: ctx.stack }), mailSettings: MAIL_SMTP };
  if (!ctx.mailSettings || !ctx.mailRoots) throw new Error("E_WORKERS_MAIL_CTX run.mjs 가 Workers 메일 ctx(mailSettings·mailRoots)를 주지 않았다");
  return {
    http,
    mailAttempts,
    v1Base: ctx.contract.url,
    mail: wranglerBox(ctx.dev, ctx.mailRoots),
    db: ctx.dbUrl ? dbRead({ url: ctx.dbUrl }) : dbRead({ d1: ctx.d1File }),
    mailSettings: ctx.mailSettings,
  };
}
