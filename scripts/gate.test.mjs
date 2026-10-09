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

  await t.test("test 검사는 todo·skip 테스트를 통과로 세지 않는다", () => {
    const dir = fresh();
    write(dir, "t.test.mjs", 'import { test } from "node:test";\ntest("todo", { todo: true }, () => {});\ntest("skip", { skip: true }, () => {});\n');
    const r = gate(dir, "P");
    const failed = [...r.out.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => m[1]);
    assert.deepEqual(failed, ["test"], r.out);
  });

  await t.test("test 검사는 색상 코드가 섞인 vitest 요약을 읽고, 통과 0 이면 실패한다", () => {
    const esc = "\\033";
    const vitest = (passed) =>
      `printf '${esc}[2m      Tests ${esc}[22m ${esc}[1m${esc}[32m${passed} passed${esc}[39m${esc}[22m (2)\\n'`;
    const dir = repo({
      V1: { needs: [], checks: [{ id: "v1", how: "test", cmd: vitest(1) }] },
      V0: { needs: [], checks: [{ id: "v0", how: "test", cmd: `printf '      Tests  2 skipped (2)\\n'` }] },
    });
    const one = gate(dir, "V1");
    assert.equal(one.code, 0, one.out);
    assert.match(one.out, /PASS\s+v1 .*통과 1/);
    const zero = gate(dir, "V0");
    assert.notEqual(zero.code, 0, zero.out);
  });

  await t.test("grep 검사는 in 경로가 없으면 실패한다", () => {
    const dir = fresh();
    fs.rmSync(path.join(dir, "src"), { recursive: true });
    const r = gate(dir, "P");
    const failed = [...r.out.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => m[1]);
    assert.deepEqual(failed, ["grep"], r.out);
  });

  await t.test("diff-empty 는 기준 봉인 head 가 이상하면 실패한다", () => {
    const dir = fresh();
    const sp = path.join(dir, "gates/seals/A.json");
    const seal = JSON.parse(fs.readFileSync(sp, "utf8"));
    fs.writeFileSync(sp, JSON.stringify({ ...seal, head: "deadbeef" }));
    // A 봉인이 무효가 되면 R1 로 P 실행 자체가 거부된다. diff-empty 단독 동작은 R1 을 거치지 않게 단계 하나로 본다.
    write(dir, "gates/gates.config.mjs", `export const GATES = ${JSON.stringify({
      A: { needs: [], checks: [ok("GA")] },
      Q: { needs: [], checks: [{ id: "diff", how: "diff-empty", path: "lock.txt", since: "seal:A" }] },
    })};\n`);
    const r = gate(dir, "Q");
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /FAIL\s+diff/);
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

test("TC-S0.T2.g 위조·복사한 봉인은 무효다", () => {
  const gates = {
    S0: { needs: [], checks: [ok("G0")] },
    S1: { needs: ["S0"], checks: [ok("G1")] },
    S2: { needs: ["S1"], checks: [ok("G2")] },
  };
  const dir = repo(gates);
  sealAndCommit(dir, "S0");
  const s0 = JSON.parse(fs.readFileSync(path.join(dir, "gates/seals/S0.json"), "utf8"));
  const head = sh(dir, "git rev-parse HEAD");

  const forgeries = {
    "다른 단계 봉인 복사": s0,
    "ref 이름 head": { ...s0, phase: "S1", head: "HEAD", checks: [{ id: "G1", ok: true }] },
    "짧은 SHA": { ...s0, phase: "S1", head: head.slice(0, 7), checks: [{ id: "G1", ok: true }] },
    "없는 커밋": { ...s0, phase: "S1", head: "0".repeat(40), checks: [{ id: "G1", ok: true }] },
    "검사 목록 다름": { ...s0, phase: "S1", head, checks: [{ id: "G0", ok: true }] },
    "실패 검사 포함": { ...s0, phase: "S1", head, checks: [{ id: "G1", ok: false }] },
    "면제 불가 단계 면제": { ...s0, phase: "S1", head, waived: true, reason: "x", checks: [] },
    "최소 필드만": { sealed: true, head },
  };
  for (const [name, forged] of Object.entries(forgeries)) {
    write(dir, "gates/seals/S1.json", JSON.stringify(forged));
    const st = status(dir);
    assert.equal(st.S1, "invalid", `${name}: S1 이 무효여야 한다`);
    assert.equal(st.S2, "locked", `${name}: 위조 봉인으로 S2 가 열리면 안 된다`);
    assert.notEqual(gate(dir, "S2").code, 0, name);
    assert.notEqual(gate(dir, "--verify-seals").code, 0, name);
  }
});

test("TC-S0.T2.h 구조가 맞는 위조 봉인은 --verify-seals --rerun 이 잡는다", () => {
  const dir = repo({
    S0: { needs: [], checks: [ok("G0")] },
    S1: { needs: ["S0"], checks: [{ id: "G1", how: "cmd", cmd: "test -f done.txt" }] },
  });
  sealAndCommit(dir, "S0");
  const head = sh(dir, "git rev-parse HEAD");
  // done.txt 가 없는 커밋을 가리키면서 검사 결과는 통과라고 적은 봉인
  write(dir, "gates/seals/S1.json", JSON.stringify({ phase: "S1", sealed: true, head, at: "x", waived: false, reason: null, checks: [{ id: "G1", ok: true }] }));
  commit(dir, "forged S1 seal");
  assert.equal(status(dir).S1, "sealed", "구조 검사만으로는 못 잡는 위조다 (전제)");
  assert.equal(gate(dir, "--verify-seals").code, 0);
  const r = gate(dir, "--verify-seals", "--rerun");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /S1: 봉인 커밋 .* 다시 돌린 검사 실패/);
});

