#!/usr/bin/env node
// CI 매트릭스 검사 (실행판 S7.T1, TC-S7.T1.a·b·c).
//
//   node scripts/check-ci-matrix.mjs --expect 6
//       .github/workflows/ci.yml 전체 검사 + .github/workflows/*.yml 모두의 위생 검사(pin·permissions·trigger)
//   node scripts/check-ci-matrix.mjs --fixture <yml> --expect 6 --expect-fail
//   node scripts/check-ci-matrix.mjs --fixture-dir <폴더> --expect 6 --expect-fail
//       음성 대조. 픽스처마다 머리 주석 `# expect: <문제 코드>` 의 문제가 잡혀야 종료코드 0.
//       파일을 못 읽은 실패나 다른 문제만 잡힌 것은 검출로 치지 않는다.
//
// 워크플로를 YAML 로 읽어(yaml 패키지, 버전 고정) 다음을 본다. [] 안은 문제 코드다.
//   matrix   E2E 매트릭스 잡이 하나이고 matrix.combo 가 --expect 개, 게이트 설정 S6 의 `pnpm e2e --combo <조합>` 검사와 같은 집합이다
//            [combo-count·combo-set·matrix-shape]. include·exclude 로 조합을 바꾸지 않는다 [matrix-shape].
//   stage    봉인 파일이 있는(면제 아닌) 단계 중 S1 을 뺀 모든 단계를 어떤 스텝이 `node scripts/gate.mjs <단계>` 로 돈다 [stage-missing]. --skip-requires 는 쓰지 않고
//            [skip-requires], --skip-ids 로 뺄 수 있는 것은 매트릭스가 대신 도는 E2E 검사뿐이다 [skip-ids].
//            아직 봉인하지 않은 단계는 요구하지 않는다 — 그 단계 게이트는 아직 빨강이다. 봉인 파일을 커밋하는 순간부터
//            단계 잡이 필수다 (2단계 실행판 K0.T2). --seal-dir <폴더> 로 봉인 폴더를 바꿀 수 있다 (기본 gates/seals, 음성 대조용).
//   guard    게이트·E2E 명령이 조용히 빠지거나 실패가 삼켜지지 않는다. 그 명령을 가진 잡·스텝에
//            if 가 없고 [job-if·step-if], continue-on-error 가 없고 [continue-on-error], shell 을 바꾸지 않는다 [swallow].
//            명령은 run 줄의 시작에 있고 [not-command] (echo 등으로 감싸지 않음), 그 줄에 ||·;·| ·끝의 & 가 없고,
//            run 본문에 set +e 가 없다 [swallow].
//   s1       S1 은 확인용 코드가 S7.T2 에서 지워져 봉인 커밋에서만 돈다. `--root <봉인 커밋 작업 트리> S1` 스텝이 있다 [s1].
//   위생     모든 워크플로: 모든 `uses:` 가 40자리 커밋 SHA [pin], 최상위 permissions 가 contents: read 하나 [permissions],
//            push·pull_request 둘 다 걸려 있고 branches·paths 거르개가 없다 [trigger].
//            최상위 concurrency.cancel-in-progress 가 true 가 아니고, 식이면 main 을 뺀다 (github.ref != 'refs/heads/main') [concurrency].
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT = ".github/workflows/ci.yml";
const WORKFLOWS = ".github/workflows";

function parseArgs(argv) {
  const out = { file: null, dir: null, expect: null, expectFail: false, sealDir: "gates/seals" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture" || a === "--file") out.file = argv[++i];
    else if (a === "--fixture-dir") out.dir = argv[++i];
    else if (a === "--expect") out.expect = Number(argv[++i]);
    else if (a === "--expect-fail") out.expectFail = true;
    else if (a === "--seal-dir") out.sealDir = argv[++i];
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  if (!Number.isInteger(out.expect) || out.expect < 1) throw new Error("--expect <조합 수> 가 필요하다");
  if (out.dir && !out.expectFail) throw new Error("--fixture-dir 는 --expect-fail 과 함께 쓴다");
  return out;
}

/** 봉인 파일이 있고 면제 봉인이 아닌 단계인지. 봉인 내용의 진위는 gate --verify-seals 가 따로 본다 */
function sealed(sealDir, phase) {
  const p = path.resolve(ROOT, sealDir, `${phase}.json`);
  if (!fs.existsSync(p)) return false;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")).waived !== true;
  } catch {
    return true; // 깨진 봉인 파일도 단계 잡을 요구한다 (조용히 빠지지 않게)
  }
}

