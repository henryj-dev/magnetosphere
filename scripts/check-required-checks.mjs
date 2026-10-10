#!/usr/bin/env node
// 필수 검사·병합 방식 대조 (2단계 실행판 0절 「CI 단계 잡 규칙」, K0.T13).
//
//   node scripts/check-required-checks.mjs --repo <owner/name>          main 에 걸린 규칙을 gh api 로 읽는다
//   node scripts/check-required-checks.mjs --rules <json> [--workflows <폴더>]   규칙 파일로 본다 (음성 대조)
//
// 본다:
//   [missing]  main 규칙의 required_status_checks 문맥 ⊇ 워크플로(.github/workflows/*.yml) 잡 표시 이름.
//              표시 이름은 잡의 name (없으면 잡 id), name 의 ${{ matrix.<키> }} 는 그 matrix 값마다 펼친다.
//              CI 에 넣은 잡이 필수 검사가 아니면 그 잡이 빨개도 PR 이 병합된다.
//   [merge]    pull_request 규칙의 allowed_merge_methods == ["merge"]. 스쿼시·리베이스는 SHA 를 바꿔
//              봉인 head 가 main 의 조상이 아니게 된다 (R2).
//
// 규칙은 GET repos/<repo>/rules/branches/main (그 브랜치에 실제로 걸리는 규칙, 저장소·조직 ruleset 을 합친 것).
// 공개 저장소라 이 경로는 읽기 권한 토큰(CI 의 github.token, permissions: contents: read)으로 읽힌다.
// 못 읽으면(gh 없음, 인증·권한 오류) 통과로 치지 않고 종료코드 1 이다.
//
// 종료코드: 0 문제 없음 · 1 문제 있음 또는 규칙을 못 읽음 · 2 인자 오류

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`check-required-checks: --${name} 에 값이 필요하다`);
    process.exit(2);
  }
  return v;
}

const repo = arg("repo");
const rulesFile = arg("rules");
const workflowsDir = path.resolve(ROOT, arg("workflows") ?? ".github/workflows");
if (!repo === !rulesFile) {
  console.error("사용법: check-required-checks.mjs --repo <owner/name> | --rules <json> [--workflows <폴더>]");
  process.exit(2);
}

/** 워크플로 잡 표시 이름 전부. name 의 ${{ matrix.<키> }} 는 matrix 목록 값마다 펼친다 */
function jobNames(dir) {
  const names = [];
  for (const f of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const doc = parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const [id, def] of Object.entries(doc?.jobs ?? {})) {
      const name = typeof def?.name === "string" ? def.name : id;
      const keys = [...name.matchAll(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g)].map((m) => m[1]);
      let expanded = [name];
      for (const k of new Set(keys)) {
        const values = def?.strategy?.matrix?.[k];
        if (!Array.isArray(values)) throw new Error(`${f} ${id}: name 의 matrix.${k} 를 펼칠 목록이 없다`);
        const re = new RegExp(`\\$\\{\\{\\s*matrix\\.${k}\\s*\\}\\}`, "g");
        expanded = expanded.flatMap((n) => values.map((v) => n.replace(re, String(v))));
      }
      names.push(...expanded.map((n) => ({ name: n, where: `${f} ${id}` })));
    }
  }
  return names;
}

function loadRules() {
  if (rulesFile) return JSON.parse(fs.readFileSync(path.resolve(ROOT, rulesFile), "utf8"));
  const r = spawnSync("gh", ["api", `repos/${repo}/rules/branches/main`], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    console.error(`check-required-checks: ${repo} main 규칙을 읽지 못했다 — 통과로 치지 않는다`);
    console.error((r.stderr || r.error?.message || "").trim());
    process.exit(1);
  }
  return JSON.parse(r.stdout);
}

const problems = [];
let rules;
let jobs;
try {
  rules = loadRules();
  if (!Array.isArray(rules)) throw new Error("규칙 응답이 배열이 아니다");
  jobs = jobNames(workflowsDir);
} catch (e) {
  console.error(`check-required-checks: ${e.message}`);
  process.exit(1);
}

const required = new Set(
  rules
    .filter((r) => r?.type === "required_status_checks")
    .flatMap((r) => r.parameters?.required_status_checks ?? [])
    .map((c) => c.context),
);
for (const j of jobs) if (!required.has(j.name)) problems.push(`[missing] 필수 검사에 없는 잡: "${j.name}" (${j.where})`);

const pr = rules.filter((r) => r?.type === "pull_request");
if (!pr.length) problems.push("[merge] pull_request 규칙이 없다 (PR 없이 main 에 들어갈 수 있다)");
for (const r of pr) {
  const methods = r.parameters?.allowed_merge_methods;
  if (JSON.stringify(methods) !== JSON.stringify(["merge"])) problems.push(`[merge] allowed_merge_methods 가 ${JSON.stringify(methods)} (기대 ["merge"])`);
}

for (const p of problems) console.log(p);
if (problems.length) {
  console.error(`check-required-checks: 문제 ${problems.length}개`);
  process.exit(1);
}
console.log(`check-required-checks: 잡 ${jobs.length}개 모두 필수 검사, 병합은 머지 커밋만 (${repo ?? rulesFile})`);