test("TC-S0.T2.i 잠긴 단계의 설정을 같은 변경 안에서 고쳐 순서를 피할 수 없다", () => {
  const gates = {
    S0: { needs: [], outputs: ["a/**"], checks: [ok("G0")] },
    S1: { needs: ["S0"], outputs: ["s1/**"], checks: [ok("G1")] },
    S2: { needs: ["S1"], outputs: ["s2/**"], checks: [ok("G2")] },
  };
  const variants = {
    "needs 비우기": (g) => ({ ...g, S2: { ...g.S2, needs: [] } }),
    "outputs 지우기": (g) => ({ ...g, S2: { ...g.S2, outputs: [] } }),
    "단계 삭제": (g) => ({ S0: g.S0, S1: g.S1 }),
    "면제 허용으로 바꾸기": (g) => ({ ...g, S2: { ...g.S2, waivable: true } }),
  };
  for (const [name, change] of Object.entries(variants)) {
    const dir = repo(gates);
    const base = sh(dir, "git rev-parse HEAD");
    write(dir, "gates/gates.config.mjs", `export const GATES = ${JSON.stringify(change(gates))};\n`);
    write(dir, "s2/f.txt", "S2 산출");
    commit(dir, name);
    const r = gate(dir, "--assert-order", "--base", base);
    assert.notEqual(r.code, 0, `${name}\n${r.out}`);
  }
});

test("TC-S0.T2.j --assert-order --head 는 지정한 커밋을 본다", () => {
  const dir = repo({
    S0: { needs: [], outputs: ["a/**"], checks: [ok("G0")] },
    S1: { needs: ["S0"], outputs: ["s1/**"], checks: [ok("G1")] },
  });
  const base = sh(dir, "git rev-parse HEAD");
  sh(dir, "git checkout -q -b evil");
  write(dir, "s1/f.txt", "S1 산출");
  commit(dir, "evil");
  const evil = sh(dir, "git rev-parse HEAD");
  sh(dir, "git checkout -q main");
  assert.equal(gate(dir, "--assert-order", "--base", base).code, 0, "main 에는 위반이 없다");
  const r = gate(dir, "--assert-order", "--base", base, "--head", evil);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /s1\/f\.txt → S1/);
});

test("TC-S0.T2.k --skip-requires 는 태그 붙은 검사만 건너뛰고, 건너뛴 실행으로는 봉인하지 않는다", () => {
  const dir = repo({
    S0: { needs: [], checks: [
      { id: "plain", how: "cmd", cmd: "true" },
      { id: "local", how: "cmd", requires: ["local-services"], cmd: "false" },
    ] },
  });
  const full = gate(dir, "S0");
  assert.notEqual(full.code, 0, "태그가 있어도 옵션 없이는 그대로 돈다");
  assert.match(full.out, /FAIL\s+local/);

  const skipped = gate(dir, "S0", "--skip-requires", "local-services");
  assert.equal(skipped.code, 0, skipped.out);
  assert.match(skipped.out, /SKIP\s+local/);
  assert.match(skipped.out, /PASS\s+plain/);

  const other = gate(dir, "S0", "--skip-requires", "다른-태그");
  assert.notEqual(other.code, 0, "다른 태그로는 건너뛰지 않는다");

  const seal = gate(dir, "S0", "--seal", "--skip-requires", "local-services");
  assert.notEqual(seal.code, 0);
  assert.equal(sealExists(dir, "S0"), false, "건너뛴 실행으로 봉인 파일이 생기면 안 된다");
});

test("TC-S0.T2.l --verify-seals --rerun --skip-requires 는 태그 없는 검사를 여전히 다시 돌린다", () => {
  const dir = repo({
    S0: { needs: [], checks: [ok("G0")] },
    S1: { needs: ["S0"], checks: [
      { id: "G1", how: "cmd", cmd: "test -f done.txt" },
      { id: "G1L", how: "cmd", requires: ["local-services"], cmd: "test -f local.txt" },
    ] },
  });
  sealAndCommit(dir, "S0");
  const head = sh(dir, "git rev-parse HEAD");
  write(dir, "gates/seals/S1.json", JSON.stringify({ phase: "S1", sealed: true, head, at: "x", waived: false, reason: null,
    checks: [{ id: "G1", ok: true }, { id: "G1L", ok: true }] }));
  commit(dir, "forged S1 seal");
  const r = gate(dir, "--verify-seals", "--rerun", "--skip-requires", "local-services");
  assert.notEqual(r.code, 0, `태그 없는 G1 은 다시 돌아 위조를 잡아야 한다\n${r.out}`);
  assert.match(r.out, /FAIL\s+G1 /);
  assert.match(r.out, /SKIP\s+G1L/);
});