/** 게이트 설정: 단계 잡을 요구할 단계 목록(봉인된 단계)과 S6 의 E2E 검사 { id, combo } */
async function gateInfo(sealDir) {
  const { GATES } = await import(pathToFileURL(path.join(ROOT, "gates/gates.config.mjs")).href);
  const checks = (GATES.S6?.checks ?? [])
    .map((c) => ({ id: c.id, m: /^pnpm e2e --combo (\S+)$/.exec(c.cmd ?? "") }))
    .filter((c) => c.m)
    .map((c) => ({ id: c.id, combo: c.m[1] }));
  return { phases: Object.keys(GATES).filter((p) => sealed(sealDir, p)), checks };
}

const GATE_RE = /scripts\/gate\.mjs/;
const E2E_RE = /pnpm e2e\b/;
// 명령 줄에서 실패를 삼키거나 종료코드를 바꾸는 것: ||, ;, 파이프 |, 끝의 & (뒤로 보내기)
const SWALLOW_RE = /\|\||;|(^|[^|])\|(?!\|)|&\s*$/;
const SET_E_OFF_RE = /^\s*set\s+(\+e|\+o\s+errexit)\b/m;

/** 위생 검사: 모든 워크플로 공통 */
function hygiene(doc, name, add) {
  const perms = doc?.permissions;
  if (!perms || typeof perms !== "object" || JSON.stringify(perms) !== JSON.stringify({ contents: "read" })) {
    add("permissions", `${name}: 최상위 permissions 가 { contents: read } 가 아니다 (${JSON.stringify(perms ?? null)})`);
  }
  const on = doc?.on;
  const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : on && typeof on === "object" ? Object.keys(on) : [];
  for (const ev of ["push", "pull_request"]) if (!events.includes(ev)) add("trigger", `${name}: on.${ev} 가 없다`);
  if (on && typeof on === "object" && !Array.isArray(on)) {
    for (const [ev, cfg] of Object.entries(on)) {
      for (const k of ["branches", "branches-ignore", "paths", "paths-ignore", "tags", "tags-ignore"]) {
        if (cfg && typeof cfg === "object" && k in cfg) add("trigger", `${name}: on.${ev}.${k} 거르개로 일부 변경에서 워크플로가 돌지 않는다`);
      }
    }
  }
  // main 에서는 앞 실행을 취소하지 않는다 (K0.T3, S7 리뷰 L5). 커밋 둘이 연달아 main 에 들어가면 앞 커밋(봉인 커밋)의
  // CI 결과가 취소돼 남지 않는다. cancel-in-progress 는 false 이거나, main 을 빼는 식(github.ref != 'refs/heads/main')이어야 한다
  const cancel = doc?.concurrency && typeof doc.concurrency === "object" ? doc.concurrency["cancel-in-progress"] : undefined;
  if (cancel === true || (typeof cancel === "string" && !/^\$\{\{\s*github\.ref\s*!=\s*'refs\/heads\/main'\s*\}\}$/.test(cancel.trim()))) {
    add("concurrency", `${name}: concurrency.cancel-in-progress (${JSON.stringify(cancel)}) 가 main 에서도 앞 실행을 취소한다`);
  }
  for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
    for (const s of def?.steps ?? []) {
      if (typeof s?.uses !== "string" || s.uses.startsWith("./")) continue;
      if (!/^[^@\s]+@[0-9a-f]{40}$/.test(s.uses)) add("pin", `${name} ${job}: ${s.uses} 가 커밋 SHA 로 고정되지 않았다`);
    }
  }
}

