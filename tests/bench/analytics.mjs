#!/usr/bin/env node
// 분석 API 성능 측정 (2단계 실행판 K0.T7, 확인 15번 — 계획서 5.3 분배가 1분마다 분석을 부른다).
//
//   node tests/bench/analytics.mjs [--assert] [--keep] [--rebalance]
//
// --rebalance (2단계 실행판 K2.T6, TC-K2.T6.h): 6 의 세 호출 대신 1분 분배(apps/server/src/limits/rebalance.ts) 한 번을 잰다.
//   회원 150명·각 키 2개(키 300개 전부 매핑, 둘째 키는 삭제한 키)를 SQLite 파일 DB 에 넣고 실제 어댑터로 이 OmniRoute 에 붙는다.
//   - 날이 바뀐 첫 분배: 날 확정(어제 창)·대조(이번 달 1일 ~ 어제)·오늘 창·키마다 setBudget. 기준 ≤ 55,000ms (1분 작업 임대)
//   - 보통 분배: 같은 날 두 번째 실행. 모든 회원 한도를 올려 키마다 setBudget 이 다시 나가게 한다. 기준 ≤ 30,000ms
//
// 1. 측정용 OmniRoute(tests/bench/docker-compose.yml, 127.0.0.1:20171)를 빈 상태로 다시 띄운다 (down → up)
// 2. 계약 환경과 같은 준비(tests/contract/setup.mjs: 제공자 노드 둘·연결·가격)를 한다
// 3. 키 300개를 관리 API 로 만든다. 첫 키로 진짜 요청 2건(OpenAI·Anthropic)을 보내 기록 모양을 얻는다
// 4. 그 두 줄을 본떠 usage_history 에 직접 넣는다. 합계 정확히 300,000건(한 달 분량), 키 300개에 고르게,
//    오늘(UTC)을 포함한 최근 30일에 하루 10,000건씩. 오늘 몫은 오늘 00:00 UTC 부터 지금까지에 고르게 둔다.
//    분석 API 는 usage_history 만 읽고 비용을 조회 시점에 토큰 × 가격표로 계산한다 (확인 15번 evidence).
//    넣은 뒤 30일 창 totalRequests == 300,000·byApiKey ≥ 300, 오늘 창 == 10,000 으로 확인한다
// 5. 회원 하나 = 키 둘(첫 키 + 둘째 키), 둘째 키는 관리 API 로 지운다 (삭제한 키 포함 조회, 계획서 5.3)
// 6. 세 호출을 데우기 1번 뒤 10번씩 잰다 (계획서 v5.7 5.3)
//    - 오늘 창: 1분 분배가 매번 부르는 것. startDate 오늘 00:00 UTC, 필터 없음
//    - 회원 하나: 30일 창, apiKeyIds 2개 (즉시 분배·사용량 화면)
//    - 대조: 하루 한 번 지난 날 저장값을 다시 맞추는 것. 가장 나쁜 경우(지난 29일)로 잰다
//    endDate 를 매번 지금으로 줘 응답 캐시를 타지 않는다
// 7. 결과 JSON 을 출력한다. --assert 면 기준(오늘 창 p95 ≤ 2,000ms, 회원 p95 ≤ 1,000ms,
//    대조 p95 ≤ 55,000ms(1분 작업 임대), 10회씩)을 넘으면 종료코드 1
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
const DAYS = 30;
const PER_DAY = RECORDS / DAYS;
const DAY_MS = 86_400_000;
const LIMIT = { todayP95Ms: 2_000, memberP95Ms: 1_000, reconcileP95Ms: 55_000, rebalanceFirstMs: 55_000, rebalanceMs: 30_000 };
const MEMBERS = KEYS / 2;

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

