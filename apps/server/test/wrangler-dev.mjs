// 로컬 `wrangler dev` 하나를 자식 프로세스로 띄운다 (apps/server/wrangler.toml 의 환경 d1·mysql·pg).
// TC-S6.T3.b·d (pnpm -C apps/server test:workers)와 여섯 조합 E2E 의 workers-* 가 같이 쓴다.
// Worker 의 console.log 는 wrangler 표준 출력으로 나오므로 output() 으로 읽는다 (설치 토큰 추출·경고 확인).
// Hyperdrive 는 로컬에서 CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE 로 로컬 DB 에 바로 붙는다.
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = path.resolve(SERVER_DIR, "../..");
const WRANGLER_ENV = { CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" };

/** 비어 있는 로컬 포트 하나 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** wrangler CLI 를 apps/server 에서 돈다 (끝날 때까지 기다린다) */
export function wrangler(args, env = {}) {
  const r = spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd: SERVER_DIR, encoding: "utf8", env: { ...process.env, ...WRANGLER_ENV, ...env } });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** 로컬 D1 에 SQL 하나. --json 결과의 첫 문장 행들 */
export function d1Query(persistTo, sql) {
  const r = wrangler(["d1", "execute", "DB", "--local", "--env", "d1", "--persist-to", persistTo, "--json", "--command", sql]);
  if (r.code !== 0) throw new Error(`d1 execute 실패: ${r.err}${r.out}`);
  return JSON.parse(r.out)[0].results;
}

/**
 * config 를 주면 wrangler.toml 대신 그 설정 파일로 띄운다 (env 는 그 파일의 환경, 없으면 빼도 된다).
 * testScheduled 면 /__scheduled?cron=… 으로 Cron 호출을 흉내 낼 수 있다 (wrangler dev --test-scheduled).
 * @param {{ env?: "d1" | "mysql" | "pg", persistTo: string, vars: Record<string,string>, hyperdrive?: string, config?: string, testScheduled?: boolean }} opts
 */
export async function startWranglerDev({ env, persistTo, vars, hyperdrive, config, testScheduled }) {
  const port = await freePort();
  const inspector = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const allVars = { BETTER_AUTH_URL: baseUrl, ...vars };
  const args = ["exec", "wrangler", "dev", ...(config ? ["--config", config] : []), ...(env ? ["--env", env] : []), "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", persistTo, "--show-interactive-dev-session=false", "--log-level", "log"];
  for (const [k, v] of Object.entries(allVars)) args.push("--var", `${k}:${v}`);
  if (testScheduled) args.push("--test-scheduled");
  const childEnv = { ...process.env, ...WRANGLER_ENV };
  if (hyperdrive) childEnv.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = hyperdrive;
  const child = spawn("pnpm", args, { cwd: SERVER_DIR, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev 가 끝났다 (종료코드 ${child.exitCode})\n${out.slice(-3000)}`);
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      await r.arrayBuffer();
      if (r.ok) break;
    } catch {
      // 아직 안 떴다
    }
    if (Date.now() > deadline) {
      stop(child);
      throw new Error(`wrangler dev 가 90초 안에 뜨지 않았다\n${out.slice(-3000)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    baseUrl,
    output: () => out,
    /** 출력에 re 가 n 번 나올 때까지 기다린다 (Worker 로그는 응답보다 늦게 올 수 있다). 끝 출력 */
    async waitOutput(re, n = 1, timeoutMs = 10_000) {
      const end = Date.now() + timeoutMs;
      while ((out.match(new RegExp(re.source, "g")) ?? []).length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
      return out;
    },
    async close() {
      await stop(child);
    },
  };
}

/** 프로세스 묶음(pnpm → wrangler → workerd)을 끝낸다 */
function stop(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      resolve();
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // 이미 끝났다
      }
      resolve();
    }, 5000).unref();
  });
}

/** 출력에 나온 마지막 설치 토큰 (없으면 null) */
export function lastSetupToken(output) {
  return [...output.matchAll(/최초 설치 토큰: (\S+)/g)].at(-1)?.[1] ?? null;
}
