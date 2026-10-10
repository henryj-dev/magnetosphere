// 2단계 E2E 공용 (K5). 키 시나리오(scenario.mjs)와 Claude Code 시나리오(../claude-code/scenario.mjs)가 쓴다.
//   - Docker 조합: 묶음에 가짜 상위 서버를 붙여 띄우고(compose.mock.yml) 제공자·가격을 넣는다 (tests/contract/setup.mjs 와 같은 값)
//   - 회원 만들기·키 행 읽기는 DB 직접이다 (가입 정책은 3단계). Docker 는 app 컨테이너 안에서, Workers 는 이 컴퓨터에서
//     같은 스크립트(DB_SCRIPT)를 돈다. 둘 다 회원 앱의 connectNode(DATABASE_URL)와 Better Auth hashPassword 를 쓴다.
//   - OmniRoute 조회(분석·키 목록)와 정리는 어댑터(packages/omniroute)로만 한다 (대시보드 쿠키).
//   - 회원 도구 요청(/v1)은 Docker 는 Caddy(공개 주소), Workers 는 계약 환경 OmniRoute 로 보낸다 (run.mjs 머리 주석).
// localhost:20128(사람이 쓰는 OmniRoute)은 쓰지 않는다.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../deploy/stack.mjs";
import { createClient, loginWithPassword } from "../../../packages/omniroute/src/index.ts";
import { isBudgetBlocked } from "../../contract/budget-block.mjs";

export { isBudgetBlocked };
export const MOCK_OVERRIDE = path.join(ROOT, "tests/e2e/keys/compose.mock.yml");
const TEST_OVERRIDE = path.join(ROOT, "tests/deploy/compose.test.yml");
/** Docker 묶음 OmniRoute 를 여는 주소 (compose.mock.yml) */
export const STACK_OMNI_URL = "http://127.0.0.1:20173";
/** tests/contract/setup.mjs 가격으로 OpenAI 호환 요청(mko/mock-gpt) 1건 비용 */
export const OPENAI_COST = 0.00221;
export const ADMIN = { email: "e2e-admin@example.com", password: "e2e-admin-password-1234" };