const dayStart = (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

/** usage_history 에 본보기 줄을 본떠 n 건 넣는다 (컨테이너 안 better-sqlite3, OmniRoute 와 같은 파일·WAL) */
const INSERT = `
const Database = require("/app/node_modules/better-sqlite3");
const db = new Database("/app/data/storage.sqlite");
db.pragma("busy_timeout = 10000");
const keys = JSON.parse(process.env.BENCH_KEYS);
const n = Number(process.env.BENCH_N);
const today = Number(process.env.BENCH_TODAY), now = Number(process.env.BENCH_NOW);
const perDay = Number(process.env.BENCH_PER_DAY), dayMs = 86400000;
const templates = db.prepare("SELECT * FROM usage_history ORDER BY id").all();
if (templates.length !== 2) throw new Error("본보기 줄이 2개가 아니다: " + templates.length);
const cols = Object.keys(templates[0]).filter((c) => c !== "id");
const ins = db.prepare("INSERT INTO usage_history (" + cols.join(",") + ") VALUES (" + cols.map((c) => "@" + c).join(",") + ")");
db.transaction(() => {
  for (let i = 0; i < n; i++) {
    const t = templates[i % 2];
    const k = keys[i % keys.length];
    // 진짜 요청 2건이 오늘 몫에 이미 있으므로 i + 2 로 날을 나눈다: 날마다 정확히 perDay 건
    const d = Math.floor((i + 2) / perDay), j = (i + 2) % perDay;
    const from = today - d * dayMs, span = d === 0 ? Math.max(now - today, 1) : dayMs;
    ins.run({ ...Object.fromEntries(cols.map((c) => [c, t[c]])), api_key_id: k.id, api_key_name: k.name,
      timestamp: new Date(from + Math.floor((span * j) / perDay)).toISOString() });
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
  const today = dayStart(now);
  const from = today - (DAYS - 1) * DAY_MS;
  const total = Number(dockerExec(INSERT, {
    BENCH_KEYS: JSON.stringify(keys.map((k) => ({ id: k.id, name: k.name }))),
    BENCH_N: String(RECORDS - 2),
    BENCH_TODAY: String(today),
    BENCH_NOW: String(now.getTime() - 60_000),
    BENCH_PER_DAY: String(PER_DAY),
  }));

  const [member1, member2] = keys;
  await http("DELETE", `/api/keys/${member2.id}`, { token: tok.token });

  const iso = (t) => new Date(t).toISOString();
  const all = await http("GET", `/api/usage/analytics?startDate=${iso(from)}&endDate=${iso(Date.now())}`, { token: tok.token });
  if (args.has("--rebalance")) return rebalanceBench(all, keys, tok.token, total);
  const todayWindow = await measure("today", () => `/api/usage/analytics?startDate=${iso(today)}&endDate=${iso(Date.now())}`);
  const member = await measure("member", () => `/api/usage/analytics?apiKeyIds=${member1.id},${member2.id}&startDate=${iso(from)}&endDate=${iso(Date.now())}`);
  const reconcile = await measure("reconcile", () => `/api/usage/analytics?startDate=${iso(from)}&endDate=${iso(today - 1)}`);
  const mem = globalThis.last_member;

  const arch = spawnSync("docker", ["compose", "-f", COMPOSE, "exec", "-T", "omniroute", "uname", "-m"], { encoding: "utf8" }).stdout.trim();
  const result = {
    dataset: {
      records: all.summary.totalRequests, keys: all.byApiKey.length, inserted: total, days: DAYS,
      todayRecords: globalThis.last_today.summary.totalRequests, reconcileRecords: globalThis.last_reconcile.summary.totalRequests,
      memberRequests: mem.summary.totalRequests,
    },
    todayWindow,
    member,
    reconcile,
    arch,
    host: `${os.platform()} ${os.arch()}`,
  };
  console.log(JSON.stringify(result, null, 2));
  // CI 에서는 잡 요약과 RUNNER_TEMP 파일에도 남긴다 (게이트는 통과한 검사의 출력을 보여 주지 않는다. ci.yml 의 다음 스텝이 파일을 출력한다)
  if (process.env.RUNNER_TEMP) fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "bench-analytics.json"), `${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 분석 API 측정 (확인 15번)\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
  }

  // 한 줄 요약. 게이트는 실패한 검사 출력의 끝 30줄만 보여 주므로 결과 JSON 이 잘려도 이 줄은 남는다
  console.error(`bench: 결과 ${JSON.stringify({ arch, ...result.dataset, today: todayWindow.ms, member: member.ms, reconcile: reconcile.ms })}`);
  if (args.has("--assert")) {
    const problems = [];
    const d = result.dataset;
    if (d.records !== RECORDS) problems.push(`30일 창 totalRequests ${d.records} (기대 ${RECORDS})`);
    if (d.keys < KEYS) problems.push(`byApiKey 키 ${d.keys}개 (기대 ≥ ${KEYS})`);
    if (d.todayRecords !== PER_DAY) problems.push(`오늘 창 totalRequests ${d.todayRecords} (기대 ${PER_DAY})`);
    if (d.reconcileRecords !== RECORDS - PER_DAY) problems.push(`대조 창 totalRequests ${d.reconcileRecords} (기대 ${RECORDS - PER_DAY})`);
    // 넣은 줄 i 는 키 i % KEYS 의 것이고, 첫 키에는 진짜 요청 2건이 더 있다
    const rowsOf = (k) => Math.floor((RECORDS - 2 - 1 - k) / KEYS) + 1;
    const memberWant = rowsOf(0) + rowsOf(1) + 2;
    if (d.memberRequests !== memberWant) problems.push(`회원 하나(키 둘, 하나 삭제) totalRequests ${d.memberRequests} (기대 ${memberWant})`);
    for (const [name, m] of [["오늘 창", todayWindow], ["회원 하나", member], ["대조", reconcile]]) if (m.runs < RUNS) problems.push(`${name} 측정 횟수 ${m.runs} (기대 ${RUNS})`);
    if (todayWindow.p95Ms > LIMIT.todayP95Ms) problems.push(`오늘 창 p95 ${todayWindow.p95Ms}ms (기준 ≤ ${LIMIT.todayP95Ms})`);
    if (member.p95Ms > LIMIT.memberP95Ms) problems.push(`회원 하나 p95 ${member.p95Ms}ms (기준 ≤ ${LIMIT.memberP95Ms})`);
    if (reconcile.p95Ms > LIMIT.reconcileP95Ms) problems.push(`대조 p95 ${reconcile.p95Ms}ms (기준 ≤ ${LIMIT.reconcileP95Ms}, 임대)`);
    if (problems.length) {
      for (const p of problems) console.error(`bench: ${p}`);
      process.exitCode = 1;
    } else console.log("bench: 기준 통과");
  }
}

