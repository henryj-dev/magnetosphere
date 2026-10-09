// 게이트 장치의 음성 대조. 실행판 S0.T2 의 TC-S0.T2.a ~ f.
// 테스트마다 임시 git 저장소를 만들고 scripts/gate.mjs 를 --root 로 돌린다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "gate.mjs");

function sh(dir, cmd) {
  const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

function repo(gates, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
  sh(dir, "git init -q -b main && git config user.email t@t.test && git config user.name t && git config commit.gpgsign false");
  write(dir, "gates/gates.config.mjs", `export const GATES = ${JSON.stringify(gates, null, 2)};\n`);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  commit(dir, "init");
  return dir;
}

function commit(dir, msg) {
  sh(dir, `git add -A && git commit -q --allow-empty -m "${msg}"`);
}

function gate(dir, ...args) {
  const r = spawnSync(process.execPath, [GATE, "--root", dir, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function sealExists(dir, phase) {
  return fs.existsSync(path.join(dir, "gates/seals", `${phase}.json`));
}

function status(dir) {
  const r = gate(dir, "--status", "--json");
  assert.equal(r.code, 0, r.out);
  return Object.fromEntries(JSON.parse(r.out).map((row) => [row.phase, row.state]));
}

function sealAndCommit(dir, phase) {
  const r = gate(dir, phase, "--seal");
  assert.equal(r.code, 0, r.out);
  commit(dir, `seal ${phase}`);
}

const ok = (id) => ({ id, how: "cmd", cmd: "true" });

test("TC-S0.T2.a 선행이 봉인되지 않으면 실행을 거부한다", () => {
  const dir = repo({ S0: { needs: [], checks: [ok("G0")] }, S1: { needs: ["S0"], checks: [ok("G1")] } });
  const r = gate(dir, "S1");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /S0 봉인 필요/);
  assert.equal(sealExists(dir, "S1"), false);

  sealAndCommit(dir, "S0");
  assert.equal(gate(dir, "S1").code, 0, "S0 봉인 뒤에는 S1 이 실행돼야 한다");
});

test("TC-S0.T2.b 봉인 후 그 단계를 되돌리면 봉인이 무효가 된다", () => {
  const dir = repo({ S0: { needs: [], checks: [ok("G0")] }, S1: { needs: ["S0"], checks: [ok("G1")] } });
  write(dir, "work.txt", "S0 작업");
  commit(dir, "S0 work");
  assert.equal(gate(dir, "S0", "--seal").code, 0);
  assert.equal(status(dir).S0, "sealed");
  assert.equal(status(dir).S1, "open");

  // 봉인이 가리키는 작업 커밋을 main 에서 버린다. 봉인 파일은 남아 있다.
  sh(dir, "git reset -q --hard HEAD~1");
  assert.equal(sealExists(dir, "S0"), true);
  const st = status(dir);
  assert.equal(st.S0, "invalid");
  assert.equal(st.S1, "locked", "무효 봉인으로는 다음 단계가 열리지 않아야 한다");
  assert.notEqual(gate(dir, "S1").code, 0);
});

test("TC-S0.T2.c --seal 은 검사를 다시 돌린다", () => {
  const dir = repo(
    { S0: { needs: [], checks: [{ id: "G0", how: "cmd", cmd: "test -f ok.txt" }] } },
    { "ok.txt": "x" },
  );
  assert.equal(gate(dir, "S0").code, 0);

  fs.rmSync(path.join(dir, "ok.txt"));
  const r = gate(dir, "S0", "--seal");
  assert.notEqual(r.code, 0);
  assert.equal(sealExists(dir, "S0"), false, "깨진 상태로 봉인 파일이 쓰이면 안 된다");
});

test("TC-S0.T2.d 검사 종류마다 이빨이 있다", async (t) => {
  const P = {
    needs: ["A"],
    checks: [
      { id: "lines", how: "lines", file: "a.txt", limit: 3 },
      { id: "grep", how: "grep", pattern: "BAD", in: ["src"], limit: 0 },
      { id: "test", how: "test", cmd: "node --test --test-reporter=tap t.test.mjs" },
      { id: "cmd", how: "cmd", cmd: "test -f flag" },
      { id: "diff", how: "diff-empty", path: "lock.txt", since: "seal:A" },
      { id: "json", how: "json", file: "data/*.json", path: "ok", op: "==", value: true },
    ],
  };
  const base = {
    "a.txt": "1\n2",
    "src/x.ts": "good",
    "t.test.mjs": 'import { test } from "node:test";\ntest("t", () => {});\n',
    flag: "",
    "lock.txt": "locked",
    "data/v1.json": '{ "ok": true }',
  };
  const breaks = {
    lines: (d) => write(d, "a.txt", "1\n2\n3\n4\n5"),
    grep: (d) => write(d, "src/y.ts", "BAD"),
    test: (d) => write(d, "t.test.mjs", 'import { test } from "node:test";\ntest("t", () => { throw new Error("x"); });\n'),
    cmd: (d) => fs.rmSync(path.join(d, "flag")),
    diff: (d) => write(d, "lock.txt", "changed"),
    json: (d) => write(d, "data/v2.json", '{ "ok": false }'),
  };

  function fresh() {
    const dir = repo({ A: { needs: [], checks: [ok("GA")] }, P }, base);
    sealAndCommit(dir, "A");
    return dir;
  }

  const baseline = gate(fresh(), "P");
  assert.equal(baseline.code, 0, `기준 상태는 모두 통과해야 한다\n${baseline.out}`);

  for (const [id, breakIt] of Object.entries(breaks)) {
    await t.test(`${id} 위반은 ${id} 만 실패시킨다`, () => {
      const dir = fresh();
      breakIt(dir);
      const r = gate(dir, "P");
      assert.notEqual(r.code, 0, r.out);
      const failed = [...r.out.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => m[1]);
      assert.deepEqual(failed, [id], r.out);
    });
  }

  await t.test("test 검사는 통과한 테스트가 0개면 실패한다", () => {
    const dir = fresh();
    write(dir, "gates/gates.config.mjs", `export const GATES = ${JSON.stringify({
      A: { needs: [], checks: [ok("GA")] },
      P: { needs: ["A"], checks: [{ id: "zero", how: "test", cmd: 'node --test --test-reporter=tap --test-name-pattern="없는이름" t.test.mjs' }] },
    })};\n`);
    const r = gate(dir, "P");
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /FAIL\s+zero/);
  });

  await t.test("검사가 빈 단계는 실행을 거부한다", () => {
    const dir = repo({ E: { needs: [], checks: [] } });
    const r = gate(dir, "E", "--seal");
    assert.notEqual(r.code, 0);
    assert.equal(sealExists(dir, "E"), false);
  });
});

test("TC-S0.T2.e 면제는 사유와 허용 표시가 둘 다 있어야 한다", () => {
  const dir = repo({
    S0: { needs: [], waivable: false, checks: [ok("G0")] },
    S1: { needs: ["S0"], waivable: true, checks: [{ id: "G1", how: "cmd", cmd: "false" }] },
  });

  assert.notEqual(gate(dir, "S0", "--waived", "사유").code, 0, "--seal 없는 --waived 는 거부");
  assert.notEqual(gate(dir, "S0", "--seal", "--waived", "사유").code, 0, "waivable:false 는 거부");
  assert.equal(sealExists(dir, "S0"), false);

  sealAndCommit(dir, "S0");
  assert.notEqual(gate(dir, "S1", "--seal", "--waived", "  ").code, 0, "빈 사유는 거부");
  assert.notEqual(gate(dir, "S1", "--seal", "--waived").code, 0, "사유 값이 없으면 거부");
  assert.equal(sealExists(dir, "S1"), false);

  const r = gate(dir, "S1", "--seal", "--waived", "이번 범위에서 하지 않기로 결정");
  assert.equal(r.code, 0, r.out);
  commit(dir, "waive S1");
  assert.equal(status(dir).S1, "waived");
  const seal = JSON.parse(fs.readFileSync(path.join(dir, "gates/seals/S1.json"), "utf8"));
  assert.equal(seal.waived, true);
  assert.equal(seal.reason, "이번 범위에서 하지 않기로 결정");
});

test("TC-S0.T2.f --assert-order 는 잠긴 단계 산출 변경을 잡는다", () => {
  const dir = repo({
    S0: { needs: [], outputs: ["a/**"], checks: [ok("G0")] },
    S1: { needs: ["S0"], outputs: ["packages/db/src/**"], checks: [ok("G1")] },
  });
  const initial = sh(dir, "git rev-parse HEAD");
  write(dir, "a/x.txt", "S0 산출은 S0 이 열려 있으니 허용");
  commit(dir, "S0 output");
  assert.equal(gate(dir, "--assert-order").code, 0);

  write(dir, "packages/db/src/schema.ts", "S1 산출");
  commit(dir, "S1 output too early");
  for (const extra of [[], ["--base", initial]]) {
    const r = gate(dir, "--assert-order", ...extra);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /packages\/db\/src\/schema\.ts → S1/);
  }

  // S0 을 봉인하면 S1 이 열려 같은 변경이 허용된다.
  sealAndCommit(dir, "S0");
  assert.equal(gate(dir, "--assert-order").code, 0);
});
