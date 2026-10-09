#!/usr/bin/env node
// V21 — OmniRoute 3.8.51 운영 필수 비밀 값 확인 (S1.T5)
//   node spikes/v21/run.mjs all   TC-S1.T5.a: 모든 비밀 값 → /livez 200 (60초 안)
//   node spikes/v21/run.mjs each  TC-S1.T5.b: 하나씩 빼고 띄워 결과가 required 와 맞는지
// 의존성 없음. 컨테이너 이름 omni-v21-*, 호스트 포트 127.0.0.1:20150-20159, 볼륨 없음.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const V21 = JSON.parse(readFileSync(join(HERE, "../../docs/verify/V21.json"), "utf8"));
const IMAGE = "diegosouzapw/omniroute:3.8.51";
const BASE_PORT = 20150;
const MAX_PORT = 20159;
const TIMEOUT_MS = 60_000;
const SECRETS = V21.answer.secrets;

const WARN_RE = /⚠|⛔|❌|warn|error|not set|required|too short|invalid|does not match/i;

function gen(name) {
  switch (name) {
    case "JWT_SECRET":
      return randomBytes(48).toString("base64");
    case "OMNIROUTE_WS_BRIDGE_SECRET":
      return randomBytes(32).toString("base64");
    case "INITIAL_PASSWORD":
      return randomBytes(24).toString("hex");
    default:
      return randomBytes(32).toString("hex");
  }
}

const started = new Set();

async function docker(args) {
  return run("docker", args, { maxBuffer: 64 * 1024 * 1024 });
}

async function removeContainer(name) {
  try {
    await docker(["rm", "-f", "-v", name]);
  } catch {
    /* 없으면 무시 */
  }
  started.delete(name);
}

async function cleanupAll() {
  await Promise.all([...started].map(removeContainer));
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await cleanupAll();
    process.exit(130);
  });
}

async function livez(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/livez`, { signal: AbortSignal.timeout(2000) });
    return res.status;
  } catch {
    return 0;
  }
}

async function isRunning(name) {
  try {
    const { stdout } = await docker(["inspect", "-f", "{{.State.Running}}", name]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function logs(name) {
  try {
    const { stdout, stderr } = await docker(["logs", name]);
    return `${stdout}\n${stderr}`;
  } catch {
    return "";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 컨테이너를 띄우고 /livez 200, 프로세스 종료, 60초 초과 중 하나가 될 때까지 기다린다.
async function boot(name, port, env) {
  await removeContainer(name);
  const args = ["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:20128`];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(IMAGE);
  started.add(name);
  await docker(args);
  const t0 = Date.now();
  let status = 0;
  let exited = false;
  while (Date.now() - t0 < TIMEOUT_MS) {
    status = await livez(port);
    if (status === 200) break;
    if (!(await isRunning(name))) {
      exited = true;
      break;
    }
    await sleep(500);
  }
  // 경고가 /livez 이후에 찍힐 수도 있으니 잠깐 더 둔다
  if (status === 200) await sleep(1500);
  return { status, exited, ms: Date.now() - t0, log: await logs(name) };
}

function warningLines(log, name) {
  return log.split("\n").filter((l) => l.includes(name) && WARN_RE.test(l));
}

function baseEnv(values) {
  return { NODE_ENV: "production", REQUIRE_API_KEY: "true", ...values };
}

async function cmdAll() {
  const values = Object.fromEntries(SECRETS.map((s) => [s.name, gen(s.name)]));
  const name = "omni-v21-all";
  const port = BASE_PORT;
  try {
    const r = await boot(name, port, baseEnv(values));
    let ok = r.status === 200;
    console.log(`[all] /livez=${r.status} exited=${r.exited} ${r.ms}ms`);
    for (const s of SECRETS) {
      const w = warningLines(r.log, s.name);
      if (w.length) {
        ok = false;
        console.log(`[all] 경고 로그 (${s.name}): ${w.join(" | ")}`);
      }
    }
    if (r.status === 200) {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: values.INITIAL_PASSWORD }),
      });
      console.log(`[all] INITIAL_PASSWORD 로그인=${res.status}`);
      if (res.status !== 200) ok = false;
    }
    console.log(ok ? "PASS TC-S1.T5.a" : "FAIL TC-S1.T5.a");
    return ok ? 0 : 1;
  } finally {
    await removeContainer(name);
  }
}

async function checkOne(secret, port) {
  const values = Object.fromEntries(
    SECRETS.filter((s) => s.name !== secret.name).map((s) => [s.name, gen(s.name)])
  );
  const name = `omni-v21-each-${secret.name.toLowerCase().replace(/_/g, "-")}`;
  try {
    const r = await boot(name, port, baseEnv(values));
    const warns = warningLines(r.log, secret.name);
    const failed = r.status !== 200; // 종료 또는 60초 안에 안 뜸
    const observedRequired = failed || warns.length > 0;
    const match = observedRequired === secret.required;
    const detail = failed
      ? `시작 실패(/livez=${r.status}, exited=${r.exited})`
      : warns.length
        ? `경고: ${warns[0].trim()}`
        : `정상 시작 ${r.ms}ms, 경고 없음`;
    console.log(
      `[each] ${match ? "OK  " : "FAIL"} ${secret.name} required=${secret.required} 관측=${observedRequired} — ${detail}`
    );
    return match;
  } finally {
    await removeContainer(name);
  }
}

async function cmdEach() {
  const slots = MAX_PORT - BASE_PORT; // 20151..20159
  const queue = SECRETS.map((s, i) => ({ s, port: BASE_PORT + 1 + (i % slots) }));
  const results = [];
  // 포트 슬롯 수만큼 병렬
  for (let i = 0; i < queue.length; i += slots) {
    const batch = queue.slice(i, i + slots);
    results.push(...(await Promise.all(batch.map(({ s, port }) => checkOne(s, port)))));
  }
  const ok = results.every(Boolean);
  console.log(ok ? "PASS TC-S1.T5.b" : "FAIL TC-S1.T5.b");
  return ok ? 0 : 1;
}

const cmd = process.argv[2];
let code = 2;
try {
  if (cmd === "all") code = await cmdAll();
  else if (cmd === "each") code = await cmdEach();
  else console.error("사용법: node spikes/v21/run.mjs <all|each>");
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await cleanupAll();
}
process.exit(code);
