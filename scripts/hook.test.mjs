// TC-S0.T3.a: pre-push 훅이 잠긴 단계 변경 push 를 실제로 막는지 임시 원격으로 검사한다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sh(dir, cmd) {
  return spawnSync(cmd, { cwd: dir, shell: true, encoding: "utf8" });
}

function must(dir, cmd) {
  const r = sh(dir, cmd);
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

test("TC-S0.T3.a pre-push 훅이 잠긴 단계 변경 push 를 막는다", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
  const remote = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");
  must(tmp, `git init -q --bare -b main ${remote} && git init -q -b main ${work}`);
  must(work, "git config user.email t@t.test && git config user.name t && git config commit.gpgsign false");

  // 저장소의 실제 훅과 장치를 그대로 쓴다. 설정만 작은 것으로 바꾼다.
  fs.cpSync(path.join(ROOT, ".githooks"), path.join(work, ".githooks"), { recursive: true });
  fs.cpSync(path.join(ROOT, "scripts/gate.mjs"), path.join(work, "scripts/gate.mjs"));
  write(work, "gates/gates.config.mjs", `export const GATES = ${JSON.stringify({
    S0: { needs: [], outputs: ["a/**"], checks: [{ id: "G0", how: "cmd", cmd: "true" }] },
    S1: { needs: ["S0"], outputs: ["packages/db/src/**"], checks: [{ id: "G1", how: "cmd", cmd: "true" }] },
  })};\n`);
  must(work, "git config core.hooksPath .githooks");
  must(work, `git add -A && git commit -q -m init && git remote add origin ${remote}`);

  const first = sh(work, "git push -q -u origin main");
  assert.equal(first.status, 0, `허용된 첫 push 는 성공해야 한다\n${first.stderr}`);

  write(work, "packages/db/src/schema.ts", "S1 산출");
  must(work, 'git add -A && git commit -q -m "S1 output too early"');
  const blocked = sh(work, "git push -q origin main");
  assert.notEqual(blocked.status, 0, "잠긴 단계 변경 push 는 거부돼야 한다");
  assert.match(blocked.stderr, /packages\/db\/src\/schema\.ts → S1/);

  const remoteHead = must(remote, "git rev-parse main");
  const localPrev = must(work, "git rev-parse HEAD~1");
  assert.equal(remoteHead, localPrev, "거부된 커밋이 원격에 올라가면 안 된다");
});

test("TC-S0.T3.b 현재 브랜치가 아닌 브랜치를 push 해도 훅이 그 브랜치를 검사한다", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
  const remote = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");
  must(tmp, `git init -q --bare -b main ${remote} && git init -q -b main ${work}`);
  must(work, "git config user.email t@t.test && git config user.name t && git config commit.gpgsign false");
  fs.cpSync(path.join(ROOT, ".githooks"), path.join(work, ".githooks"), { recursive: true });
  fs.cpSync(path.join(ROOT, "scripts/gate.mjs"), path.join(work, "scripts/gate.mjs"));
  write(work, "gates/gates.config.mjs", `export const GATES = ${JSON.stringify({
    S0: { needs: [], outputs: ["a/**"], checks: [{ id: "G0", how: "cmd", cmd: "true" }] },
    S1: { needs: ["S0"], outputs: ["s3/**"], checks: [{ id: "G1", how: "cmd", cmd: "true" }] },
  })};\n`);
  must(work, "git config core.hooksPath .githooks");
  must(work, `git add -A && git commit -q -m init && git remote add origin ${remote}`);
  assert.equal(sh(work, "git push -q -u origin main").status, 0);

  must(work, "git checkout -q -b evil");
  write(work, "s3/f.txt", "잠긴 산출");
  must(work, 'git add -A && git commit -q -m evil && git checkout -q main');
  const r = sh(work, "git push -q origin evil");
  assert.notEqual(r.status, 0, "다른 브랜치의 위반도 거부돼야 한다");
  assert.match(r.stderr, /s3\/f\.txt → S1/);
  assert.notEqual(sh(remote, "git rev-parse --verify --quiet refs/heads/evil").status, 0, "evil 이 원격에 생기면 안 된다");
});
