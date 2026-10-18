// check-ci-matrix.mjs 의 [trigger] 규칙 양성·음성 대조 (TC-CI.3).
// 허용하는 모양은 둘뿐이다: (a) push·pull_request 둘 다 거르개 없음, (b) push 가 정확히 branches: [main] 하나이고 pull_request 는 거르개 없음.
// 저장소 ci.yml 을 임시 폴더에 복사해 on: 블록만 바꾼다. 다른 규칙은 그대로 통과하므로 결과 차이는 trigger 규칙에서만 온다.
// 임시 git 저장소는 쓰지 않는다. 기존 test/check-ci-matrix.test.mjs (G-K0.10, expectPassed 2) 는 건드리지 않는다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// test/ 에 둔다. yaml 패키지를 쓰는 스크립트를 띄우므로, 설치 없이 도는 gate.yml 의 scripts/*.test.mjs 에 두지 않는다.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/check-ci-matrix.mjs");
const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
const ON_RE = /^on:\n(?:[ \t]+.*\n)+/m;

/** ci.yml 의 on: 블록을 onBlock 으로 바꾼 사본으로 검사한다 */
function run(onBlock) {
  assert.match(CI, ON_RE, "ci.yml 에서 on: 블록을 찾지 못했다");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-matrix-trigger-"));
  const file = path.join(dir, "ci.yml");
  fs.writeFileSync(file, CI.replace(ON_RE, onBlock));
  const r = spawnSync(process.execPath, [SCRIPT, "--file", file, "--expect", "6"], { cwd: ROOT, encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** 실패하고, 잡힌 문제가 모두 [trigger] 다 */
function assertTriggerOnly(r) {
  assert.equal(r.code, 1, r.out);
  const codes = [...r.out.matchAll(/^\[([a-z0-9-]+)\]/gm)].map((m) => m[1]);
  assert.ok(codes.length > 0, r.out);
  assert.deepEqual([...new Set(codes)], ["trigger"], r.out);
}

test("TC-CI.3.a 거르개 없는 push·pull_request 는 통과한다 (모양 a)", () => {
  const r = run("on:\n  push:\n  pull_request:\n");
  assert.equal(r.code, 0, r.out);
});

test("TC-CI.3.b push 가 정확히 branches: [main] 하나이고 pull_request 거르개가 없으면 통과한다 (모양 b)", () => {
  const r = run("on:\n  push:\n    branches: [main]\n  pull_request:\n");
  assert.equal(r.code, 0, r.out);
});

test("TC-CI.3.c push.branches 가 main 이 아닌 값·여러 값·글롭이면 [trigger] 로 실패한다", () => {
  for (const b of ["[develop]", '[main, "release/**"]', '["**"]', '["ma*"]', "[main, main]", "[]", "main"]) {
    assertTriggerOnly(run(`on:\n  push:\n    branches: ${b}\n  pull_request:\n`));
  }
});

test("TC-CI.3.d push 에 branches: [main] 말고 다른 거르개가 있거나 다른 거르개만 있으면 [trigger] 로 실패한다", () => {
  for (const extra of ['paths: ["src/**"]', 'paths-ignore: ["docs/**"]', 'tags: ["v*"]', 'tags-ignore: ["v*"]', 'branches-ignore: ["wip/**"]']) {
    assertTriggerOnly(run(`on:\n  push:\n    branches: [main]\n    ${extra}\n  pull_request:\n`));
    assertTriggerOnly(run(`on:\n  push:\n    ${extra}\n  pull_request:\n`));
  }
});

test("TC-CI.3.e pull_request 에 어떤 거르개든 있으면 [trigger] 로 실패한다", () => {
  for (const k of ["branches", "branches-ignore", "paths", "paths-ignore", "tags", "tags-ignore"]) {
    assertTriggerOnly(run(`on:\n  push:\n    branches: [main]\n  pull_request:\n    ${k}: [main]\n`));
    assertTriggerOnly(run(`on:\n  push:\n  pull_request:\n    ${k}: [main]\n`));
  }
});

test("TC-CI.3.f push 나 pull_request 가 없으면 [trigger] 로 실패한다", () => {
  assertTriggerOnly(run("on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"));
  assertTriggerOnly(run("on:\n  pull_request:\n  workflow_dispatch:\n"));
});