/** 명령(게이트·E2E)을 가진 스텝과 그 잡이 조용히 빠지거나 실패를 삼키지 않는지. 엄격히 맞는 명령 줄 목록을 돌려준다 */
function guard(doc, add) {
  const commands = []; // { job, line }
  if (doc?.defaults?.run?.shell) add("swallow", `defaults.run.shell 로 셸을 바꾼다 (${doc.defaults.run.shell})`);
  for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
    const steps = (def?.steps ?? []).filter((s) => typeof s?.run === "string" && (GATE_RE.test(s.run) || E2E_RE.test(s.run)));
    if (!steps.length) continue;
    if (def.if !== undefined) add("job-if", `${job}: 잡에 if (${def.if}) 가 있어 게이트·E2E 가 건너뛰어질 수 있다`);
    if (def["continue-on-error"] !== undefined && def["continue-on-error"] !== false) add("continue-on-error", `${job}: 잡의 continue-on-error 가 실패를 삼킨다`);
    if (def.defaults?.run?.shell) add("swallow", `${job}: defaults.run.shell 로 셸을 바꾼다`);
    for (const s of steps) {
      const label = `${job} "${s.name ?? s.run.split("\n")[0]}"`;
      if (s.if !== undefined) add("step-if", `${label}: 스텝에 if (${s.if}) 가 있다`);
      if (s["continue-on-error"] !== undefined && s["continue-on-error"] !== false) add("continue-on-error", `${label}: 스텝의 continue-on-error 가 실패를 삼킨다`);
      if (s.shell) add("swallow", `${label}: shell (${s.shell}) 로 기본 셸(bash -e)을 바꾼다`);
      if (SET_E_OFF_RE.test(s.run)) add("swallow", `${label}: set +e 로 실패해도 다음 줄로 넘어간다`);
      for (const raw of s.run.split("\n")) {
        const line = raw.trim();
        if (!GATE_RE.test(line) && !E2E_RE.test(line)) continue;
        if (!/^(node scripts\/gate\.mjs|pnpm e2e)\s/.test(line)) {
          add("not-command", `${label}: 명령이 줄의 시작에 없다 (${line})`);
          continue;
        }
        if (SWALLOW_RE.test(line)) {
          add("swallow", `${label}: 명령 줄이 종료코드를 바꾼다 (${line})`);
          continue;
        }
        commands.push({ job, line });
      }
    }
  }
  return commands;
}

function check(doc, name, expect, gates) {
  const problems = [];
  const add = (code, msg) => problems.push({ code, msg });
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") {
    add("matrix-shape", "jobs 가 없다");
    return problems;
  }
  hygiene(doc, name, add);
  const commands = guard(doc, add);

  // matrix
  const matrixJobs = Object.entries(jobs).filter(([, d]) => d?.strategy?.matrix && "combo" in d.strategy.matrix);
  if (matrixJobs.length !== 1) add("matrix-shape", `matrix.combo 를 가진 잡이 ${matrixJobs.length}개 (기대 1)`);
  for (const [job, def] of matrixJobs) {
    const m = def.strategy.matrix;
    const combos = m.combo;
    if (!Array.isArray(combos) || !combos.every((c) => typeof c === "string")) {
      add("matrix-shape", `${job}: matrix.combo 가 문자열 목록이 아니다`);
      continue;
    }
    if (new Set(combos).size !== combos.length) add("combo-set", `${job}: 조합이 겹친다 (${combos.join(", ")})`);
    if (combos.length !== expect) add("combo-count", `${job}: 조합 ${combos.length}개 (기대 ${expect}): ${combos.join(", ")}`);
    const want = gates.checks.map((c) => c.combo);
    const missing = want.filter((c) => !combos.includes(c));
    const extra = combos.filter((c) => !want.includes(c));
    if (missing.length) add("combo-set", `${job}: 게이트 S6 E2E 조합이 빠졌다: ${missing.join(", ")}`);
    if (extra.length) add("combo-set", `${job}: 게이트에 없는 조합: ${extra.join(", ")}`);
    if (m.include || m.exclude) add("matrix-shape", `${job}: matrix.include·exclude 로 조합을 바꾸지 않는다`);
    if (!commands.some((c) => c.job === job && /^pnpm e2e --combo "?\$\{\{\s*matrix\.combo\s*\}\}"?$/.test(c.line))) {
      add("matrix-shape", `${job}: \`pnpm e2e --combo \${{ matrix.combo }}\` 명령 줄이 없다`);
    }
  }

  // stage
  const e2eIds = new Set(gates.checks.map((c) => c.id));
  for (const phase of gates.phases.filter((p) => p !== "S1")) {
    const re = new RegExp(`^node scripts/gate\\.mjs ${phase}(?![0-9])(.*)$`);
    const hits = commands.map((c) => ({ ...c, m: re.exec(c.line) })).filter((c) => c.m);
    if (!hits.length) {
      add("stage-missing", `${phase}: \`node scripts/gate.mjs ${phase}\` 를 도는 명령 줄이 없다`);
      continue;
    }
    for (const h of hits) {
      const rest = h.m[1];
      if (/--skip-requires/.test(rest)) add("skip-requires", `${h.job}: ${phase} 를 --skip-requires 로 돈다`);
      const ids = /--skip-ids\s+"?([^\s"]+)"?/.exec(rest)?.[1]?.split(",").filter(Boolean) ?? [];
      const bad = ids.filter((id) => !e2eIds.has(id));
      if (bad.length) add("skip-ids", `${h.job}: ${phase} 에서 매트릭스가 대신 돌지 않는 검사를 뺐다: ${bad.join(", ")}`);
    }
  }
  if (!commands.some((c) => /^node scripts\/gate\.mjs --root \S+ S1\b/.test(c.line))) add("s1", "S1 을 봉인 커밋 작업 트리에서 도는 명령 줄이 없다");
  return problems;
}

