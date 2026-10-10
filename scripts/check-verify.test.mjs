// check-verify.mjs 음성 대조. 실행판 GATE S1 의 G-S1.14 ~ G-S1.16, 2단계 GATE K0 의 G-K0.13 ~ G-K0.15 가
// 실제로 실패할 수 있는지 본다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-verify.mjs");
const ITEMS = ["V10", "V11", "V16", "V17", "V21", "V26", "V27"];
const PHASE2 = ["V12", "V13", "V15", "V18", "V19", "V20"];

function fixture(overrides = {}, { items = ITEMS, version = "v5.2" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-test-"));
  fs.mkdirSync(path.join(dir, "verify"));
  fs.writeFileSync(path.join(dir, "plan.md"), `# 계획\n\n상태: 초안 ${version} (테스트)\n`);
  for (const item of items) {
    const data = { item, question: "질문", answer: {}, evidence: ["관찰"], blocking: false, was_blocking: false, resolved_in: null, ...overrides[item] };
    if (overrides[item] !== null) fs.writeFileSync(path.join(dir, "verify", `${item}.json`), JSON.stringify(data));
  }
  return dir;
}

function check(dir, mode, ...extra) {
  return spawnSync(process.execPath, [SCRIPT, mode, ...extra, "--dir", path.join(dir, "verify"), "--plan", path.join(dir, "plan.md")], { encoding: "utf8" });
}

test("TC-S1.G.a 정상 파일 일곱 개는 세 모드 모두 통과한다", () => {
  const dir = fixture();
  for (const mode of ["present", "unblocked", "resolved"]) assert.equal(check(dir, mode).status, 0, mode);
});

test("TC-S1.G.b present 는 빠진 항목과 모양 오류를 잡는다", () => {
  assert.notEqual(check(fixture({ V21: null }), "present").status, 0, "파일 없음");
  assert.notEqual(check(fixture({ V10: { evidence: [] } }), "present").status, 0, "근거 없음");
  assert.notEqual(check(fixture({ V11: { item: "V10" } }), "present").status, 0, "item 불일치");
  assert.notEqual(check(fixture({ V16: { blocking: true, was_blocking: false } }), "present").status, 0, "was_blocking 누락");
});

test("TC-S1.G.c unblocked 는 설계를 막는 결과가 남아 있으면 실패한다", () => {
  assert.notEqual(check(fixture({ V26: { blocking: true, was_blocking: true } }), "unblocked").status, 0);
});

test("TC-S1.G.d resolved 는 막았던 항목이 현재 계획서 버전을 가리켜야 통과한다", () => {
  assert.notEqual(check(fixture({ V10: { was_blocking: true, resolved_in: null } }), "resolved").status, 0, "resolved_in 없음");
  assert.notEqual(check(fixture({ V10: { was_blocking: true, resolved_in: "v5.1" } }), "resolved").status, 0, "옛 버전");
  assert.equal(check(fixture({ V10: { was_blocking: true, resolved_in: "v5.2" } }), "resolved").status, 0, "현재 버전");
});

// ---------- 2단계 실행판 K0.T4: --set phase2 ----------

const phase2 = (overrides = {}) => fixture(overrides, { items: PHASE2, version: "v5.6" });
const set2 = ["--set", "phase2"];

test("TC-K0.T4.a phase2 정상 파일 여섯은 세 모드 모두 통과한다", () => {
  const dir = phase2();
  for (const mode of ["present", "unblocked", "resolved"]) {
    const r = check(dir, mode, ...set2);
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    assert.match(r.stdout, /6개 항목 통과/, "묶음이 빈 목록이면 0개 항목으로 늘 초록이다");
  }
});

test("TC-K0.T4.b present 는 빠진 항목과 모양 오류를 잡는다", () => {
  assert.notEqual(check(phase2({ V19: null }), "present", ...set2).status, 0, "V19 없음");
  assert.notEqual(check(phase2({ V12: { evidence: [] } }), "present", ...set2).status, 0, "근거 없음");
  assert.notEqual(check(phase2({ V13: { item: "V12" } }), "present", ...set2).status, 0, "item 불일치");
  assert.notEqual(check(phase2({ V15: { blocking: true, was_blocking: false } }), "present", ...set2).status, 0, "was_blocking 누락");
});

test("TC-K0.T4.c unblocked 는 설계를 막는 결과가 남아 있으면 실패한다", () => {
  assert.notEqual(check(phase2({ V12: { blocking: true, was_blocking: true } }), "unblocked", ...set2).status, 0);
});

test("TC-K0.T4.d resolved 는 막았던 항목이 현재 계획서 버전을 가리켜야 통과한다", () => {
  assert.notEqual(check(phase2({ V20: { was_blocking: true, resolved_in: null } }), "resolved", ...set2).status, 0, "resolved_in 없음");
  assert.notEqual(check(phase2({ V20: { was_blocking: true, resolved_in: "v5.5" } }), "resolved", ...set2).status, 0, "옛 버전");
  assert.equal(check(phase2({ V20: { was_blocking: true, resolved_in: "v5.6" } }), "resolved", ...set2).status, 0, "현재 버전");
});

test("TC-K0.T4.e --set 없이 부르면 1단계 일곱 항목을 본다", () => {
  const dir = fixture();
  const plain = check(dir, "present");
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /7개 항목 통과/);
  assert.notEqual(check(dir, "present", ...set2).status, 0, "1단계 파일만 있는 폴더는 phase2 로 실패해야 한다");
});
