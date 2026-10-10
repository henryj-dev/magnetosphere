// 확인 결과 파일(docs/verify/V*.json) 검사. 실행판 0절 「확인 결과 파일」.
// 1단계 GATE S1 의 G-S1.14 ~ G-S1.16, 2단계 GATE K0 의 G-K0.13 ~ G-K0.15.
//
//   node scripts/check-verify.mjs present  [--set <묶음>] [--dir <dir>]   필요한 항목 파일이 모두 있고 모양이 맞다
//   node scripts/check-verify.mjs unblocked [--set <묶음>] [--dir <dir>]  blocking 이 모두 false
//   node scripts/check-verify.mjs resolved  [--set <묶음>] [--dir <dir>] [--plan <file>]
//                                            was_blocking 이 true 인 항목은 resolved_in 이 계획서 현재 버전과 같다
//
// --set 은 항목 묶음이다. phase1(기본값, S1 봉인 커밋 재검이 인자 없이 부른다) · phase2(K0, V28 은 K3 리뷰에서 더함).

import fs from "node:fs";
import path from "node:path";

const SETS = {
  phase1: ["V10", "V11", "V16", "V17", "V21", "V26", "V27"],
  phase2: ["V12", "V13", "V15", "V18", "V19", "V20", "V28"],
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const mode = process.argv[2];
const setName = arg("set", "phase1");
const ITEMS = SETS[setName];
if (!ITEMS) {
  console.error(`알 수 없는 묶음: ${setName} (${Object.keys(SETS).join(" | ")})`);
  process.exit(2);
}
const dir = arg("dir", "docs/verify");
const plan = arg("plan", "docs/design/omniroute-member-layer.md");

function load(item) {
  const p = path.join(dir, `${item}.json`);
  if (!fs.existsSync(p)) return { item, error: "파일 없음" };
  try {
    return { item, data: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (e) {
    return { item, error: `JSON 아님: ${e.message}` };
  }
}

function shapeProblem({ item, data }) {
  if (data.item !== item) return `item 이 ${JSON.stringify(data.item)}`;
  if (typeof data.question !== "string" || !data.question.trim()) return "question 없음";
  if (data.answer === null || typeof data.answer !== "object") return "answer 가 객체 아님";
  if (!Array.isArray(data.evidence) || data.evidence.length === 0) return "evidence 비어 있음";
  for (const k of ["blocking", "was_blocking"]) if (typeof data[k] !== "boolean") return `${k} 가 true/false 아님`;
  if (data.blocking && !data.was_blocking) return "blocking 인데 was_blocking 이 false";
  return null;
}

function planVersion() {
  const src = fs.readFileSync(plan, "utf8");
  const m = src.match(/^상태: 초안 (v[0-9.]+)/m);
  if (!m) throw new Error(`계획서 상태 줄에서 버전을 찾지 못함: ${plan}`);
  return m[1];
}

const results = ITEMS.map(load);
const problems = [];

if (mode === "present") {
  for (const r of results) {
    if (r.error) problems.push(`${r.item}: ${r.error}`);
    else {
      const bad = shapeProblem(r);
      if (bad) problems.push(`${r.item}: ${bad}`);
    }
  }
} else if (mode === "unblocked") {
  for (const r of results) {
    if (r.error) problems.push(`${r.item}: ${r.error}`);
    else if (r.data.blocking !== false) problems.push(`${r.item}: blocking=${JSON.stringify(r.data.blocking)}`);
  }
} else if (mode === "resolved") {
  const version = planVersion();
  for (const r of results) {
    if (r.error) problems.push(`${r.item}: ${r.error}`);
    else if (r.data.was_blocking && r.data.resolved_in !== version) {
      problems.push(`${r.item}: 설계를 막았던 항목인데 resolved_in=${JSON.stringify(r.data.resolved_in)} (계획서 ${version})`);
    }
  }
} else {
  console.error("사용법: check-verify.mjs present|unblocked|resolved [--set phase1|phase2] [--dir <dir>] [--plan <file>]");
  process.exit(2);
}

if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`${mode} (${setName}): ${ITEMS.length}개 항목 통과`);
