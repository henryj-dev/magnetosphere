// check-ci-matrix.mjs 의 --shard 조각 규칙 음성 대조 (TC-CI.2).
// 임시 git 저장소는 쓰지 않는다. 픽스처(test/fixtures/ci-guard/stage-partition-*.yml)를 --expect-fail 로 돌린다.
// 기존 test/check-ci-matrix.test.mjs (G-K0.10, expectPassed 2) 는 건드리지 않는다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// test/ 에 둔다. yaml 패키지를 쓰는 스크립트를 띄우므로, 설치 없이 도는 gate.yml 의 scripts/*.test.mjs 에 두지 않는다.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/check-ci-matrix.mjs");

function run(fixture) {
  const r = spawnSync(process.execPath, [SCRIPT, "--fixture", fixture, "--expect", "6", "--expect-fail"], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("TC-CI.2.e 조각이 빠진 --shard 는 [stage-partition] 으로 잡힌다", () => {
  const r = run("test/fixtures/ci-guard/stage-partition-missing.yml");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[stage-partition\]/);
});

test("TC-CI.2.f 분모가 다른 --shard 는 [stage-partition] 으로 잡힌다", () => {
  const r = run("test/fixtures/ci-guard/stage-partition-denom.yml");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[stage-partition\]/);
});

test("TC-CI.2.i matrix.include 로 조각을 바꾸면 [stage-partition] 으로 잡힌다", () => {
  const r = run("test/fixtures/ci-guard/stage-partition-include.yml");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[stage-partition\].*include/);
});

test("TC-CI.2.j i/n 이 아닌 --shard 값은 [stage-partition] 으로 잡힌다", () => {
  const r = run("test/fixtures/ci-guard/stage-partition-format.yml");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[stage-partition\].*i\/n/);
});

test("TC-CI.2.k 분할 단계의 분할 없는 줄은 [stage-partition] 으로 잡힌다", () => {
  const r = run("test/fixtures/ci-guard/stage-partition-plain.yml");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[stage-partition\].*분할 없는 줄/);
});
