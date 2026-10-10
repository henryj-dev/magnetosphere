#!/usr/bin/env node
// 분석 API 성능 측정 (2단계 실행판 K0.T7, 확인 15번 — 계획서 5.3 분배가 1분마다 분석을 부른다).
//
//   node tests/bench/analytics.mjs [--assert] [--keep]
//
// 1. 측정용 OmniRoute(tests/bench/docker-compose.yml, 127.0.0.1:20171)를 빈 상태로 다시 띄운다 (down → up)
// 2. 계약 환경과 같은 준비(tests/contract/setup.mjs: 제공자 노드 둘·연결·가격)를 한다
// 3. 키 300개를 관리 API 로 만든다. 첫 키로 진짜 요청 2건(OpenAI·Anthropic)을 보내 기록 모양을 얻는다
// 4. 그 두 줄을 본떠 usage_history 에 직접 넣는다. 합계가 정확히 300,000건, 키 300개에 고르게, 이번 달(UTC) 1일 0시부터
//    지금까지 시각을 고르게. 분석 API 는 usage_history 만 읽고 비용을 조회 시점에 토큰 × 가격표로 계산한다 (확인 15번 evidence).
//    넣은 뒤 분석 전체 totalRequests == 300,000, byApiKey 키 수 ≥ 300 으로 확인한다
// 5. 회원 하나 = 키 둘(첫 키 + 둘째 키), 둘째 키는 관리 API 로 지운다 (삭제한 키 포함 조회, 계획서 5.3)
// 6. 두 호출을 데우기 1번 뒤 10번씩 잰다: 전체 키 한 달(필터 없음, byApiKey 로 회원 묶음) · 회원 하나(apiKeyIds 2개)
//    endDate 를 매번 지금으로 줘 응답 캐시를 타지 않는다
// 7. 결과 JSON 을 출력한다. --assert 면 기준(전체 p95 ≤ 5,000ms, 회원 p95 ≤ 1,000ms, 10회씩)을 넘으면 종료코드 1
// 8. 측정용 OmniRoute 를 내린다 (--keep 이면 남긴다). Docker 메모리 4GB 에서 계약 환경과 함께 오래 두지 않는다
//
// 사람이 쓰는 OmniRoute(localhost:20128)는 쓰지 않는다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE = path.join(HERE, "docker-compose.yml");
const BENCH_URL = "http://127.0.0.1:20171";
const PASSWORD = "contract-initial-password-5c1e9a";
const RECORDS = 300_000;
const KEYS = 300;
const RUNS = 10;
const LIMIT = { fullMonthP95Ms: 5_000, memberP95Ms: 1_000 };

const args = new Set(process.argv.slice(2));

