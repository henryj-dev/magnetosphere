// check-sealed-checks.mjs 음성 대조 (4단계 실행판 A1.T5, G-A1.19). 지금 설정을 복사해 고친 사본으로 CLI 를 돌린다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/check-sealed-checks.mjs");
const CONFIG = path.join(ROOT, "gates/gates.config.mjs");
const { GATES } = await import(pathToFileURL(CONFIG).href);
const SEALED = fs.readdirSync(path.join(ROOT, "gates/seals")).filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json"));
const OPEN = Object.keys(GATES).find((s) => !SEALED.includes(s));

/** GATES 를 고친 사본 설정 파일 */
function variant(edit) {
  const gates = structuredClone(GATES);
  edit(gates);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-checks-test-"));
  const file = path.join(dir, "gates.config.mjs");
  fs.writeFileSync(file, `export const GATES = ${JSON.stringify(gates)};\n`);
  return file;
}
function run(current) {
  const r = spawnSync(process.execPath, [SCRIPT, "--base-config", CONFIG, "--current", current, "--sealed", SEALED.join(",")], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const testCheck = (gates) => gates.M4.checks.find((c) => c.how === "test" && c.expectPassed !== undefined);

test("TC-A1.T5.b 봉인 단계 검사의 cmd·expectPassed 를 바꾼 설정 → 실패, 단계·ID·필드 출력", () => {
  const id = testCheck(GATES).id;
  for (const [field, value] of [["cmd", "echo 바뀜"], ["expectPassed", 999]]) {
    const r = run(variant((g) => (testCheck(g)[field] = value)));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`\\[sealed-check-changed\\] M4 ${id.replace(/\./g, "\\.")} ${field}`));
  }
});

test("TC-A1.T5.c 봉인 단계에 검사를 더하거나 뺀 설정 → 실패", () => {
  const added = run(variant((g) => g.S0.checks.push({ id: "G-S0.999", how: "cmd", cmd: "true" })));
  assert.equal(added.code, 1, added.out);
  assert.match(added.out, /\[sealed-check-changed\] S0 - ids/);
  const removed = run(variant((g) => g.K3.checks.pop()));
  assert.equal(removed.code, 1, removed.out);
  assert.match(removed.out, /\[sealed-check-changed\] K3 - ids/);
});

test("TC-A1.T5.d 열린·잠긴 단계의 검사를 바꾼 설정 → 통과", () => {
  assert.ok(OPEN, "봉인되지 않은 단계가 있다");
  const r = run(variant((g) => g[OPEN].checks.push({ id: `G-${OPEN}.999`, how: "cmd", cmd: "true" })));
  assert.equal(r.code, 0, r.out);
});

test("TC-A1.T5.e desc·requires 만 바꾼 설정 → 통과", () => {
  const r = run(variant((g) => {
    for (const c of g.M2.checks) {
      c.desc = `${c.desc} (설명만 고침)`;
      c.requires = ["local-services"];
    }
  }));
  assert.equal(r.code, 0, r.out);
});
