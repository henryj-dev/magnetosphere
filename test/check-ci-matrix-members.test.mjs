// check-ci-matrix.mjs 의 [members-scenario] 규칙 양성·음성 대조 (TC-CI.4, 3단계 실행판 M5.T3).
// 게이트 설정 M5 에 `pnpm e2e --combo <조합> --scenario members` 검사가 있으면 e2e 매트릭스 잡에
// `pnpm e2e --combo ${{ matrix.combo }} --scenario members` 명령 줄이 있어야 한다. 봉인 여부와 상관없이 켠다 (K5 키 시나리오와 같다).
// 픽스처 e2e-members-missing.yml 은 실제 ci.yml 에서 그 스텝과 아직 봉인 안 된 p3-m5 잡을 지운 사본이라, 잡히는 문제가 [members-scenario] 하나뿐이어야 한다.
// p3-m5 잡(--skip-ids G-M5.1~6)까지 지워 두면 옛 검사기에서는 문제 0 이므로, TC-CI.4.c 의 재현 빨강(G-M5.17)이 members 규칙 유무만 가린다.
// 임시 git 저장소는 쓰지 않는다. 기존 test/check-ci-matrix.test.mjs (G-K0.10, expectPassed 2) 는 건드리지 않는다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// test/ 에 둔다. yaml 패키지를 쓰는 스크립트를 띄우므로, 설치 없이 도는 gate.yml 의 scripts/*.test.mjs 에 두지 않는다.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/check-ci-matrix.mjs");
const FIXTURE = "test/fixtures/ci-guard/e2e-members-missing.yml";
const CI = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
const MEMBERS_RE = /^(\s+run: )pnpm e2e --combo \$\{\{ matrix\.combo \}\} --scenario members$/m;
const { GATES } = await import(pathToFileURL(path.join(ROOT, "gates/gates.config.mjs")).href);

function run(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, "--expect", "6", ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** ci.yml 의 회원 정책 시나리오 명령 줄을 line 으로 바꾼 사본으로 검사한다 */
function runCi(line) {
  assert.match(CI, MEMBERS_RE, "ci.yml 에서 회원 정책 시나리오 명령 줄을 찾지 못했다");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-matrix-members-"));
  const file = path.join(dir, "ci.yml");
  fs.writeFileSync(file, CI.replace(MEMBERS_RE, `$1${line}`));
  const r = run("--file", file);
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

/** 실패하고, 잡힌 문제가 모두 [members-scenario] 다 */
function assertMembersOnly(r) {
  assert.equal(r.code, 1, r.out);
  const codes = [...r.out.matchAll(/^\[([a-z0-9-]+)\]/gm)].map((m) => m[1]);
  assert.ok(codes.length > 0, r.out);
  assert.deepEqual([...new Set(codes)], ["members-scenario"], r.out);
}

test("TC-CI.4.a 게이트 설정 M5 에 여섯 조합 회원 정책 시나리오가 있다 (봉인 전 검출의 전제)", () => {
  const combos = (GATES.M5?.checks ?? []).map((c) => /^pnpm e2e --combo (\S+) --scenario members$/.exec(c.cmd ?? "")?.[1]).filter(Boolean);
  assert.deepEqual(combos.sort(), ["docker-mysql", "docker-pg", "docker-sqlite", "workers-d1", "workers-mysql", "workers-pg"]);
});

test("TC-CI.4.b 실제 ci.yml 사본은 통과한다", () => {
  const r = runCi("pnpm e2e --combo ${{ matrix.combo }} --scenario members");
  assert.equal(r.code, 0, r.out);
});

test("TC-CI.4.c 픽스처(회원 정책 스텝과 봉인 전 p3-m5 잡을 지운 사본)는 [members-scenario] 하나로만 실패하고 음성 대조로 잡힌다", () => {
  // 빈 봉인 폴더로 돈다. M5 봉인 뒤 기본 gates/seals 로 돌면 p3-m5 잡을 지운 이 사본에 [stage-missing] 이 더해져 시험이 깨진다.
  // members 규칙은 봉인과 상관없이 게이트 설정으로 켜지므로 빈 폴더여도 같은 것을 본다. 옛 검사기도 --seal-dir 를 받는다.
  const seals = fs.mkdtempSync(path.join(os.tmpdir(), "ci-matrix-members-seals-"));
  try {
    assertMembersOnly(run("--fixture", FIXTURE, "--seal-dir", seals));
    const r = run("--fixture", FIXTURE, "--seal-dir", seals, "--expect-fail");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[members-scenario\] 잡음/);
  } finally {
    fs.rmSync(seals, { recursive: true, force: true });
  }
});

test("TC-CI.4.d 시나리오 인자가 빠지거나 바뀌거나 조합이 고정되면 [members-scenario] 로 실패한다", () => {
  for (const line of [
    "pnpm e2e --combo ${{ matrix.combo }} --scenario member",
    "pnpm e2e --combo ${{ matrix.combo }} --scenario members-regress",
    "pnpm e2e --combo ${{ matrix.combo }} --scenario members --only a",
    "pnpm e2e --combo docker-sqlite --scenario members",
  ]) {
    assertMembersOnly(runCi(line));
  }
});