function load(file) {
  return parse(fs.readFileSync(path.resolve(ROOT, file), "utf8"));
}

/** 음성 대조 하나: 머리 주석의 기대 코드가 잡혔는지 */
function expectFail(file, expect, gates) {
  const src = fs.readFileSync(path.resolve(ROOT, file), "utf8");
  const want = /^#\s*expect:\s*([a-z0-9-]+)\s*$/m.exec(src)?.[1];
  if (!want) return { ok: false, msg: `${file}: 머리 주석 "# expect: <문제 코드>" 가 없다` };
  let problems;
  try {
    problems = check(parse(src), file, expect, gates);
  } catch (e) {
    return { ok: false, msg: `${file}: 읽지 못했다 (${e.message}) — 검출로 치지 않는다` };
  }
  const hit = problems.find((p) => p.code === want);
  return hit ? { ok: true, msg: `${file}: [${want}] 잡음 — ${hit.msg}` } : { ok: false, msg: `${file}: [${want}] 를 잡지 못했다 (잡은 것: ${[...new Set(problems.map((p) => p.code))].join(", ") || "없음"})` };
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`check-ci-matrix: ${e.message}`);
  process.exit(2);
}
const gates = await gateInfo(args.sealDir);

if (args.expectFail) {
  const files = args.dir
    ? fs.readdirSync(path.resolve(ROOT, args.dir)).filter((f) => f.endsWith(".yml")).sort().map((f) => path.join(args.dir, f))
    : [args.file ?? DEFAULT];
  if (!files.length) {
    console.error(`check-ci-matrix: ${args.dir} 에 픽스처가 없다`);
    process.exit(1);
  }
  const results = files.map((f) => expectFail(f, args.expect, gates));
  for (const r of results) console.log(`${r.ok ? "잡음" : "놓침"}  ${r.msg}`);
  const missed = results.filter((r) => !r.ok).length;
  if (missed) {
    console.error(`check-ci-matrix: 음성 대조 ${missed}/${results.length} 실패`);
    process.exit(1);
  }
  console.log(`check-ci-matrix: 음성 대조 ${results.length}개 모두 잡음`);
  process.exit(0);
}

const file = args.file ?? DEFAULT;
let problems;
try {
  problems = check(load(file), file, args.expect, gates);
  // 기본 검사는 다른 워크플로(gate.yml 등)의 위생도 본다
  if (!args.file) {
    const dir = path.join(ROOT, WORKFLOWS);
    for (const f of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && path.join(WORKFLOWS, f) !== DEFAULT).sort()) {
      const rel = path.join(WORKFLOWS, f);
      hygiene(load(rel), rel, (code, msg) => problems.push({ code, msg }));
    }
  }
} catch (e) {
  problems = [{ code: "read", msg: `${file} 를 읽지 못했다: ${e.message}` }];
}
for (const p of problems) console.log(`[${p.code}] ${p.msg}`);
if (problems.length) {
  console.error(`check-ci-matrix: 문제 ${problems.length}개`);
  process.exit(1);
}
console.log(`check-ci-matrix: ${file} 매트릭스 ${args.expect}개 조합, 단계 명령·실패 전달·위생(SHA·permissions·trigger) 확인`);
