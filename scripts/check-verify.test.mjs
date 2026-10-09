// check-verify.mjs 음성 대조. 실행판 GATE S1 의 G-S1.14 ~ G-S1.16 이 실제로 실패할 수 있는지 본다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-verify.mjs");
const ITEMS = ["V10", "V11", "V16", "V17", "V21", "V26", "V27"];

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-test-"));
  fs.mkdirSync(path.join(dir, "verify"));
  fs.writeFileSync(path.join(dir, "plan.md"), "# 계획\n\n상태: 초안 v5.2 (테스트)\n");
  for (const item of ITEMS) {
    const data = { item, question: "질문", answer: {}, evidence: ["관찰"], blocking: false, was_blocking: false, resolved_in: null, ...overrides[item] };
    if (overrides[item] !== null) fs.writeFileSync(path.join(dir, "verify", `${item}.json`), JSON.stringify(data));
  }
  return dir;
}

function check(dir, mode) {
  return spawnSync(process.execPath, [SCRIPT, mode, "--dir", path.join(dir, "verify"), "--plan", path.join(dir, "plan.md")], { encoding: "utf8" });
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
