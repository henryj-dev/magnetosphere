#!/usr/bin/env node
// 실행판 게이트 장치. 계약은 docs/plan/phase1-todo.md 0절 「GATE와 봉인」.
//
//   gate <단계>                       검사 실행, 실패 시 종료코드 1
//   gate <단계> --seal                검사를 다시 돌려 모두 통과하면 봉인
//   gate <단계> --explain             실패한 검사의 측정값과 기준
//   gate <단계> --seal --waived "<사유>"  면제 봉인 (waivable 단계만)
//   gate --status [--json]            단계별 상태
//   gate --assert-order [--base <ref>]  잠긴 단계의 산출 경로 변경이 있으면 실패
//
// 공통 옵션: --root <dir> (기본: git 최상위), --config <path> (기본: gates/gates.config.mjs)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEAL_DIR = "gates/seals";
const BASE_BRANCH = "main";
const STATE = { locked: "🔒", open: "🔓", sealed: "✅", invalid: "⚠", waived: "➖" };

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
    const next = argv[i + 1];
    if (["root", "config", "base", "waived"].includes(key)) {
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
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) fail(`git ${args.join(" ")} 실패: ${r.stderr.trim()}`);
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function resolveRef(root, ref) {
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
  return r.ok ? r.out : null;
}

function isAncestor(root, sha, of) {
  return git(root, ["merge-base", "--is-ancestor", sha, of], { allowFail: true }).ok;
}

// 기준 브랜치가 있으면 그 끝, 없으면 HEAD 를 R2 판정 기준으로 쓴다.
function baseTip(root) {
  return resolveRef(root, BASE_BRANCH) ?? resolveRef(root, "HEAD");
}

// ---------- 봉인과 상태 ----------

function sealPath(root, phase) {
  return path.join(root, SEAL_DIR, `${phase}.json`);
}

function readSeal(root, phase) {
  const p = sealPath(root, phase);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function phaseState(root, gates, phase, memo = new Map()) {
  if (memo.has(phase)) return memo.get(phase);
  const seal = readSeal(root, phase);
  let state;
  if (seal?.sealed) {
    const tip = baseTip(root);
    const valid = tip !== null && resolveRef(root, seal.head) !== null && isAncestor(root, seal.head, tip);
    state = !valid ? "invalid" : seal.waived ? "waived" : "sealed";
  } else {
    const needs = gates[phase].needs ?? [];
    const ready = needs.every((n) => ["sealed", "waived"].includes(phaseState(root, gates, n, memo)));
    state = ready ? "open" : "locked";
  }
  memo.set(phase, state);
  return state;
}

// ---------- 검사 종류 ----------

function walk(root, rel, out = []) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return out;
  const st = fs.statSync(abs);
  if (st.isFile()) {
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
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", env: { ...env, FORCE_COLOR: "0" } });
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// 통과한 테스트 수. 못 읽으면 null.
// node --test 는 --test-reporter=tap 출력만 읽는다. 요약의 "# pass" 는 이름 패턴에 걸린 테스트가 0개여도
// 파일 단위 항목을 1로 세므로 쓰지 않고, 파일 이름으로 된 항목을 뺀 "ok N - <이름>" 줄을 센다.
function passedCount(output) {
  if (/^TAP version/m.test(output)) {
    const names = [...output.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
    return names.filter((n) => !/\.[cm]?[jt]sx?$/.test(n) && !/# SKIP/i.test(n)).length;
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
    const re = new RegExp(c.pattern, "g");
    const exclude = (c.exclude ?? []).map(globToRegExp);
    const files = (c.in ?? ["."]).flatMap((p) => walk(root, p)).filter((f) => !exclude.some((x) => x.test(f)));
    let n = 0;
    for (const f of files) n += (fs.readFileSync(path.join(root, f), "utf8").match(re) ?? []).length;
    const op = c.op ?? "<=";
    return { ok: compare(n, op, c.limit), measured: n, limit: `${op} ${c.limit}` };
  },

  cmd(root, c) {
    const expect = c.expectExit ?? 0;
    const { code } = run(root, c.cmd);
    return { ok: code === expect, measured: code, limit: `종료코드 ${expect}` };
  },

  test(root, c) {
    const { code, output } = run(root, c.cmd);
    const passed = passedCount(output);
    if (code !== 0) return { ok: false, measured: `종료코드 ${code}`, limit: "종료코드 0, 통과 ≥ 1", output };
    if (passed === null) return { ok: false, measured: "통과 수를 읽지 못함", limit: "종료코드 0, 통과 ≥ 1", output };
    return { ok: passed >= 1, measured: `통과 ${passed}`, limit: "종료코드 0, 통과 ≥ 1", output };
  },

  "diff-empty"(root, c) {
    const m = /^seal:(.+)$/.exec(c.since);
    if (!m) throw new Error(`diff-empty.since 는 "seal:<단계>" 형식: ${c.since}`);
    const seal = readSeal(root, m[1]);
    if (!seal?.head) return { ok: false, measured: `${m[1]} 봉인 없음`, limit: "변경 0" };
    const r = git(root, ["diff", "--name-only", seal.head, "--", c.path], { allowFail: true });
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "--", c.path], { allowFail: true });
    const changed = [r.out, untracked.out].join("\n").split("\n").filter(Boolean);
    return { ok: changed.length === 0, measured: changed.length, limit: "변경 0" };
  },

  json(root, c) {
    const dir = path.dirname(c.file);
    const re = globToRegExp(path.basename(c.file));
    const absDir = path.join(root, dir);
    const files = fs.existsSync(absDir) ? fs.readdirSync(absDir).filter((f) => re.test(f)) : [];
    if (files.length < (c.minFiles ?? 1)) {
      return { ok: false, measured: `파일 ${files.length}개`, limit: `파일 ≥ ${c.minFiles ?? 1}개` };
    }
    const bad = [];
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(absDir, f), "utf8"));
      const values = getPath(data, c.path);
      const op = c.op ?? "==";
      const okAll = values.length > 0 && values.every((v) => (op === "exists" ? v !== undefined : compare(v, op, c.value)));
      if (!okAll) bad.push(`${f}: ${JSON.stringify(values)}`);
    }
    return { ok: bad.length === 0, measured: bad.length ? bad.join("; ") : `파일 ${files.length}개 일치`, limit: `${c.path} ${c.op ?? "=="} ${JSON.stringify(c.value)}` };
  },
};

