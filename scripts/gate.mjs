#!/usr/bin/env node
// 실행판 게이트 장치. 계약은 docs/plan/phase1-todo.md 0절 「GATE와 봉인」.
//
//   gate <단계>                          검사 실행, 실패 시 종료코드 1
//   gate <단계> --seal                   검사를 다시 돌려 모두 통과하면 봉인
//   gate <단계> --explain                실패한 검사의 측정값과 기준
//   gate <단계> --seal --waived "<사유>"  면제 봉인 (waivable 단계만)
//   gate --status [--json]               단계별 상태
//   gate --assert-order [--base <ref>] [--head <ref>]
//                                        잠긴 단계의 산출 경로·설정 변경이 있으면 실패
//   gate --verify-seals [--rerun] [--since <ref>] [--skip-requires <태그>]
//                                        봉인 구조 검사, --rerun 이면 봉인 커밋에서 검사를 다시 돌린다
//
// --skip-requires <태그>: 검사 정의의 requires 에 그 태그가 있는 검사를 SKIP 으로 표시하고 돌리지 않는다.
//   이 컴퓨터에만 준비된 서비스(시험용 OmniRoute·Keycloak 등)가 필요한 검사를 CI 재검에서 빼는 용도다.
//   하나라도 건너뛰면 그 실행으로는 봉인하지 않는다.
//
// 공통 옵션: --root <dir> (기본: git 최상위)

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const CONFIG = "gates/gates.config.mjs";
const SEAL_DIR = "gates/seals";
const BASE_BRANCHES = ["origin/main", "main"];
const STATE = { locked: "🔒", open: "🔓", sealed: "✅", invalid: "⚠", waived: "➖" };
const SHA = /^[0-9a-f]{40}$/;

// ---------- 인자 ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (["root", "base", "head", "since", "waived", "skip-requires", "skip-ids"].includes(key)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) fail(`--${key} 에 값이 필요하다`);
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function fail(message, code = 2) {
  console.error(`gate: ${message}`);
  process.exit(code);
}

// ---------- git ----------