function compose(...a) {
  return spawnSync("docker", ["compose", "-f", COMPOSE, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function dockerExec(script, env) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = spawnSync("docker", ["compose", "-f", COMPOSE, "exec", "-T", ...envArgs, "omniroute", "node", "-"], { encoding: "utf8", input: script, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`컨테이너 안 스크립트 실패 (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

async function http(method, p, { token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BENCH_URL + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function infer(key, kind) {
  const [p, body] =
    kind === "openai"
      ? ["/v1/chat/completions", { model: "mko/mock-gpt", messages: [{ role: "user", content: "bench ping" }] }]
      : ["/v1/messages", { model: "mka/claude-mock", max_tokens: 50, messages: [{ role: "user", content: "bench ping" }] }];
  const res = await fetch(BENCH_URL + p, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  await res.text();
  if (res.status !== 200) throw new Error(`${p} → ${res.status}`);
}

const monthStart = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** usage_history 에 본보기 줄을 본떠 n 건 넣는다 (컨테이너 안 better-sqlite3, OmniRoute 와 같은 파일·WAL) */
const INSERT = `
const Database = require("/app/node_modules/better-sqlite3");
const db = new Database("/app/data/storage.sqlite");
db.pragma("busy_timeout = 10000");
const keys = JSON.parse(process.env.BENCH_KEYS);
const n = Number(process.env.BENCH_N);
const from = Number(process.env.BENCH_FROM), to = Number(process.env.BENCH_TO);
const templates = db.prepare("SELECT * FROM usage_history ORDER BY id").all();
if (templates.length !== 2) throw new Error("본보기 줄이 2개가 아니다: " + templates.length);
const cols = Object.keys(templates[0]).filter((c) => c !== "id");
const ins = db.prepare("INSERT INTO usage_history (" + cols.join(",") + ") VALUES (" + cols.map((c) => "@" + c).join(",") + ")");
db.transaction(() => {
  for (let i = 0; i < n; i++) {
    const t = templates[i % 2];
    const k = keys[i % keys.length];
    ins.run({ ...Object.fromEntries(cols.map((c) => [c, t[c]])), api_key_id: k.id, api_key_name: k.name,
      timestamp: new Date(from + Math.floor(((to - from) * i) / n)).toISOString() });
  }
})();
console.log(db.prepare("SELECT COUNT(*) AS n FROM usage_history").get().n);
`;

const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1];

async function measure(label, pathFn) {
  await http("GET", pathFn(), { token: globalThis.token }); // 데우기 (세지 않는다)
  const ms = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const r = await http("GET", pathFn(), { token: globalThis.token });
    ms.push(Math.round(performance.now() - t0));
    if (i === 0) globalThis[`last_${label}`] = r;
  }
  return { p95Ms: p95(ms), runs: ms.length, ms };
}

async function main() {
  compose("down", "--remove-orphans");
  const up = compose("up", "-d", "--wait");
  if (up.status !== 0) throw new Error("측정용 OmniRoute 를 띄우지 못했다");

  process.env.OMNI_URL = BENCH_URL;
  process.env.OMNI_PASSWORD = PASSWORD;
  const { setup } = await import("../contract/setup.mjs");
  await setup();

  const tok = await http("POST", "/api/cli/connect", { body: { password: PASSWORD, scope: "write", name: "bench", expiresInDays: 1 } });
  globalThis.token = tok.token;

  const keys = [];
  for (let i = 0; i < KEYS; i++) keys.push(await http("POST", "/api/keys", { token: tok.token, body: { name: `bench-${String(i).padStart(3, "0")}` } }));
  await infer(keys[0].key, "openai");
  await infer(keys[0].key, "anthropic");
  // 진짜 요청 2건이 usage_history 에 기록될 때까지 기다린다
  for (let i = 0; ; i++) {
    const n = Number(dockerExec(`const D=require("/app/node_modules/better-sqlite3");console.log(new D("/app/data/storage.sqlite",{readonly:true}).prepare("SELECT COUNT(*) AS n FROM usage_history").get().n)`, {}));
    if (n === 2) break;
    if (i > 50) throw new Error(`본보기 기록이 2건이 아니다: ${n}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  const now = new Date();
  const from = monthStart(now).getTime();
  const total = Number(dockerExec(INSERT, {
    BENCH_KEYS: JSON.stringify(keys.map((k) => ({ id: k.id, name: k.name }))),
    BENCH_N: String(RECORDS - 2),
    BENCH_FROM: String(from),
    BENCH_TO: String(now.getTime() - 60_000),
  }));

  const [member1, member2] = keys;
  await http("DELETE", `/api/keys/${member2.id}`, { token: tok.token });

  const window = () => `startDate=${new Date(from).toISOString()}&endDate=${new Date().toISOString()}`;
  const fullMonth = await measure("full", () => `/api/usage/analytics?${window()}`);
  const full = globalThis.last_full;
  const member = await measure("member", () => `/api/usage/analytics?apiKeyIds=${member1.id},${member2.id}&${window()}`);
  const mem = globalThis.last_member;

  const arch = spawnSync("docker", ["compose", "-f", COMPOSE, "exec", "-T", "omniroute", "uname", "-m"], { encoding: "utf8" }).stdout.trim();
  const result = {
    dataset: { records: full.summary.totalRequests, keys: full.byApiKey.length, inserted: total, memberRequests: mem.summary.totalRequests },
    fullMonth,
    member,
    arch,
    host: `${os.platform()} ${os.arch()}`,
  };
  console.log(JSON.stringify(result, null, 2));
  // CI 에서는 잡 요약에도 남긴다 (게이트는 통과한 검사의 출력을 보여 주지 않는다)
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 분석 API 측정 (확인 15번)\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
  }

  // 한 줄 요약. 게이트는 실패한 검사 출력의 끝 30줄만 보여 주므로 결과 JSON 이 잘려도 이 줄은 남는다
  console.error(`bench: 결과 ${JSON.stringify({ arch, records: result.dataset.records, keys: result.dataset.keys, fullMonth: fullMonth.ms, member: member.ms })}`);
  if (args.has("--assert")) {
    const problems = [];
    if (result.dataset.records !== RECORDS) problems.push(`분석 전체 totalRequests ${result.dataset.records} (기대 ${RECORDS})`);
    if (result.dataset.keys < KEYS) problems.push(`byApiKey 키 ${result.dataset.keys}개 (기대 ≥ ${KEYS})`);
    // 넣은 줄 i 는 키 i % KEYS 의 것이고, 첫 키에는 진짜 요청 2건이 더 있다
    const rowsOf = (k) => Math.floor((RECORDS - 2 - 1 - k) / KEYS) + 1;
    const memberWant = rowsOf(0) + rowsOf(1) + 2;
    if (result.dataset.memberRequests !== memberWant) problems.push(`회원 하나(키 둘, 하나 삭제) totalRequests ${result.dataset.memberRequests} (기대 ${memberWant})`);
    if (fullMonth.runs < RUNS || member.runs < RUNS) problems.push(`측정 횟수 ${fullMonth.runs}·${member.runs} (기대 ${RUNS})`);
    if (fullMonth.p95Ms > LIMIT.fullMonthP95Ms) problems.push(`전체 키 한 달 p95 ${fullMonth.p95Ms}ms (기준 ≤ ${LIMIT.fullMonthP95Ms})`);
    if (member.p95Ms > LIMIT.memberP95Ms) problems.push(`회원 하나 p95 ${member.p95Ms}ms (기준 ≤ ${LIMIT.memberP95Ms})`);
    if (problems.length) {
      for (const p of problems) console.error(`bench: ${p}`);
      process.exitCode = 1;
    } else console.log("bench: 기준 통과");
  }
}

try {
  await main();
} catch (e) {
  console.error(`bench: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (!args.has("--keep")) compose("down", "--remove-orphans");
}
