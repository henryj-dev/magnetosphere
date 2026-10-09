#!/usr/bin/env node
// V27 검사 (G-S1.13). 컨테이너 준비 확인 → wrangler dev(로컬) 기동 → /probe?db=mysql|pg 호출 → 셋 다 true 인지 단언.
// 저장소 루트에서 `node spikes/v27/probe.mjs` 로 돈다. 성공하면 종료코드 0.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8798;
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const KEYS = ["write", "read", "txRollback"];

const log = (...a) => console.log("[v27]", ...a);
function fail(msg) {
  console.error(`[v27] 실패: ${msg}`);
  process.exitCode = 1;
}

// 1) 컨테이너 준비 확인. 여기서는 띄우지 않는다 (up.sh 가 한다).
function containerReady(name, cmd) {
  const running = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], { encoding: "utf8" });
  if (running.status !== 0 || running.stdout.trim() !== "true") return `${name} 컨테이너가 실행 중이 아니다`;
  const q = spawnSync("docker", ["exec", name, ...cmd], { encoding: "utf8" });
  if (q.status !== 0) return `${name} 에 쿼리가 안 된다: ${(q.stderr || q.stdout).trim()}`;
  return null;
}

function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true)));
    s.listen(port, HOST);
  });
}

async function waitReady(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const r = await fetch(`${BASE}/__v27_ready`);
      await r.arrayBuffer();
      return true; // 404 라도 응답하면 워커가 떠 있는 것
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
}

async function main() {
  const problems = [
    containerReady("v27-mysql", ["mysql", "-h127.0.0.1", "-P3306", "-uv27", "-pv27pass", "v27", "-e", "SELECT 1"]),
    containerReady("v27-pg", ["psql", "-h127.0.0.1", "-U", "v27", "-d", "v27", "-c", "SELECT 1"]),
  ].filter(Boolean);
  if (problems.length) {
    problems.forEach((p) => fail(p));
    fail(`먼저 \`bash ${join("spikes", "v27", "up.sh")}\` 를 실행한다`);
    return;
  }
  log("컨테이너 준비됨 (v27-mysql:23306, v27-pg:25432)");

  const bin = join(HERE, "node_modules", ".bin", "wrangler");
  if (!existsSync(bin)) {
    fail(`wrangler 가 없다. \`pnpm -C spikes/v27 install --ignore-workspace\` 를 먼저 실행한다`);
    return;
  }
  if (!(await portFree(PORT))) {
    fail(`${HOST}:${PORT} 를 이미 누가 쓰고 있다`);
    return;
  }

  let out = "";
  const child = spawn(bin, ["dev", "--local", "--ip", HOST, "--port", String(PORT), "--log-level", "warn"], {
    cwd: HERE,
    detached: true, // 프로세스 그룹째로 죽이기 위해
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const cleanup = () => killTree(child);
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });

  try {
    if (!(await waitReady(child, 60_000))) {
      fail(`wrangler dev 가 60초 안에 뜨지 않았다\n${out.slice(-3000)}`);
      return;
    }
    log(`wrangler dev 준비됨 (${BASE})`);

    const results = {};
    for (const db of ["mysql", "pg"]) {
      const r = await fetch(`${BASE}/probe?db=${db}`);
      const body = await r.json().catch(() => ({ error: "JSON 아님" }));
      results[db] = body;
      const ok = r.ok && KEYS.every((k) => body[k] === true);
      log(`${db}: HTTP ${r.status} ${JSON.stringify(body)}`);
      if (!ok) fail(`${db} 단언 실패 (기대: ${KEYS.map((k) => `${k}=true`).join(", ")})`);
    }
    if (!process.exitCode) log("통과: mysql·pg 모두 write/read/txRollback = true");
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  fail(e?.stack ?? String(e));
});