function git(root, args, { allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) fail(`git ${args.join(" ")} 실패: ${(r.stderr ?? "").trim()}`);
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function resolveRef(root, ref) {
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
  return r.ok ? r.out : null;
}

function isAncestor(root, sha, of) {
  return git(root, ["merge-base", "--is-ancestor", sha, of], { allowFail: true }).ok;
}

// 상태 판정(R2)의 기준 끝: origin/main, 없으면 main. 둘 다 없으면 판정하지 않는다.
function defaultTip(root) {
  for (const b of BASE_BRANCHES) {
    const sha = resolveRef(root, b);
    if (sha) return sha;
  }
  fail(`기준 브랜치(${BASE_BRANCHES.join(", ")})를 찾을 수 없다`);
}

// ---------- 파일 보기: 작업 트리 또는 특정 커밋 ----------

function view(root, ref = null) {
  return {
    ref,
    read(rel) {
      if (!ref) {
        const p = path.join(root, rel);
        return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
      }
      const r = git(root, ["show", `${ref}:${rel}`], { allowFail: true });
      return r.ok ? r.out : null;
    },
  };
}

async function loadGates(v, { required = true } = {}) {
  const src = v.read(CONFIG);
  if (src === null) {
    if (required) fail(`설정 파일 없음: ${CONFIG}${v.ref ? ` (${v.ref.slice(0, 7)})` : ""}`);
    return null;
  }
  // 커밋 시점 설정도 같은 방식으로 읽도록, 내용을 임시 모듈로 써서 불러온다.
  const hash = crypto.createHash("sha256").update(src).digest("hex").slice(0, 16);
  const tmp = path.join(os.tmpdir(), `gate-config-${hash}.mjs`);
  if (!fs.existsSync(tmp)) fs.writeFileSync(tmp, src);
  return (await import(pathToFileURL(tmp).href)).GATES;
}

// ---------- 봉인과 상태 ----------

function readSeal(v, phase) {
  const src = v.read(`${SEAL_DIR}/${phase}.json`);
  if (src === null) return null;
  try {
    return JSON.parse(src);
  } catch {
    return { malformed: true };
  }
}

// 봉인 파일 자체가 그 단계의 정당한 봉인 모양인지. 위조·복사·설정 변경을 잡는다.
function sealProblem(root, seal, phase, def) {
  if (seal.malformed) return "JSON 아님";
  if (seal.sealed !== true) return "sealed 가 true 아님";
  if (seal.phase !== phase) return `phase 가 ${JSON.stringify(seal.phase)} (기대 ${phase})`;
  if (typeof seal.head !== "string" || !SHA.test(seal.head)) return "head 가 40자리 커밋 SHA 아님";
  if (!resolveRef(root, seal.head)) return "head 커밋이 저장소에 없음";
  if (seal.waived === true) {
    if (!def.waivable) return "면제할 수 없는 단계의 면제 봉인";
    if (typeof seal.reason !== "string" || !seal.reason.trim()) return "면제 사유 없음";
    return null;
  }
  if (seal.waived !== false) return "waived 가 true/false 아님";
  const want = (def.checks ?? []).map((c) => c.id).sort();
  const got = Array.isArray(seal.checks) ? seal.checks.map((c) => c.id).sort() : [];
  if (want.length === 0) return "설정에 검사가 없는 단계의 봉인";
  if (JSON.stringify(want) !== JSON.stringify(got)) return "봉인의 검사 목록이 설정과 다름";
  if (!seal.checks.every((c) => c.ok === true)) return "실패한 검사가 든 봉인";
  return null;
}

// ctx = { root, gates, seals: view, tip: sha }
function phaseState(ctx, phase, memo = new Map()) {
  if (memo.has(phase)) return memo.get(phase);
  const def = ctx.gates[phase];
  const seal = readSeal(ctx.seals, phase);
  let state;
  if (seal) {
    const bad = sealProblem(ctx.root, seal, phase, def) ?? (isAncestor(ctx.root, seal.head, ctx.tip) ? null : "head 가 기준의 조상 아님");
    const needsOk = (def.needs ?? []).every((n) => ["sealed", "waived"].includes(phaseState(ctx, n, memo)));
    state = bad || !needsOk ? "invalid" : seal.waived ? "waived" : "sealed";
  } else {
    const ready = (def.needs ?? []).every((n) => ["sealed", "waived"].includes(phaseState(ctx, n, memo)));
    state = ready ? "open" : "locked";
  }
  memo.set(phase, state);
  return state;
}

// ---------- 검사 종류 ----------

function walk(root, rel, out = []) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return out;
  if (fs.statSync(abs).isFile()) {
    out.push(rel);
    return out;
  }
  for (const name of fs.readdirSync(abs)) {
    if (name === "node_modules" || name === ".git") continue;
    walk(root, path.join(rel, name), out);
  }
  return out;
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function compare(measured, op, limit) {
  switch (op) {
    case "<=": return measured <= limit;
    case ">=": return measured >= limit;
    case "==": return measured === limit;
    case "!=": return measured !== limit;
    default: throw new Error(`알 수 없는 비교: ${op}`);
  }
}

function getPath(obj, dotted) {
  // "a.b.*.c" — * 는 객체 값·배열 원소 전부로 펼친다.
  let cur = [obj];
  for (const key of dotted.split(".")) {
    const next = [];
    for (const v of cur) {
      if (v === null || typeof v !== "object") continue;
      if (key === "*") next.push(...Object.values(v));
      else if (key in v) next.push(v[key]);
    }
    cur = next;
  }
  return cur;
}

function run(root, cmd) {
  // 부모가 node --test 일 때 물려받는 NODE_TEST_CONTEXT 가 있으면 자식 node --test 가 TAP 를 내지 않아 통과 수를 못 읽는다.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...env, FORCE_COLOR: "0", NO_COLOR: "1" } });
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// 통과한 테스트 수. 못 읽으면 null.
// node --test 는 --test-reporter=tap 출력만 읽는다. 요약의 "# pass" 는 이름 패턴에 걸린 테스트가 0개여도
// 파일 단위 항목을 1로 세므로 쓰지 않고, 파일 이름 항목과 건너뜀·할 일 지시자(# skip, # todo)를 뺀 "ok N - <이름>" 줄을 센다.
function passedCount(raw) {
  // vitest 는 FORCE_COLOR=0 이어도 색상 코드를 섞어 내보낸다. 읽기 전에 지운다.
  const output = raw.replace(/\x1b\[[0-9;]*m/g, "");
  if (/^TAP version/m.test(output)) {
    const names = [...output.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
    return names.filter((n) => !/\.[cm]?[jt]sx?$/.test(n) && !/#\s*(skip|todo)\b/i.test(n)).length;
  }
  const vitest = output.match(/Tests\s+(\d+) passed/);
  return vitest ? Number(vitest[1]) : null;
}

const CHECKS = {
  lines(root, c) {
    const abs = path.join(root, c.file);
    if (!fs.existsSync(abs)) return { ok: false, measured: "파일 없음", limit: c.limit };
    const n = fs.readFileSync(abs, "utf8").split("\n").length;
    return { ok: n <= c.limit, measured: n, limit: c.limit };
  },

  grep(root, c) {
    const op = c.op ?? "<=";
    const limit = `${op} ${c.limit}`;
    const paths = c.in ?? ["."];
    const missing = paths.filter((p) => !fs.existsSync(path.join(root, p)));
    if (missing.length) return { ok: false, measured: `경로 없음: ${missing.join(", ")}`, limit };
    const exclude = (c.exclude ?? []).map(globToRegExp);
    const files = paths.flatMap((p) => walk(root, p)).filter((f) => !exclude.some((x) => x.test(f)));
    if (files.length === 0) return { ok: false, measured: "대상 파일 0개", limit };
    const re = new RegExp(c.pattern, "g");
    let n = 0;
    for (const f of files) n += (fs.readFileSync(path.join(root, f), "utf8").match(re) ?? []).length;
    return { ok: compare(n, op, c.limit), measured: n, limit };
  },

  cmd(root, c) {
    const expect = c.expectExit ?? 0;
    const { code, output } = run(root, c.cmd);
    return { ok: code === expect, measured: code, limit: `종료코드 ${expect}`, output };
  },

  test(root, c) {
    const limit = "종료코드 0, 통과 ≥ 1";
    const { code, output } = run(root, c.cmd);
    if (code !== 0) return { ok: false, measured: `종료코드 ${code}`, limit, output };
    const passed = passedCount(output);
    if (passed === null) return { ok: false, measured: "통과 수를 읽지 못함", limit, output };
    return { ok: passed >= 1, measured: `통과 ${passed}`, limit, output };
  },

  "diff-empty"(root, c) {
    const m = /^seal:(.+)$/.exec(c.since);
    if (!m) throw new Error(`diff-empty.since 는 "seal:<단계>" 형식: ${c.since}`);
    const seal = readSeal(view(root), m[1]);
    if (!seal?.head || !SHA.test(seal.head)) return { ok: false, measured: `${m[1]} 봉인 없음 또는 head 이상`, limit: "변경 0" };
    const diff = git(root, ["diff", "--no-renames", "--name-only", seal.head, "--", c.path], { allowFail: true });
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "--", c.path], { allowFail: true });
    if (!diff.ok || !untracked.ok) return { ok: false, measured: "git 비교 실패", limit: "변경 0" };
    const changed = [diff.out, untracked.out].join("\n").split("\n").filter(Boolean);
    return { ok: changed.length === 0, measured: changed.length, limit: "변경 0" };
  },

  json(root, c) {
    const dir = path.dirname(c.file);
    const re = globToRegExp(path.basename(c.file));
    const absDir = path.join(root, dir);
    const files = fs.existsSync(absDir) ? fs.readdirSync(absDir).filter((f) => re.test(f)) : [];
    const op = c.op ?? "==";
    const limit = `${c.path} ${op} ${JSON.stringify(c.value)}`;
    if (files.length < (c.minFiles ?? 1)) return { ok: false, measured: `파일 ${files.length}개`, limit };
    const bad = [];
    for (const f of files) {
      const values = getPath(JSON.parse(fs.readFileSync(path.join(absDir, f), "utf8")), c.path);
      const okAll = values.length > 0 && values.every((v) => (op === "exists" ? v !== undefined : compare(v, op, c.value)));
      if (!okAll) bad.push(`${f}: ${JSON.stringify(values)}`);
    }
    return { ok: bad.length === 0, measured: bad.length ? bad.join("; ") : `파일 ${files.length}개 일치`, limit };
  },
};

function runChecks(root, phase, def, skipTag = null, skipIds = new Set()) {
  if (!def.checks?.length) fail(`${phase}: 검사 정의가 없다. 빈 단계는 실행·봉인하지 않는다`, 1);
  return def.checks.map((c) => {
    if ((skipTag && (c.requires ?? []).includes(skipTag)) || skipIds.has(c.id)) {
      return { id: c.id, desc: c.desc ?? "", ok: true, skipped: true, measured: skipIds.has(c.id) ? "--skip-ids" : `requires ${skipTag}`, limit: "-" };
    }
    const impl = CHECKS[c.how];
    if (!impl) fail(`${c.id}: 알 수 없는 검사 종류 "${c.how}"`);
    let r;
    try {
      r = impl(root, c);
    } catch (e) {
      r = { ok: false, measured: `오류: ${e.message}`, limit: "-" };
    }
    return { id: c.id, desc: c.desc ?? "", ...r };
  });
}

// ---------- 명령 ----------

function cmdStatus(ctx, asJson) {
  const rows = Object.keys(ctx.gates).map((phase) => {
    const state = phaseState(ctx, phase);
    const seal = readSeal(ctx.seals, phase);
    return { phase, state, mark: STATE[state], needs: ctx.gates[phase].needs ?? [], head: typeof seal?.head === "string" ? seal.head.slice(0, 7) : null };
  });
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log("| 단계 | 상태 | 게이트 명령 | 봉인 |");
  console.log("|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.phase} | ${r.mark} | \`node scripts/gate.mjs ${r.phase}\` | ${r.head ?? "—"} |`);
}

async function cmdAssertOrder(root, baseArg, headArg) {
  const head = resolveRef(root, headArg ?? "HEAD");
  if (!head) fail(`head 를 찾을 수 없다: ${headArg ?? "HEAD"}`);
  const base = baseArg ? resolveRef(root, baseArg) : null;
  if (baseArg && !base) fail(`기준 ref 를 찾을 수 없다: ${baseArg}`);

  const gatesNow = await loadGates(view(root, head));
  const violations = [];

  // 기준 시점에 잠겨 있던 단계의 설정(needs·outputs·waivable)은 바꿀 수 없다. 단계 삭제도 안 된다.
  const gatesBase = base ? await loadGates(view(root, base), { required: false }) : null;
  if (gatesBase) {
    const baseCtx = { root, gates: gatesBase, seals: view(root, base), tip: base };
    for (const [phase, def] of Object.entries(gatesBase)) {
      const now = gatesNow[phase];
      if (!now) {
        violations.push(`${CONFIG}: 단계 ${phase} 삭제`);
        continue;
      }
      if (phaseState(baseCtx, phase) !== "locked") continue;
      for (const key of ["needs", "outputs", "waivable"]) {
        if (JSON.stringify(def[key] ?? null) !== JSON.stringify(now[key] ?? null)) violations.push(`${CONFIG}: 잠긴 단계 ${phase} 의 ${key} 변경`);
      }
    }
  }

  // 판정 대상 이력 안의 봉인으로 상태를 본다. 봉인의 진위는 --verify-seals --rerun 이 따로 확인한다.
  const ctx = { root, gates: gatesNow, seals: view(root, head), tip: head };
  const files = base
    ? git(root, ["diff", "--no-renames", "--name-only", `${base}...${head}`]).out.split("\n").filter(Boolean)
    : [...new Set(git(root, ["log", "--no-renames", "--name-only", "--pretty=format:", head]).out.split("\n").filter(Boolean))];
  for (const [phase, def] of Object.entries(gatesNow)) {
    if (phaseState(ctx, phase) !== "locked") continue;
    const res = (def.outputs ?? []).map(globToRegExp);
    for (const f of files) if (res.some((re) => re.test(f))) violations.push(`${f} → ${phase} (🔒)`);
  }

  if (violations.length) {
    console.error("순서 위반:");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(`순서 위반 없음 (변경 파일 ${files.length}개 검사)`);
}

// sinceRef 가 있으면 그 커밋 이후 봉인 파일이 바뀐 단계만 다시 돌린다 (CI 에서 매 push 전부 재실행하지 않으려고).
function cmdVerifySeals(root, gates, rerun, sinceRef, skipTag = null) {
  const head = resolveRef(root, "HEAD");
  const since = sinceRef ? resolveRef(root, sinceRef) : null;
  if (sinceRef && !since) fail(`기준 ref 를 찾을 수 없다: ${sinceRef}`);
  const changedSeals = since
    ? new Set(git(root, ["diff", "--no-renames", "--name-only", since, head, "--", SEAL_DIR]).out.split("\n").filter(Boolean))
    : null;
  const ctx = { root, gates, seals: view(root), tip: head };
  const problems = [];
  let count = 0;
  for (const [phase, def] of Object.entries(gates)) {
    const seal = readSeal(ctx.seals, phase);
    if (!seal) continue;
    count++;
    const shouldRerun = rerun && (!changedSeals || changedSeals.has(`${SEAL_DIR}/${phase}.json`));
    const bad = sealProblem(root, seal, phase, def) ?? (isAncestor(root, seal.head, head) ? null : "head 가 HEAD 의 조상 아님");
    if (bad) {
      problems.push(`${phase}: ${bad}`);
      continue;
    }
    if (phaseState(ctx, phase) === "invalid") problems.push(`${phase}: 선행 단계 봉인이 유효하지 않음`);
    if (shouldRerun && !seal.waived) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gate-verify-${phase}-`));
      git(root, ["worktree", "add", "--detach", "--quiet", dir, seal.head]);
      try {
        if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) run(dir, "pnpm install --frozen-lockfile --silent");
        // 어떤 검사가 이 환경에서 못 도는지는 봉인 커밋이 아니라 지금 설정(requires)으로 정한다.
      // 봉인 뒤에 태그를 단 검사도 건너뛰되, 태그 없는 검사는 봉인 커밋 코드로 그대로 다시 돈다.
      const skipIds = skipTag ? (def.checks ?? []).filter((c) => (c.requires ?? []).includes(skipTag)).map((c) => c.id) : [];
      const extra = skipIds.length ? ["--skip-ids", skipIds.join(",")] : [];
      const r = spawnSync(process.execPath, [SELF, "--root", dir, phase, ...extra], { encoding: "utf8" });
        if (r.status !== 0) problems.push(`${phase}: 봉인 커밋 ${seal.head.slice(0, 7)} 에서 다시 돌린 검사 실패\n${r.stdout}${r.stderr}`);
      } finally {
        git(root, ["worktree", "remove", "--force", dir], { allowFail: true });
      }
    }
  }
  if (problems.length) {
    console.error("봉인 검증 실패:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`봉인 ${count}개 검증${rerun ? ` (재실행 포함${skipTag ? `, requires ${skipTag} 건너뜀` : ""})` : ""}`);
}

function cmdPhase(root, gates, phase, args) {
  const def = gates[phase];
  if (!def) fail(`알 수 없는 단계: ${phase}`);

  // R1 순서
  const ctx = { root, gates, seals: view(root), tip: defaultTip(root) };
  const memo = new Map();
  const unsealed = (def.needs ?? []).filter((n) => !["sealed", "waived"].includes(phaseState(ctx, n, memo)));
  if (unsealed.length) fail(`${phase}: ${unsealed.join(", ")} 봉인 필요 (R1). 현재 상태는 gate --status`, 1);

  if (args.waived !== undefined) {
    if (!args.seal) fail("--waived 는 --seal 과 함께 쓴다");
    if (!def.waivable) fail(`${phase}: 면제할 수 없는 단계다`, 1);
    if (!args.waived.trim()) fail("면제 사유가 비어 있다", 1);
    writeSeal(root, phase, { waived: true, reason: args.waived, checks: [] });
    console.log(`${phase} 면제 봉인: ${args.waived}`);
    return;
  }

  // R3 재검: 봉인 때도 이전 결과를 읽지 않고 다시 돌린다.
  const skipTag = args["skip-requires"] ?? null;
  const skipIds = new Set((args["skip-ids"] ?? "").split(",").filter(Boolean));
  if ((skipTag || skipIds.size) && args.seal) fail("--skip-requires·--skip-ids 로 건너뛴 실행으로는 봉인하지 않는다", 1);
  const results = runChecks(root, phase, def, skipTag, skipIds);
  for (const r of results) console.log(`${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(10)} ${r.desc}  (${r.measured} / ${r.limit})`);
  const failed = results.filter((r) => !r.ok);

  if (args.explain) {
    for (const r of failed) {
      console.log(`\n[${r.id}] 측정 ${r.measured} / 기준 ${r.limit}`);
      if (r.output) console.log(r.output.split("\n").slice(-30).join("\n"));
    }
  }

  if (failed.length) {
    console.error(`\n${phase}: ${failed.length}/${results.length} 실패${args.seal ? " — 봉인하지 않음" : ""}`);
    process.exit(1);
  }

  if (args.seal) {
    writeSeal(root, phase, { waived: false, reason: null, checks: results.map(({ id, ok, measured, limit }) => ({ id, ok, measured, limit })) });
    console.log(`\n${phase} 봉인: ${SEAL_DIR}/${phase}.json — 커밋해서 main 에 합치면 ✅`);
  } else {
    const skipped = results.filter((r) => r.skipped).length;
    console.log(`\n${phase}: ${results.length - skipped}/${results.length} 통과${skipped ? `, ${skipped}개 건너뜀 (${skipTag ? `requires ${skipTag}` : "--skip-ids"})` : ""}`);
  }
}

function writeSeal(root, phase, { waived, reason, checks }) {
  const head = resolveRef(root, "HEAD");
  if (!head) fail("커밋이 없어 봉인할 수 없다");
  const seal = { phase, sealed: true, head, at: new Date().toISOString(), waived, reason, checks };
  fs.mkdirSync(path.join(root, SEAL_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, SEAL_DIR, `${phase}.json`), `${JSON.stringify(seal, null, 2)}\n`);
}

// ---------- 진입 ----------

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root ?? (git(process.cwd(), ["rev-parse", "--show-toplevel"], { allowFail: true }).out || process.cwd()));

if (args["assert-order"]) {
  await cmdAssertOrder(root, args.base, args.head);
} else {
  const gates = await loadGates(view(root));
  if (args.status) cmdStatus({ root, gates, seals: view(root), tip: defaultTip(root) }, args.json === true);
  else if (args["verify-seals"]) cmdVerifySeals(root, gates, args.rerun === true, args.since, args["skip-requires"] ?? null);
  else if (args._[0]) cmdPhase(root, gates, args._[0], args);
  else fail("사용법: gate <단계> [--seal|--explain|--waived <사유>] | --status [--json] | --assert-order [--base <ref>] [--head <ref>] | --verify-seals [--rerun]");
}
