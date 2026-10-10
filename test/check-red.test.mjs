// check-red.mjs 음성 대조 (2단계 실행판 K0.T14, G-K0.34).
// 테스트마다 임시 git 저장소를 만들고, 봉인 A 뒤에 Red 커밋·고침 커밋을 쌓아 scripts/check-red.mjs 를 --root 로 돌린다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/check-red.mjs");

function sh(dir, cmd) {
  const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

function commit(dir, msg) {
  const file = path.join(dir, ".git", "MSG");
  fs.writeFileSync(file, msg);
  sh(dir, `git add -A && git commit -q --allow-empty -F "${file}"`);
}

// 검사 G1 은 TC-X0.T1.a 하나: impl.mjs 의 add(1, 2) 가 3 이어야 한다
const GATES = {
  A: { needs: [], checks: [{ id: "GA", how: "cmd", cmd: "true" }] },
  P: { needs: ["A"], checks: [{ id: "G1", how: "test", desc: "TC-X0.T1.a 더하기", cmd: "node --test --test-reporter=tap t.test.mjs", expectPassed: 1 }] },
};
const TEST_FILE = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "./impl.mjs";\ntest("TC-X0.T1.a 더하기", () => assert.equal(add(1, 2), 3));\n';
const BROKEN = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";

/** 봉인 A 까지 만든 저장소. impl 은 처음 상태 */
function repo(impl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-red-test-"));
  sh(dir, "git init -q -b main && git config user.email t@t.test && git config user.name t && git config commit.gpgsign false");
  write(dir, "gates/gates.config.mjs", `export const GATES = ${JSON.stringify(GATES, null, 2)};\n`);
  write(dir, "impl.mjs", impl);
  commit(dir, "init");
  const head = sh(dir, "git rev-parse HEAD");
  write(dir, "gates/seals/A.json", JSON.stringify({ phase: "A", sealed: true, head, waived: false, reason: null, checks: [{ id: "GA", ok: true }] }));
  commit(dir, "seal A");
  return dir;
}

function checkRed(dir) {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--check", "G1", "--since", "seal:A"], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("TC-K0.T14.a Red 커밋이 없으면 실패한다", () => {
  const dir = repo(BROKEN);
  write(dir, "t.test.mjs", TEST_FILE);
  commit(dir, "test: 더하기 재현 (꼬리줄 없음)");
  write(dir, "impl.mjs", FIXED);
  commit(dir, "fix: 더하기");
  const r = checkRed(dir);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /"Red: TC-X0\.T1\.a" 커밋 없음/);
});

test("TC-K0.T14.b Red 커밋에서 초록이면 실패한다", () => {
  // 재현 테스트가 고장과 무관해 고치기 전에도 통과한다
  const dir = repo(FIXED);
  write(dir, "t.test.mjs", TEST_FILE);
  commit(dir, "test: 더하기 재현\n\nRed: TC-X0.T1.a\n");
  const r = checkRed(dir);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /Red 커밋에서 통과/);
});

test("TC-K0.T14.c Red 커밋에서 빨강이면 통과한다", () => {
  const dir = repo(BROKEN);
  write(dir, "t.test.mjs", TEST_FILE);
  commit(dir, "test: 더하기 재현\n\nRed: TC-X0.T1.a\n");
  write(dir, "impl.mjs", FIXED);
  commit(dir, "fix: 더하기");
  // HEAD 에서는 통과한다 (대조). 부모 node --test 의 NODE_TEST_CONTEXT 를 물려받으면 자식이 TAP 를 내지 않는다
  assert.match(sh(dir, "env -u NODE_TEST_CONTEXT node --test --test-reporter=tap t.test.mjs"), /^ok 1 - TC-X0\.T1\.a/m);
  const r = checkRed(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /빨강\s+[0-9a-f]{7} TC-X0\.T1\.a/);
});
