#!/usr/bin/env node
// 봉인 단계 검사 불변 검사기 (4단계 실행판 A1.T5, G-A1.18·19).
//
//   node scripts/check-sealed-checks.mjs --base origin/main          지금 gates/gates.config.mjs 와 기준 ref 의 설정을 비교한다
//   node scripts/check-sealed-checks.mjs --base-config <파일> --current <파일> --sealed S0,M6   (시험용: 파일 둘과 봉인 단계 목록)
//
// 기준 ref 에서 봉인(gates/seals/<단계>.json 있음)인 단계마다 검사 ID 목록(순서 포함)과 각 검사의 판정 필드가 같은지 본다.
// 판정 필드는 desc·requires 를 뺀 모든 필드다 (how·cmd·pattern·in·exclude·op·limit·expectPassed·expectExit·file·path·value·minFiles·since …).
// desc·requires 는 보지 않는다 — 봉인 뒤 설명을 고치거나 local-services 태그를 다는 선례가 있다.
// 봉인되지 않은 단계(열린·잠긴 단계)는 보지 않는다. 다르면 "단계 검사ID 필드" 를 한 줄씩 내고 종료코드 1.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IGNORED = new Set(["desc", "requires"]);

/** 키 순서와 무관하게 같은 값이면 같은 문자열 */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * 봉인 단계의 검사가 기준과 같은지. 다른 곳마다 { stage, id, field } (field: "ids" 는 검사 목록·순서, "stage" 는 단계가 없어짐)
 * @param {Record<string, any>} base 기준 GATES
 * @param {Record<string, any>} current 지금 GATES
 * @param {string[]} sealed 기준에서 봉인된 단계
 */
export function compareSealed(base, current, sealed) {
  const problems = [];
  for (const stage of sealed) {
    const b = base[stage];
    const c = current[stage];
    if (!b) continue;
    if (!c) {
      problems.push({ stage, id: "-", field: "stage" });
      continue;
    }
    const bIds = (b.checks ?? []).map((x) => x.id);
    const cIds = (c.checks ?? []).map((x) => x.id);
    if (stable(bIds) !== stable(cIds)) problems.push({ stage, id: "-", field: "ids" });
    const byId = new Map((c.checks ?? []).map((x) => [x.id, x]));
    for (const check of b.checks ?? []) {
      const now = byId.get(check.id);
      if (!now) continue;
      const fields = new Set([...Object.keys(check), ...Object.keys(now)].filter((k) => !IGNORED.has(k)));
      for (const f of [...fields].sort()) if (stable(check[f]) !== stable(now[f])) problems.push({ stage, id: check.id, field: f });
    }
  }
  return problems;
}

async function loadGates(file) {
  return (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).GATES;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const baseRef = arg("--base");
  let base, sealed;
  const current = await loadGates(path.resolve(arg("--current") ?? path.join(ROOT, "gates/gates.config.mjs")));
  if (baseRef) {
    const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-checks-"));
    try {
      const file = path.join(dir, "gates.config.mjs");
      fs.writeFileSync(file, git("show", `${baseRef}:gates/gates.config.mjs`));
      base = await loadGates(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    sealed = git("ls-tree", "--name-only", baseRef, "gates/seals/").split("\n").filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json"));
  } else {
    const baseConfig = arg("--base-config");
    const list = arg("--sealed");
    if (!baseConfig || !list) {
      console.error("사용법: check-sealed-checks.mjs --base <ref> | --base-config <파일> --current <파일> --sealed <단계,…>");
      process.exit(2);
    }
    base = await loadGates(path.resolve(baseConfig));
    sealed = list.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const problems = compareSealed(base, current, sealed);
  for (const p of problems) console.error(`[sealed-check-changed] ${p.stage} ${p.id} ${p.field}`);
  if (problems.length) process.exit(1);
  console.log(`[sealed-checks] 봉인 단계 ${sealed.length}개의 검사 정의가 기준과 같다`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
