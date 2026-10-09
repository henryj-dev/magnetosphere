#!/usr/bin/env node
// CI 매트릭스 검사 (실행판 S7.T1, TC-S7.T1.a·b).
//
//   node scripts/check-ci-matrix.mjs --expect 6                              .github/workflows/ci.yml 검사
//   node scripts/check-ci-matrix.mjs --fixture <yml> --expect 6 --expect-fail 음성 대조: 매트릭스 문제가 잡혀야 종료코드 0
//
// 워크플로를 YAML 로 읽어(yaml 패키지, 버전 고정) 다음을 본다.
//   matrix   E2E 매트릭스 잡이 하나이고 matrix.combo 가 --expect 개, 게이트 설정 S6 의 `pnpm e2e --combo <조합>` 검사와 같은 집합이다.
//            include·exclude·continue-on-error 로 조합을 빼거나 실패를 삼키지 않고, 스텝이 `pnpm e2e --combo ${{ matrix.combo }}` 를 돈다.
//   stage    S1 을 뺀 모든 단계를 어떤 스텝이 `node scripts/gate.mjs <단계>` 로 돈다. --skip-requires 는 쓰지 않고,
//            --skip-ids 로 뺄 수 있는 것은 매트릭스가 대신 도는 E2E 검사뿐이다. 그래서 CI 와 로컬 게이트가 어긋나지 않는다.
//   s1       S1 은 확인용 코드(spikes/)가 S7.T2 에서 지워져 봉인 커밋에서만 돈다. `--root <봉인 커밋 작업 트리> S1` 스텝이 있다.
//   pin      모든 `uses:` 가 40자리 커밋 SHA 로 고정돼 있다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT = ".github/workflows/ci.yml";

