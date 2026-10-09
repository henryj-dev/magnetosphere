// 시험용 Compose 묶음 하나 (pnpm test:deploy, pnpm e2e --combo docker-*).
// 임시 폴더에 scripts/init.mjs 로 .env·.env.setup 을 만들고, 저장소 최상위 docker-compose.yml 에 compose.test.yml 을 얹어
// 프로젝트 이름이 겹치지 않게 띄운다. 끝나면 down -v 로 볼륨까지 지운다.
// 회원 앱 이미지는 buildAppImage() 가 한 번 만들고 묶음들이 같이 쓴다 (--no-build).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OVERRIDE = path.join(ROOT, "tests/deploy/compose.test.yml");
export const APP_IMAGE = "magnetosphere-app:local";

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

export function dockerAvailable() {
  return sh("docker", ["info"]).code === 0;
}

/** apps/server/Dockerfile 로 회원 앱 이미지를 만든다 (층 캐시가 있으면 금방 끝난다) */
export function buildAppImage() {
  const r = sh("docker", ["build", "-q", "-f", "apps/server/Dockerfile", "-t", APP_IMAGE, "."], { stdio: ["ignore", "pipe", "pipe"] });
  if (r.code !== 0) throw new Error(`회원 앱 이미지 빌드 실패\n${r.err.slice(-4000)}`);
}

/**
 * @param {{ db?: "sqlite" | "mysql" | "postgres", httpPort: number, label?: string }} opts
 */
export function createStack({ db = "sqlite", httpPort, label = "deploy" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mg-${label}-`));
  const project = `mg-${label}-${db}-${randomBytes(3).toString("hex")}`;
  const baseUrl = `http://localhost:${httpPort}`;
  const init = sh(process.execPath, ["scripts/init.mjs", "--dir", dir, "--db", db, "--url", baseUrl]);
  if (init.code !== 0) throw new Error(`init 실패: ${init.err}`);
  // 시험에서는 외부 가격 동기화를 끄고(네트워크에 기대지 않게) 사람이 쓰는 80·443 대신 시험 포트를 연다
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(
    envFile,
    fs.readFileSync(envFile, "utf8").replace(/^PRICING_SYNC_ENABLED=.*$/m, "PRICING_SYNC_ENABLED=false") + `HTTP_PORT=${httpPort}\nHTTPS_PORT=${httpPort + 1}\n`,
  );
  const env = Object.fromEntries(
    fs.readFileSync(envFile, "utf8").split("\n").map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]),
  );
  const procEnv = { ...process.env, MG_ENV_DIR: dir };
  const base = ["compose", "-p", project, "--env-file", envFile, "-f", "docker-compose.yml"];

  const stack = {
    dir,
    project,
    baseUrl,
    env,
    /** 시험 덧씌우기를 얹은 docker compose */
    compose: (...args) => sh("docker", [...base, "-f", OVERRIDE, ...args], { env: procEnv }),
    /** 덧씌우기 없는 운영 설정 그대로의 docker compose (config 확인용) */
    composeBase: (...args) => sh("docker", [...base, ...args], { env: procEnv }),
    up(...services) {
      const r = stack.compose("up", "-d", "--wait", "--no-build", ...services);
      if (r.code !== 0) throw new Error(`docker compose up 실패 (${project})\n${r.err.slice(-3000)}\n${stack.logs("app").slice(-3000)}`);
    },
    logs(service) {
      const r = stack.compose("logs", "--no-color", "--no-log-prefix", service);
      return r.out + r.err;
    },
    /** app 로그에 나온 마지막 설치 토큰 */
    setupToken() {
      const all = [...stack.logs("app").matchAll(/최초 설치 토큰: (\S+)/g)];
      if (!all.length) throw new Error(`app 로그에 설치 토큰이 없다\n${stack.logs("app").slice(-2000)}`);
      return all.at(-1)[1];
    },
    down() {
      stack.compose("down", "-v", "--remove-orphans", "-t", "5");
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return stack;
}

/** 관리자 생성 (POST /api/setup). 응답 JSON 과 상태 */
export async function createAdmin(baseUrl, token, email = "admin@example.com", password = "admin-password-1234") {
  const res = await fetch(`${baseUrl}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ token, email, password, publicBaseUrl: baseUrl }),
  });
  return { status: res.status, body: await res.json().catch(() => null), email, password };
}

/** 이메일 로그인. 상태와 세션 쿠키(이름=값) */
export async function signIn(baseUrl, email, password) {
  const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });
  const cookie = res.headers.getSetCookie().map((s) => s.split(";")[0]).filter((s) => /session_token=/.test(s)).join("; ");
  return { status: res.status, cookie, body: await res.json().catch(() => null) };
}

/**
 * Caddy 하나만 deploy/Caddyfile 그대로 띄우고, 뒤(app-edge:3000·omniroute:20128)에는 받은 요청을 그대로 돌려주는 메아리 서버를 둔다.
 * Caddy 가 뒤로 넘기는 헤더·본문을 직접 본다 (TC-S6.T2.c·d). 메아리는 회원 앱 이미지의 node 로 돈다.
 * @param {{ siteAddress: string, httpPort: number, httpsPort: number }} opts
 */
export function startCaddyProbe({ siteAddress, httpPort, httpsPort }) {
  const id = randomBytes(3).toString("hex");
  const net = `mg-caddy-probe-${id}`;
  const names = [`mg-caddy-echo-${id}`, `mg-caddy-${id}`];
  const run = (...args) => sh("docker", args);
  const echo = `const http=require("http");const h=(req,res)=>{let n=0;req.on("data",d=>n+=d.length);req.on("end",()=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({path:req.url,headers:req.headers,bytes:n}))})};http.createServer(h).listen(3000);http.createServer(h).listen(20128);`;
  const stop = () => {
    run("rm", "-f", ...names);
    run("network", "rm", net);
  };
  try {
    for (const r of [
      run("network", "create", net),
      run("run", "-d", "--name", names[0], "--network", net, "--network-alias", "app-edge", "--network-alias", "omniroute", APP_IMAGE, "node", "-e", echo),
      run("run", "-d", "--name", names[1], "--network", net, "-e", `SITE_ADDRESS=${siteAddress}`, "-p", `127.0.0.1:${httpPort}:80`, "-p", `127.0.0.1:${httpsPort}:443`,
        "-v", `${path.join(ROOT, "deploy/Caddyfile")}:/etc/caddy/Caddyfile:ro`, "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"),
    ]) {
      if (r.code !== 0) throw new Error(`Caddy 탐침 준비 실패\n${r.err}`);
    }
  } catch (e) {
    stop();
    throw e;
  }
  return { stop, logs: () => run("logs", names[1]).err };
}
