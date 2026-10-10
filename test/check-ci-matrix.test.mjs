// check-ci-matrix.mjs 의 단계 잡 요구 규칙 음성 대조 (2단계 실행판 K0.T2, G-K0.10).
// 봉인된 단계만 단계 잡을 요구한다: 아직 빨강인 단계 잡을 CI 에 미리 넣지 않아도 되고, 봉인한 단계 잡은 조용히 빠지지 않는다.
// 2단계 단계(strictTests) 하나하나에 대해 돈다. 그 단계를 봉인하고 잡을 넣은 뒤에도 사본에서 그 줄을 지워 같은 대조를 한다.
// scripts/*.test.mjs 에 두지 않는다. check-ci-matrix 는 yaml 패키지가 필요한데 gate.yml 의 스크립트 테스트는 설치 없이 돈다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/check-ci-matrix.mjs");
const SEALS = path.join(ROOT, "gates/seals");
const { GATES } = await import(pathToFileURL(path.join(ROOT, "gates/gates.config.mjs")).href);
const PHASE2 = Object.keys(GATES).filter((p) => GATES[p].strictTests === true);

function run(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, "--expect", "6", ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** 저장소 봉인 폴더를 복사해 2단계 봉인을 빼고 extra 봉인 파일을 더한 임시 폴더 */
function sealDir(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-matrix-seals-"));
  for (const f of fs.readdirSync(SEALS)) if (!PHASE2.includes(path.basename(f, ".json"))) fs.copyFileSync(path.join(SEALS, f), path.join(dir, f));
  for (const [phase, seal] of Object.entries(extra)) fs.writeFileSync(path.join(dir, `${phase}.json`), JSON.stringify(seal));
  return dir;
}

/** ci.yml 에서 2단계 게이트 명령 줄을 모두 지운 사본 */
function ciWithoutPhase2() {
  let src = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  for (const p of PHASE2) src = src.replace(new RegExp(`^(\\s+run: )node scripts/gate\\.mjs ${p}\\b.*$`, "gm"), `$1echo ${p} 없음`);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ci-matrix-yml-")), "ci.yml");
  fs.writeFileSync(file, src);
  return file;
}

test("TC-K0.T2.a 봉인하지 않은 단계의 잡은 요구하지 않는다", () => {
  assert.ok(PHASE2.length > 0, "2단계 단계(strictTests)가 설정에 없다");
  const r = run("--file", ciWithoutPhase2(), "--seal-dir", sealDir());
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /\[stage-missing\]/);
});

test("TC-K0.T2.b 봉인 파일이 생긴 단계의 잡이 없으면 stage-missing 으로 실패한다", () => {
  const ci = ciWithoutPhase2();
  for (const p of PHASE2) {
    const r = run("--file", ci, "--seal-dir", sealDir({ [p]: { phase: p, sealed: true, waived: false } }));
    assert.notEqual(r.code, 0, `${p}: ${r.out}`);
    assert.match(r.out, new RegExp(`\\[stage-missing\\] ${p}:`));
    // 면제 봉인은 게이트를 돌릴 검사가 없으므로 요구하지 않는다
    const waived = run("--file", ci, "--seal-dir", sealDir({ [p]: { phase: p, sealed: true, waived: true, reason: "시험" } }));
    assert.equal(waived.code, 0, `${p} 면제: ${waived.out}`);
  }
});
