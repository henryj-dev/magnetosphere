// check-red.mjs 작업 트리 재사용 (CHECK_RED_CACHE_DIR, CI 정리 트랙 0).
// test/check-red.test.mjs 와 같은 방식으로 임시 git 저장소에 봉인 A·Red 커밋·고침 커밋을 쌓고 scripts/check-red.mjs 를 --root 로 돌린다.
// 잠금 파일(pnpm-lock.yaml)을 두고, PATH 앞에 가짜 pnpm 을 놓아 설치 횟수를 센다 (실제 설치·네트워크 없이).
// scripts/*.test.mjs 라 CI 스크립트 시험 단계(G-S0.15·G-K0.33·G-M0.14, 개수 단언 없음)가 함께 돈다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "check-red.mjs");

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

const GATES = {
  A: { needs: [], checks: [{ id: "GA", how: "cmd", cmd: "true" }] },
  P: { needs: ["A"], checks: [{ id: "G1", how: "test", desc: "TC-X0.T1.a 더하기", cmd: "node --test --test-reporter=tap t.test.mjs", expectPassed: 1 }] },
};
const TEST_FILE = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "./impl.mjs";\ntest("TC-X0.T1.a 더하기", () => assert.equal(add(1, 2), 3));\n';
const BROKEN = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";

// 가짜 pnpm: 부른 자리와 인자를 기록하고, 설치처럼 최상위와 하위 패키지에 node_modules 를 만든다
const FAKE_PNPM = '#!/bin/sh\necho "$PWD $*" >> "$FAKE_PNPM_LOG"\nmkdir -p node_modules pkg/node_modules\necho ok > node_modules/.fake\necho ok > pkg/node_modules/.fake\n';

/** 봉인 A 뒤 Red 커밋(고장 그대로)·고침 커밋까지 쌓은 저장소와 Red 커밋 SHA, 가짜 pnpm 환경 */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-red-cache-test-"));
  sh(dir, "git init -q -b main && git config user.email t@t.test && git config user.name t && git config commit.gpgsign false");
  write(dir, "gates/gates.config.mjs", `export const GATES = ${JSON.stringify(GATES, null, 2)};\n`);
  write(dir, ".gitignore", "node_modules/\n*.sqlite\n");
  write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(dir, "pkg/package.json", '{ "name": "pkg", "private": true }\n');
  write(dir, "impl.mjs", BROKEN);
  commit(dir, "init");
  const head = sh(dir, "git rev-parse HEAD");
  write(dir, "gates/seals/A.json", JSON.stringify({ phase: "A", sealed: true, head, waived: false, reason: null, checks: [{ id: "GA", ok: true }] }));
  commit(dir, "seal A");
  write(dir, "t.test.mjs", TEST_FILE);
  commit(dir, "test: 더하기 재현\n\nRed: TC-X0.T1.a\n");
  const red = sh(dir, "git rev-parse HEAD");
  write(dir, "impl.mjs", FIXED);
  commit(dir, "fix: 더하기");

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "check-red-cache-bin-"));
  fs.writeFileSync(path.join(bin, "pnpm"), FAKE_PNPM, { mode: 0o755 });
  const log = path.join(bin, "pnpm.log");
  const { CHECK_RED_CACHE_DIR, ...base } = process.env;
  const env = { ...base, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_PNPM_LOG: log };
  const installs = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { dir, red, env, installs };
}

function checkRed(dir, env) {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--check", "G1", "--since", "seal:A"], { encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("TC-CI.1.a 같은 Red 커밋을 두 번째로 꺼내면 설치를 건너뛴다", () => {
  const { dir, env, installs } = setup();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "check-red-cache-"));
  const first = checkRed(dir, { ...env, CHECK_RED_CACHE_DIR: cache });
  assert.equal(first.code, 0, first.out);
  assert.doesNotMatch(first.out, /설치 생략/);
  assert.equal(installs().length, 1, installs().join("\n"));
  assert.match(installs()[0], / install --frozen-lockfile --prefer-offline$/);

  const second = checkRed(dir, { ...env, CHECK_RED_CACHE_DIR: cache });
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /설치 생략\s+[0-9a-f]{7}/);
  assert.match(second.out, /빨강\s+[0-9a-f]{7} TC-X0\.T1\.a/);
  assert.equal(installs().length, 1, installs().join("\n"));
});