function runChecks(root, phase, def) {
  if (!def.checks?.length) fail(`${phase}: 검사 정의가 없다. 빈 단계는 실행·봉인하지 않는다`, 1);
  return def.checks.map((c) => {
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

function printTable(results) {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(10)} ${r.desc}  (${r.measured} / ${r.limit})`);
}

// ---------- 명령 ----------

async function loadGates(root, configPath) {
  const abs = path.resolve(root, configPath ?? "gates/gates.config.mjs");
  if (!fs.existsSync(abs)) fail(`설정 파일 없음: ${abs}`);
  const mod = await import(pathToFileURL(abs).href);
  return mod.GATES;
}

function cmdStatus(root, gates, asJson) {
  const rows = Object.keys(gates).map((phase) => {
    const state = phaseState(root, gates, phase);
    const seal = readSeal(root, phase);
    return { phase, state, mark: STATE[state], needs: gates[phase].needs ?? [], head: seal?.head?.slice(0, 7) ?? null };
  });
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log("| 단계 | 상태 | 게이트 명령 | 봉인 |");
  console.log("|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.phase} | ${r.mark} | \`node scripts/gate.mjs ${r.phase}\` | ${r.head ?? "—"} |`);
}

function changedFiles(root, base) {
  const head = resolveRef(root, "HEAD");
  if (!head) return [];
  let from = base ? resolveRef(root, base) : null;
  if (base && !from) fail(`기준 ref 를 찾을 수 없다: ${base}`);
  if (!from) {
    // 기준이 없으면 루트 커밋의 빈 트리부터 본다 (저장소 전체 이력).
    const all = git(root, ["log", "--name-only", "--pretty=format:", "HEAD"]).out;
    return [...new Set(all.split("\n").filter(Boolean))];
  }
  return git(root, ["diff", "--name-only", `${from}...HEAD`]).out.split("\n").filter(Boolean);
}

function cmdAssertOrder(root, gates, base) {
  const files = changedFiles(root, base);
  const violations = [];
  for (const [phase, def] of Object.entries(gates)) {
    if (phaseState(root, gates, phase) !== "locked") continue;
    const res = (def.outputs ?? []).map(globToRegExp);
    for (const f of files) if (res.some((re) => re.test(f))) violations.push(`${f} → ${phase} (🔒)`);
  }
  if (violations.length) {
    console.error("잠긴 단계의 산출 경로가 바뀌었다:");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(`순서 위반 없음 (변경 파일 ${files.length}개 검사)`);
}

function cmdPhase(root, gates, phase, args) {
  const def = gates[phase];
  if (!def) fail(`알 수 없는 단계: ${phase}`);

  // R1 순서
  const memo = new Map();
  const unsealed = (def.needs ?? []).filter((n) => !["sealed", "waived"].includes(phaseState(root, gates, n, memo)));
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
  const results = runChecks(root, phase, def);
  printTable(results);
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
    console.log(`\n${phase} 봉인: ${path.relative(root, sealPath(root, phase))}`);
  } else {
    console.log(`\n${phase}: ${results.length}/${results.length} 통과`);
  }
}

function writeSeal(root, phase, { waived, reason, checks }) {
  const head = resolveRef(root, "HEAD");
  if (!head) fail("커밋이 없어 봉인할 수 없다");
  const seal = { phase, sealed: true, head, at: new Date().toISOString(), waived, reason, checks };
  fs.mkdirSync(path.join(root, SEAL_DIR), { recursive: true });
  fs.writeFileSync(sealPath(root, phase), `${JSON.stringify(seal, null, 2)}\n`);
}

// ---------- 진입 ----------

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root ?? (git(process.cwd(), ["rev-parse", "--show-toplevel"], { allowFail: true }).out || process.cwd()));
const gates = await loadGates(root, args.config);

if (args.status) cmdStatus(root, gates, args.json === true);
else if (args["assert-order"]) cmdAssertOrder(root, gates, args.base);
else if (args._[0]) cmdPhase(root, gates, args._[0], args);
else fail("사용법: gate <단계> [--seal|--explain|--waived <사유>] | --status [--json] | --assert-order [--base <ref>]");
