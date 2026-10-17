// check-required-checks.mjs 의 집계 잡 예외 음성 대조 (TC-CI.2).
// if: always() 이고 needs 의 모든 잡 결과를 test "${{ needs.<id>.result }}" = success 로만 확인하는 집계 잡이 있으면,
// 그 needs 의 매트릭스 잡 펼친 이름은 요구하지 않는다. 조건이 하나라도 어긋나면 예외 없이 펼친 이름을 요구한다.
// 임시 git 저장소와 픽스처 워크플로를 쓴다. 기존 test/check-required-checks.test.mjs (G-K0.30, expectPassed 2) 는 건드리지 않는다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// test/ 에 둔다. yaml 패키지를 쓰는 스크립트를 띄우므로, 설치 없이 도는 gate.yml 의 scripts/*.test.mjs 에 두지 않는다.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts/check-required-checks.mjs");

const WORKFLOW = `name: ci
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  parts:
    name: 단계 조각 \${{ matrix.shard }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: ["1/2", "2/2"]
    steps:
      - run: node scripts/gate.mjs K2 --explain --shard \${{ matrix.shard }}
  whole:
    name: 단계
    needs: parts
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: test "\${{ needs.parts.result }}" = success
`;

function rules(contexts) {
  return JSON.stringify([
    { type: "required_status_checks", parameters: { required_status_checks: contexts.map((context) => ({ context })) } },
    { type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } },
  ]);
}

function run(contexts, workflow = WORKFLOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "required-agg-"));
  fs.mkdirSync(path.join(dir, "workflows"));
  fs.writeFileSync(path.join(dir, "workflows/ci.yml"), workflow);
  fs.writeFileSync(path.join(dir, "rules.json"), rules(contexts));
  const r = spawnSync(process.execPath, [SCRIPT, "--rules", path.join(dir, "rules.json"), "--workflows", path.join(dir, "workflows")], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** 예외가 풀리면 조각 이름이 그대로 요구된다 */
function expectShards(workflow) {
  const r = run(["단계"], workflow);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /\[missing\] 필수 검사에 없는 잡: "단계 조각 1\/2"/);
  assert.match(r.out, /\[missing\] 필수 검사에 없는 잡: "단계 조각 2\/2"/);
}

test("TC-CI.2.g 집계 잡이 덮는 매트릭스 잡은 필수 검사 이름에서 뺀다", () => {
  const covered = run(["단계"]);
  assert.equal(covered.code, 0, covered.out);
  assert.match(covered.out, /잡 1개 모두 필수 검사/);

  // 집계 스텝이 needs 결과를 확인하지 않으면 예외가 풀려 조각 이름이 그대로 요구된다
  expectShards(WORKFLOW.replace('test "${{ needs.parts.result }}" = success', 'test "ok" = success'));
});

test("TC-CI.2.h 집계 조건이 느슨하면 예외를 적용하지 않는다", () => {
  const drop = (line) => {
    const w = WORKFLOW.replace(`    ${line}\n`, "");
    assert.notEqual(w, WORKFLOW);
    return w;
  };
  expectShards(drop("if: always()")); // if 없음
  expectShards(WORKFLOW.replace("if: always()", "if: success()")); // 다른 조건: 앞 잡이 실패하면 집계가 건너뛰어진다
  // 집계 잡(whole)의 실패를 삼킨다. 앵커에 if: always() 를 넣어 parts 잡이 아니라 whole 잡에 붙인다
  const swallow = WORKFLOW.replace("    if: always()\n    runs-on: ubuntu-latest\n", "    if: always()\n    continue-on-error: true\n    runs-on: ubuntu-latest\n");
  assert.notEqual(swallow, WORKFLOW);
  expectShards(swallow);
  // needs 에 있는 잡을 스텝이 덮지 않는다
  expectShards(WORKFLOW.replace("    needs: parts\n", "    needs: [parts, other]\n"));
});