test("TC-CI.1.b 다시 쓰는 작업 트리의 시험 잔재는 다음 실행 전에 지워진다", () => {
  const { dir, red, env, installs } = setup();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "check-red-cache-"));
  const first = checkRed(dir, { ...env, CHECK_RED_CACHE_DIR: cache });
  assert.equal(first.code, 0, first.out);
  const tree = path.join(cache, red);
  assert.ok(fs.existsSync(path.join(tree, "node_modules/.fake")), "첫 실행 뒤 캐시 작업 트리가 남아 있다");

  // 앞 시험이 남긴 것처럼: 추적 파일 수정(그대로 두면 Red 커밋이 초록이 된다), 무시 파일·미추적 파일·미추적 폴더
  write(tree, "impl.mjs", FIXED);
  write(tree, "data.sqlite", "x");
  write(tree, "stray.txt", "x");
  write(tree, "left/over.txt", "x");

  const second = checkRed(dir, { ...env, CHECK_RED_CACHE_DIR: cache });
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /빨강\s+[0-9a-f]{7} TC-X0\.T1\.a/);
  assert.equal(fs.readFileSync(path.join(tree, "impl.mjs"), "utf8"), BROKEN);
  for (const rel of ["data.sqlite", "stray.txt", "left"]) assert.ok(!fs.existsSync(path.join(tree, rel)), `${rel} 가 남았다`);
  // 설치 결과(최상위·하위 패키지 node_modules)와 표식은 남아 설치를 다시 하지 않는다
  for (const rel of ["node_modules/.fake", "pkg/node_modules/.fake", "node_modules/.check-red-installed"]) assert.ok(fs.existsSync(path.join(tree, rel)), `${rel} 가 지워졌다`);
  assert.equal(installs().length, 1, installs().join("\n"));
});

test("TC-CI.1.d 앞 검사가 node_modules 를 지웠으면 표식도 없어 다시 설치한다", () => {
  const { dir, red, env, installs } = setup();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "check-red-cache-"));
  const first = checkRed(dir, { ...env, CHECK_RED_CACHE_DIR: cache });
  assert.equal(first.code, 0, first.out);
  fs.rmSync(path.join(cache, red, "node_modules"), { recursive: true, force: true });

  const second = checkRed(dir, { ...env, CHECK_RED_CACHE_DIR: cache });
  assert.equal(second.code, 0, second.out);
  assert.doesNotMatch(second.out, /설치 생략/);
  assert.equal(installs().length, 2, installs().join("\n"));
  assert.ok(fs.existsSync(path.join(cache, red, "node_modules/.check-red-installed")), "다시 설치한 뒤 표식이 생긴다");
});

test("TC-CI.1.e 잠금 파일 내용이 표식과 다르면 다시 설치한다", () => {
  const { dir, red, env, installs } = setup();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "check-red-cache-"));
  const first = checkRed(dir, { ...env, CHECK_RED_CACHE_DIR: cache });
  assert.equal(first.code, 0, first.out);
  fs.writeFileSync(path.join(cache, red, "node_modules/.check-red-installed"), "other-lock-hash");

  const second = checkRed(dir, { ...env, CHECK_RED_CACHE_DIR: cache });
  assert.equal(second.code, 0, second.out);
  assert.doesNotMatch(second.out, /설치 생략/);
  assert.equal(installs().length, 2, installs().join("\n"));
});

test("TC-CI.1.c 캐시 폴더 설정이 없으면 커밋마다 새로 꺼내 설치하고 작업 트리를 지운다", () => {
  const { dir, env, installs } = setup();
  for (let i = 1; i <= 2; i++) {
    const r = checkRed(dir, env);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /설치 생략/);
    assert.equal(installs().length, i, installs().join("\n"));
    const trees = sh(dir, "git worktree list --porcelain").split("\n").filter((l) => l.startsWith("worktree "));
    assert.equal(trees.length, 1, trees.join("\n"));
  }
});