export const log = (msg) => console.log(`[e2e] ${msg}`);
export function check(cond, msg) {
  if (!cond) throw new Error(msg);
  log(`ok  ${msg}`);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 12).join(" ")} 실패 (${r.status})\n${r.stderr}${r.stdout}`.slice(0, 4000));
  return r.stdout;
}

/** 묶음의 docker compose 인자 (stack.mjs 와 같은 프로젝트·.env 에 compose.mock.yml 을 더 얹는다) */
function composeArgs(stack) {
  return ["compose", "-p", stack.project, "--env-file", path.join(stack.dir, ".env"), "-f", "docker-compose.yml", "-f", TEST_OVERRIDE, "-f", MOCK_OVERRIDE];
}
export const stackCompose = (stack, args, opts = {}) => sh("docker", [...composeArgs(stack), ...args], { ...opts, env: { ...process.env, MG_ENV_DIR: stack.dir } });

/** 가짜 상위 서버를 붙여 묶음을 띄우고 묶음 OmniRoute 에 제공자·가격을 넣는다. stack.down() 이 --remove-orphans 로 mock 까지 내린다 */
export function upWithMock(stack) {
  stackCompose(stack, ["up", "-d", "--wait", "--no-build"]);
  sh(process.execPath, ["tests/contract/setup.mjs"], {
    env: { ...process.env, OMNI_URL: STACK_OMNI_URL, OMNI_PASSWORD: stack.env.INITIAL_PASSWORD, MOCK_UPSTREAM_URL: "http://mock:18080" },
  });
}

/** OmniRoute 어댑터 (대시보드 쿠키). 시험의 조회·정리만 한다 */
export async function omniClient(url, password) {
  const { cookie } = await loginWithPassword({ baseUrl: url }, password);
  return createClient({ baseUrl: url, credential: { cookie } });
}

// 회원 앱 DB 에 직접 하는 일. stdin 으로 넘겨 apps/server 폴더에서 돈다 (워크스페이스 패키지를 그 폴더에서 찾는다)
const DB_SCRIPT = `
import { connectNode } from "@magnetosphere/runtime/node";
import { hashPassword } from "better-auth/crypto";
const op = JSON.parse(process.env.MG_E2E_OP);
const h = await connectNode(process.env.MG_E2E_DB || process.env.DATABASE_URL);
let out = null;
try {
  if (op.kind === "addMember") {
    const now = new Date();
    await h.db.insert(h.schema.user).values({ id: op.id, name: "e2e member", email: op.email, emailVerified: true, createdAt: now, updatedAt: now });
    await h.db.insert(h.schema.account).values({ id: crypto.randomUUID(), accountId: op.id, providerId: "credential", userId: op.id, password: await hashPassword(op.password), createdAt: now, updatedAt: now });
    out = { id: op.id };
  } else if (op.kind === "keys") {
    const rows = await h.db.select().from(h.schema.apiKeys);
    out = rows.filter((r) => r.userId === op.userId).map((r) => ({ id: r.id, ork: r.omnirouteKeyId, state: r.state, reason: r.disabledReason ?? null, budgetUsd: r.budgetUsd == null ? null : Number(r.budgetUsd) }));
  } else throw new Error("모르는 작업 " + op.kind);
} finally {
  await h.close();
}
process.stdout.write("\\n@@" + JSON.stringify(out) + "\\n");
`;

function parseOut(stdout) {
  const line = stdout.split("\n").find((l) => l.startsWith("@@"));
  if (!line) throw new Error(`DB 작업 출력이 없다: ${stdout.slice(-1000)}`);
  return JSON.parse(line.slice(2));
}

/**
 * DB 직접 작업.
 * @param {{ stack: any } | { url: string }} where Docker 묶음(app 컨테이너 안에서) 또는 이 컴퓨터에서 붙을 DATABASE_URL
 */
export function dbOps(where) {
  const run = (op) => {
    const env = JSON.stringify(op);
    if ("stack" in where) {
      return parseOut(stackCompose(where.stack, ["exec", "-T", "-w", "/repo/apps/server", "-e", `MG_E2E_OP=${env}`, "app", "node", "--input-type=module", "-"], { input: DB_SCRIPT }));
    }
    return parseOut(sh(process.execPath, ["--input-type=module", "-"], { cwd: path.join(ROOT, "apps/server"), input: DB_SCRIPT, env: { PATH: process.env.PATH, MG_E2E_OP: env, MG_E2E_DB: where.url } }));
  };
  return {
    /** 이메일 인증된 active 회원 (credential 계정). 한도는 관리자 API 로 건다 */
    addMember(email, password) {
      return run({ kind: "addMember", id: randomUUID(), email, password }).id;
    },
    /** 그 회원의 api_keys 행 (삭제 포함) */
    keys(userId) {
      return run({ kind: "keys", userId });
    },
  };
}

/** Workers 로컬 D1 파일 (wrangler dev --persist-to 의 miniflare D1). 하나여야 한다 */
export function d1File(persistTo) {
  const dir = path.join(persistTo, "v3/d1/miniflare-D1DatabaseObject");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sqlite")) : [];
  if (files.length !== 1) throw new Error(`로컬 D1 파일이 ${files.length}개 (${dir})`);
  return path.join(dir, files[0]);
}

/** 회원 앱 HTTP. 변경 요청은 같은 출처(Origin = BETTER_AUTH_URL)로 보낸다 */
export function appHttp(baseUrl, origin = baseUrl) {
  async function signIn(email, password) {
    const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email, password }) });
    const cookie = res.headers.getSetCookie().map((s) => s.split(";")[0]).filter((s) => /session_token=./.test(s)).join("; ");
    if (res.status !== 200 || !cookie) throw new Error(`로그인 실패 ${email} (${res.status})`);
    return cookie;
  }
  async function api(method, p, cookie, body) {
    const headers = { origin, cookie };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  return { signIn, api };
}

/**
 * 회원 도구 요청 하나. real 이면 mko/mock-gpt (0.00221), 아니면 비용이 들지 않는 탐침 — OmniRoute 는 키 켜짐을 모델 해석보다 먼저 본다
 * (꺼진 키 403 permission_denied, 켜진 키는 모델을 못 찾아 400. 예산 검사는 모델 해석 뒤라 탐침으로는 보이지 않는다)
 */
export async function infer(v1Base, key, real = true) {
  const res = await fetch(`${v1Base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: real ? "mko/mock-gpt" : "e2e-probe-no-such-model", messages: [{ role: "user", content: "e2e ping" }] }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // JSON 이 아닌 본문
  }
  return { status: res.status, json };
}

export const permissionDenied = (r) => r.status === 403 && r.json?.error?.code === "permission_denied";
/** 회원 한도로 거부된 응답: 예산 차단(K0.T11 도우미) 또는 limit 끄기의 403 (v5.6 Q1) */
export const limitRejected = (r) => isBudgetBlocked(r.status, r.json) || permissionDenied(r);