function parseArgs(argv) {
  const out = { file: DEFAULT, expect: null, expectFail: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture" || a === "--file") out.file = argv[++i];
    else if (a === "--expect") out.expect = Number(argv[++i]);
    else if (a === "--expect-fail") out.expectFail = true;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  if (!out.file) throw new Error("--fixture 뒤에 파일이 없다");
  if (!Number.isInteger(out.expect) || out.expect < 1) throw new Error("--expect <조합 수> 가 필요하다");
  return out;
}

/** 게이트 설정 S6 의 E2E 검사: { id, combo } */
async function e2eChecks() {
  const { GATES } = await import(pathToFileURL(path.join(ROOT, "gates/gates.config.mjs")).href);
  const checks = (GATES.S6?.checks ?? [])
    .map((c) => ({ id: c.id, m: /^pnpm e2e --combo (\S+)$/.exec(c.cmd ?? "") }))
    .filter((c) => c.m)
    .map((c) => ({ id: c.id, combo: c.m[1] }));
  return { phases: Object.keys(GATES), checks };
}

/** 워크플로의 모든 run 스텝 { job, run } */
function runSteps(jobs) {
  return Object.entries(jobs).flatMap(([job, def]) => (def?.steps ?? []).filter((s) => typeof s?.run === "string").map((s) => ({ job, run: s.run })));
}

function check(doc, expect, gates) {
  const problems = [];
  const add = (kind, msg) => problems.push({ kind, msg });
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") {
    add("matrix", "jobs 가 없다");
    return problems;
  }

  // matrix
  const matrixJobs = Object.entries(jobs).filter(([, d]) => d?.strategy?.matrix && "combo" in d.strategy.matrix);
  if (matrixJobs.length !== 1) add("matrix", `matrix.combo 를 가진 잡이 ${matrixJobs.length}개 (기대 1)`);
  for (const [name, def] of matrixJobs) {
    const m = def.strategy.matrix;
    const combos = m.combo;
    if (!Array.isArray(combos) || !combos.every((c) => typeof c === "string")) {
      add("matrix", `${name}: matrix.combo 가 문자열 목록이 아니다`);
      continue;
    }
    if (new Set(combos).size !== combos.length) add("matrix", `${name}: 조합이 겹친다 (${combos.join(", ")})`);
    if (combos.length !== expect) add("matrix", `${name}: 조합 ${combos.length}개 (기대 ${expect}): ${combos.join(", ")}`);
    const want = gates.checks.map((c) => c.combo);
    const missing = want.filter((c) => !combos.includes(c));
    const extra = combos.filter((c) => !want.includes(c));
    if (missing.length) add("matrix", `${name}: 게이트 S6 E2E 조합이 빠졌다: ${missing.join(", ")}`);
    if (extra.length) add("matrix", `${name}: 게이트에 없는 조합: ${extra.join(", ")}`);
    if (m.include || m.exclude) add("matrix", `${name}: matrix.include·exclude 로 조합을 바꾸지 않는다`);
    if (def["continue-on-error"]) add("matrix", `${name}: continue-on-error 로 실패를 삼킨다`);
    if (!(def.steps ?? []).some((s) => typeof s?.run === "string" && /pnpm e2e --combo "?\$\{\{\s*matrix\.combo\s*\}\}"?/.test(s.run))) {
      add("matrix", `${name}: \`pnpm e2e --combo \${{ matrix.combo }}\` 스텝이 없다`);
    }
  }

  // stage
  const runs = runSteps(jobs);
  const e2eIds = new Set(gates.checks.map((c) => c.id));
  for (const phase of gates.phases.filter((p) => p !== "S1")) {
    const re = new RegExp(`node scripts/gate\\.mjs ${phase}(?![0-9])([^\\n]*)`);
    const hits = runs.map((r) => ({ ...r, m: re.exec(r.run) })).filter((r) => r.m);
    if (!hits.length) {
      add("stage", `${phase}: \`node scripts/gate.mjs ${phase}\` 를 도는 스텝이 없다`);
      continue;
    }
    for (const h of hits) {
      const rest = h.m[1];
      if (/--skip-requires/.test(rest)) add("stage", `${h.job}: ${phase} 를 --skip-requires 로 돈다`);
      const ids = /--skip-ids\s+"?([^\s"]+)"?/.exec(rest)?.[1]?.split(",").filter(Boolean) ?? [];
      const bad = ids.filter((id) => !e2eIds.has(id));
      if (bad.length) add("stage", `${h.job}: ${phase} 에서 매트릭스가 대신 돌지 않는 검사를 뺐다: ${bad.join(", ")}`);
    }
  }
  if (!runs.some((r) => /node scripts\/gate\.mjs --root \S+ S1\b/.test(r.run))) add("s1", "S1 을 봉인 커밋 작업 트리에서 도는 스텝이 없다");

  // pin
  for (const [name, def] of Object.entries(jobs)) {
    for (const s of def?.steps ?? []) {
      if (typeof s?.uses !== "string") continue;
      if (!/^[^@\s]+@[0-9a-f]{40}$/.test(s.uses)) add("pin", `${name}: ${s.uses} 가 커밋 SHA 로 고정되지 않았다`);
    }
  }
  return problems;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`check-ci-matrix: ${e.message}`);
  process.exit(2);
}
const file = path.resolve(ROOT, args.file);
let problems;
try {
  const doc = parse(fs.readFileSync(file, "utf8"));
  problems = check(doc, args.expect, await e2eChecks());
} catch (e) {
  problems = [{ kind: "read", msg: `${args.file} 를 읽지 못했다: ${e.message}` }];
}
for (const p of problems) console.log(`[${p.kind}] ${p.msg}`);

if (args.expectFail) {
  // 음성 대조: 매트릭스 문제를 잡았을 때만 통과다. 파일을 못 읽은 실패는 검출로 치지 않는다
  if (problems.some((p) => p.kind === "matrix")) {
    console.log(`check-ci-matrix: ${args.file} 의 매트릭스 문제를 잡았다 (음성 대조 통과)`);
    process.exit(0);
  }
  console.error(`check-ci-matrix: ${args.file} 에서 매트릭스 문제를 잡지 못했다 (음성 대조 실패)`);
  process.exit(1);
}
if (problems.length) {
  console.error(`check-ci-matrix: ${args.file} 문제 ${problems.length}개`);
  process.exit(1);
}
console.log(`check-ci-matrix: ${args.file} 매트릭스 ${args.expect}개 조합, 단계 잡·SHA 고정 확인`);
