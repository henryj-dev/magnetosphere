// check-required-checks.mjs 음성 대조 (2단계 실행판 K0.T13, G-K0.30).
// 규칙은 --rules 픽스처(test/fixtures/required-checks/*.json), 워크플로는 픽스처 폴더(workflows/)를 쓴다.
// 스크립트가 yaml 패키지를 쓰므로 scripts/*.test.mjs 가 아니라 test/ 에 둔다 (gate.yml 은 설치 없이 돈다).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/check-required-checks.mjs");
const FIX = "test/fixtures/required-checks";

function run(rules, workflows = `${FIX}/workflows`) {
  const args = [SCRIPT, "--rules", `${FIX}/${rules}.json`, ...(workflows ? ["--workflows", workflows] : [])];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("TC-K0.T13.a 필수 검사에 빠진 잡 이름을 잡는다", () => {
  const r = run("missing-guard");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /\[missing\] 필수 검사에 없는 잡: "재발 방지 \(S7 게이트\)"/);
  assert.doesNotMatch(r.out, /\[merge\]/, "병합 방식은 맞는 픽스처다");
  // 실제 .github/workflows 로 봐도 같은 잡이 빠진 것으로 잡힌다 (ci.yml 의 guard 잡)
  const real = run("missing-guard", null);
  assert.notEqual(real.code, 0, real.out);
  assert.match(real.out, /\[missing\] 필수 검사에 없는 잡: "재발 방지 \(S7 게이트\)" \(ci\.yml guard\)/);
});

test("TC-K0.T13.b 스쿼시·리베이스 허용을 잡는다", () => {
  const squash = run("squash");
  assert.notEqual(squash.code, 0, squash.out);
  assert.match(squash.out, /\[merge\] allowed_merge_methods 가 \["merge","squash"\]/);
  // 대조: 필수 검사가 다 있고(matrix 펼침·name 없는 잡 포함) 머지 커밋만이면 통과
  const ok = run("ok");
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /잡 5개 모두 필수 검사/);
});