/** 1분 분배 한 번의 소요 (TC-K2.T6.h). keys[1] 은 main 이 지운 키다 (회원 0 의 삭제한 키) */
async function rebalanceBench(all, keys, token, inserted) {
  const { migrateDatabase } = await import("../../apps/server/src/migrate.ts");
  const { connectNode } = await import("../../packages/runtime/src/node.ts");
  const { createClient } = await import("../../packages/omniroute/src/index.ts");
  const { rebalanceAll } = await import("../../apps/server/src/limits/rebalance.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-bench-rebalance-"));
  const url = `file:${path.join(dir, "app.sqlite")}`;
  await migrateDatabase(url);
  const h = await connectNode(url);
  try {
    const s = h.schema;
    for (let m = 0; m < MEMBERS; m++) {
      const userId = crypto.randomUUID();
      await h.db.insert(s.user).values({ id: userId, name: `bench-${m}`, email: `bench-${m}@example.com`, monthlyLimitUsd: 1000 });
      for (const i of [2 * m, 2 * m + 1]) {
        const deleted = i === 1;
        await h.db.insert(s.apiKeys).values({ id: crypto.randomUUID(), userId, omnirouteKeyId: keys[i].id, keyPreview: keys[i].key.slice(-4), state: deleted ? "deleted" : "active", createdAt: new Date(), deletedAt: deleted ? new Date() : null });
      }
    }
    const client = (o) => createClient({ baseUrl: BENCH_URL, credential: { token }, timeoutMs: o?.timeoutMs ?? 15_000 });
    let t0 = performance.now();
    const first = await rebalanceAll({ db: h, now: new Date(), client });
    const firstMs = Math.round(performance.now() - t0);
    await h.db.update(s.user).set({ monthlyLimitUsd: 1001 });
    t0 = performance.now();
    const normal = await rebalanceAll({ db: h, now: new Date(), client });
    const normalMs = Math.round(performance.now() - t0);
    const usageDailyRows = (await h.db.select({ k: s.usageDaily.keyId }).from(s.usageDaily)).length;
    const result = {
      dataset: { records: all.summary.totalRequests, keys: all.byApiKey.length, inserted, members: MEMBERS },
      rebalance: {
        firstMs,
        normalMs,
        first: { members: first.members, setBudget: first.setBudget, failed: first.failed, confirmed: first.confirm.confirmed, reconciled: first.confirm.reconciled, timedOut: first.confirm.timedOut },
        normal: { members: normal.members, setBudget: normal.setBudget, failed: normal.failed, confirmed: normal.confirm.confirmed },
        usageDailyRows,
      },
      host: `${os.platform()} ${os.arch()}`,
    };
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 1분 분배 측정 (TC-K2.T6.h)\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
    console.error(`bench: 분배 ${JSON.stringify({ firstMs, normalMs, firstSetBudget: first.setBudget, normalSetBudget: normal.setBudget })}`);
    if (args.has("--assert")) {
      const problems = [];
      const active = KEYS - 1;
      if (all.summary.totalRequests !== RECORDS) problems.push(`30일 창 totalRequests ${all.summary.totalRequests} (기대 ${RECORDS})`);
      if (first.members !== MEMBERS || normal.members !== MEMBERS) problems.push(`분배 회원 ${first.members}·${normal.members} (기대 ${MEMBERS})`);
      if (first.setBudget !== active || normal.setBudget !== active) problems.push(`setBudget ${first.setBudget}·${normal.setBudget} (기대 ${active}, 켜진 키마다)`);
      if (first.failed || normal.failed) problems.push(`OmniRoute 호출 실패 ${first.failed}·${normal.failed}`);
      if (!first.confirm.confirmed) problems.push("첫 분배가 어제를 확정하지 않았다");
      if (normal.confirm.confirmed) problems.push("같은 날 두 번째 분배가 날 확정을 다시 했다");
      if (firstMs > LIMIT.rebalanceFirstMs) problems.push(`날이 바뀐 첫 분배 ${firstMs}ms (기준 ≤ ${LIMIT.rebalanceFirstMs}, 임대)`);
      if (normalMs > LIMIT.rebalanceMs) problems.push(`보통 분배 ${normalMs}ms (기준 ≤ ${LIMIT.rebalanceMs})`);
      if (problems.length) {
        for (const p of problems) console.error(`bench: ${p}`);
        process.exitCode = 1;
      } else console.log("bench: 분배 기준 통과");
    }
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
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
