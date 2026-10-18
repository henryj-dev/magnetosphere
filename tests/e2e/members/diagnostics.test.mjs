// 회원 E2E 진단 도우미 단위 시험 (오프라인). node --test tests/e2e/members/diagnostics.test.mjs
// Docker·DB·네트워크 없이 diagnostics.mjs 만 불러 검사한다 (시나리오를 실행하지 않는다).
// DB 읽기 스크립트는 소스 검사와, 드라이버를 불러오기 전에 끝나는 거부 경로 실행만 한다 (실제 DB·드라이버 경로는 E2E 가 본다).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { commandFailureCode, dbReadFailureCode, dbReadTimeoutCode, ensurePrivateDir, formatStackSnapshot, keepStackForCleanup, lastReadStage, ownedStackDir, READ_EXIT, READ_OPS, READ_SCRIPT, READ_SQL, READ_STAGES } from "./diagnostics.mjs";

const SECRET = "postgres://mg:pw-secret@db/x token=tok-secret user@e2e.test SELECT * FROM user";
const FIXED = /^E_DB_READ_TIMEOUT_AT_(BOOT|START|IMPORT|CONNECT|QUERY|CLOSE)$/;

describe("DB 읽기 단계 marker", () => {
  test("marker 가 없으면 BOOT", () => {
    assert.equal(lastReadStage(""), "boot");
    assert.equal(dbReadTimeoutCode(undefined), "E_DB_READ_TIMEOUT_AT_BOOT");
    assert.equal(dbReadTimeoutCode(`node: ${SECRET}\n`), "E_DB_READ_TIMEOUT_AT_BOOT");
  });

  test("단계마다 고정 코드", () => {
    for (const [i, stage] of READ_STAGES.entries()) {
      const stderr = READ_STAGES.slice(0, i + 1).map((s, n) => `MGT ${s} ${n * 10}`).join("\n") + "\n";
      assert.equal(dbReadTimeoutCode(stderr), `E_DB_READ_TIMEOUT_AT_${stage.toUpperCase()}`);
    }
  });

  test("가장 뒤 단계를 고른다 (줄 순서·CRLF·앞뒤 원문과 무관)", () => {
    assert.equal(lastReadStage(`MGT connect 40\r\n${SECRET}\nMGT start 3\nMGT import 20\n`), "connect");
  });

  test("형식이 다른 줄은 marker 로 보지 않는다", () => {
    for (const bad of ["MGT query 12 " + SECRET, "x MGT query 12", "MGT query", "MGT query -1", "MGT drop 5", `MGT ${SECRET} 5`]) {
      assert.equal(lastReadStage(`MGT start 1\n${bad}\n`), "start", bad);
    }
  });

  test("원문 값이 진단 코드로 새지 않는다", () => {
    const code = dbReadTimeoutCode(`${SECRET}\nMGT import 9\n${SECRET}\n`);
    assert.match(code, FIXED);
    for (const part of ["pw-secret", "tok-secret", "e2e.test", "SELECT"]) assert.ok(!code.includes(part));
  });
});

describe("DB 읽기 스크립트", () => {
  const lines = READ_SCRIPT.split("\n").map((l) => l.trim()).filter(Boolean);

  test("정적 import 가 없고, start marker 가 모듈 불러오기보다 먼저다", () => {
    assert.ok(!/^\s*import\s/m.test(READ_SCRIPT));
    const start = lines.indexOf('mark("start");');
    const load = lines.findIndex((l) => /getBuiltinModule|createRequire|import\(|require\(/.test(l));
    assert.equal(start, 1);
    assert.ok(load > start);
  });

  test("runtime·ORM·인증 모듈을 불러오지 않고, 드라이버 셋만 packages/runtime 에서 불러온다", () => {
    for (const bad of ["@magnetosphere/runtime", "connectNode", "drizzle", "better-auth", "hono", "import("]) assert.ok(!READ_SCRIPT.includes(bad), bad);
    assert.ok(READ_SCRIPT.includes('createRequire(resolve(process.cwd(), "../../packages/runtime/package.json"))'));
    assert.ok(READ_SCRIPT.includes('{ sqlite: "@libsql/client", mysql: "mysql2/promise", pg: "postgres" }[dialect]'));
  });

  test("단계 marker 가 start·import·connect·query·close 순서로 놓인다", () => {
    const at = READ_STAGES.map((s) => READ_SCRIPT.indexOf(`mark("${s}")`));
    for (let i = 1; i < at.length; i++) assert.ok(at[i - 1] >= 0 && at[i] > at[i - 1], READ_STAGES[i]);
  });

  test("kind 허용 목록·바인딩 필드 검사가 드라이버 불러오기보다 먼저다", () => {
    const check = READ_SCRIPT.indexOf("!Object.hasOwn(OPS, kind)");
    assert.ok(check > 0 && check < READ_SCRIPT.indexOf("getBuiltinModule"));
    assert.ok(READ_SCRIPT.includes('OPS[kind].every((f) => typeof op[f] === "string")'));
    assert.ok(READ_SCRIPT.includes(`const OPS = ${JSON.stringify(READ_OPS)};`));
    assert.ok(READ_SCRIPT.includes(`const SQL = ${JSON.stringify(READ_SQL)};`));
    assert.ok(READ_SCRIPT.includes(`const EXIT = ${JSON.stringify(READ_EXIT)};`));
    // SQL 은 고정 표에서 고르기만 하고 값은 바인딩 배열로 넘긴다
    assert.ok(READ_SCRIPT.includes("await all(SQL[dialect][kind], OPS[kind].map((f) => op[f]))"));
  });

  test("close 오류는 앞 오류 번호를 덮지 않는다 (소스 검사)", () => {
    assert.ok(READ_SCRIPT.includes("try { await close(); } catch { if (!code) code = EXIT.close; }"));
    assert.ok(READ_SCRIPT.includes("} catch {\n  code = stage;\n}"));
    assert.ok(READ_SCRIPT.includes('if (code) process.exitCode = code;\nelse process.stdout.write("\\n@@"'));
  });

  test("다섯 단계 marker 를 찍고 결과는 @@ 한 줄이다", () => {
    for (const stage of READ_STAGES) assert.ok(READ_SCRIPT.includes(`mark("${stage}")`), stage);
    assert.ok(READ_SCRIPT.includes('process.stdout.write("\\n@@" + JSON.stringify(out) + "\\n")'));
  });

  test("marker 는 단계 이름과 ms 만 쓴다", () => {
    assert.ok(lines[0].startsWith("const mark = (stage) => process.stderr.write(\"\\nMGT \" + stage + \" \" + Math.round(performance.now()) + \"\\n\")"));
    assert.equal((READ_SCRIPT.match(/process\.stderr\.write/g) ?? []).length, 1);
  });
});

describe("DB 읽기 고정 SELECT", () => {
  const WRITE = /\b(insert|update|delete|drop|alter|create|replace|truncate|pragma|attach|grant|set)\b/i;

  test("방언마다 READ_OPS 와 같은 kind 만 있다", () => {
    assert.deepEqual(Object.keys(READ_SQL).sort(), ["mysql", "pg", "sqlite"]);
    for (const [dialect, qs] of Object.entries(READ_SQL)) assert.deepEqual(Object.keys(qs).sort(), Object.keys(READ_OPS).sort(), dialect);
  });

  test("SELECT 한 문장, 쓰기 낱말·비밀 열 없음, 자리표시자 수 = 바인딩 필드 수", () => {
    for (const [dialect, qs] of Object.entries(READ_SQL)) {
      for (const [kind, q] of Object.entries(qs)) {
        const where = `${dialect}.${kind}`;
        assert.match(q, /^SELECT /, where);
        assert.ok(!q.includes(";") && !q.includes("${") && !WRITE.test(q), where);
        assert.ok(!/password|token|secret/i.test(q), where);
        const holders = dialect === "pg" ? (q.match(/\$\d+/g) ?? []) : (q.match(/\?/g) ?? []);
        assert.equal(holders.length, READ_OPS[kind].length, where);
        if (dialect === "pg") holders.forEach((h, i) => assert.equal(h, `$${i + 1}`, where));
      }
    }
  });

  test("user·key 는 방언에 맞게 감싼다", () => {
    for (const q of Object.values(READ_SQL.mysql)) assert.ok(!q.includes('"'), q);
    assert.ok(READ_SQL.mysql.userCount.includes("`user`") && READ_SQL.mysql.counter.includes("`key` = ?"));
    for (const d of ["sqlite", "pg"]) {
      assert.ok(!Object.values(READ_SQL[d]).some((q) => q.includes("`")), d);
      assert.ok(READ_SQL[d].user.includes('FROM "user"') && READ_SQL[d].counter.includes('"key" ='), d);
    }
  });

  test("실패 종료 번호는 고정 코드로만 바뀐다", () => {
    for (const [name, code] of Object.entries(READ_EXIT)) assert.equal(dbReadFailureCode({ code, err: SECRET }), `E_DB_READ_${name.toUpperCase()}`);
    assert.equal(dbReadFailureCode({ code: 1, out: SECRET }), "E_DB_READ_EXIT_1");
    assert.equal(dbReadFailureCode({ code: 0 }), "E_DB_READ_EXIT_0");
    assert.equal(dbReadFailureCode({ code: READ_EXIT.query, timedOut: true }), "E_DB_READ_TIMEOUT");
    assert.equal(dbReadFailureCode(undefined), "E_DB_READ_EXIT_UNKNOWN");
  });
});

describe("DB 읽기 스크립트 실행 (드라이버·DB 없이 되는 거부 경로만)", () => {
  // 드라이버를 불러오기 전에 끝나는 경로만 실제로 돌린다. 드라이버·연결·질의·close 경로는 위 소스 검사로만 본다.
  const runScript = (op, db) => spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: os.tmpdir(), input: READ_SCRIPT, encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, MG_E2E_OP: op, ...(db === undefined ? {} : { MG_E2E_DB: db }) },
  });
  const onlyStart = (r) => {
    assert.equal(r.stdout, "");
    assert.equal(lastReadStage(r.stderr), "start");
    assert.deepEqual(r.stderr.split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, 2).join(" ")), ["MGT start"]);
    for (const part of ["pw-secret", "tok-secret", "e2e.test"]) assert.ok(!r.stderr.includes(part), part);
  };

  test("모르는 kind·바인딩 필드 없음·JSON 아님은 import 전에 E_DB_READ_OP", () => {
    for (const op of [JSON.stringify({ kind: "dropAll", email: SECRET }), JSON.stringify({ kind: "__proto__" }), JSON.stringify({ kind: "auditCount" }), JSON.stringify({ kind: "user", email: 1 }), "not json"]) {
      const r = runScript(op, "postgres://mg:pw-secret@db/x");
      assert.equal(r.status, READ_EXIT.op, op);
      assert.equal(dbReadFailureCode({ code: r.status }), "E_DB_READ_OP");
      onlyStart(r);
    }
  });

  test("모르는 DATABASE_URL 형식은 import 전에 E_DB_READ_URL", () => {
    for (const db of ["", "http://x", `redis://${SECRET}`]) {
      const r = runScript(JSON.stringify({ kind: "userCount" }), db);
      assert.equal(r.status, READ_EXIT.url, db);
      onlyStart(r);
    }
  });
});

describe("자식 프로세스 실패 코드", () => {
  test("시간 초과·종료 번호·알 수 없음", () => {
    assert.equal(commandFailureCode("E_CLEANUP_STACK", { timedOut: true, code: 1 }), "E_CLEANUP_STACK_TIMEOUT");
    assert.equal(commandFailureCode("E_CLEANUP_STACK", { code: 0 }), "E_CLEANUP_STACK_EXIT_0");
    assert.equal(commandFailureCode("E_CLEANUP_STACK", { code: 255 }), "E_CLEANUP_STACK_EXIT_255");
    for (const code of [256, -1, 1.5, null, undefined, "1"]) assert.equal(commandFailureCode("E_MAIL_LOG_READ", { code }), "E_MAIL_LOG_READ_EXIT_UNKNOWN");
  });

  test("출력 원문을 쓰지 않는다", () => {
    assert.equal(commandFailureCode("E_CLEANUP_STACK", { code: 125, out: SECRET, err: SECRET }), "E_CLEANUP_STACK_EXIT_125");
  });
});

describe("묶음 폴더 정리 범위·manifest", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mg-diag-test-"));
  after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  test("임시 폴더 바로 아래 mg-e2e-* 폴더만 이 시험 소유로 본다", () => {
    const owned = fs.mkdtempSync(path.join(tmpRoot, "mg-e2e-"));
    assert.equal(ownedStackDir(owned, tmpRoot), true);
    const nested = path.join(owned, "mg-e2e-inner");
    fs.mkdirSync(nested);
    assert.equal(ownedStackDir(nested, tmpRoot), false);
    const other = fs.mkdtempSync(path.join(tmpRoot, "mg-deploy-"));
    assert.equal(ownedStackDir(other, tmpRoot), false);
    const link = path.join(tmpRoot, "mg-e2e-link");
    fs.symlinkSync(other, link);
    assert.equal(ownedStackDir(link, tmpRoot), false);
    for (const bad of [tmpRoot, path.dirname(tmpRoot), "", undefined, path.join(tmpRoot, "mg-e2e-missing")]) assert.equal(ownedStackDir(bad, tmpRoot), false);
  });

  test("열린 권한 폴더는 0700 으로 맞춘다", { skip: process.platform === "win32" ? "POSIX 권한 없음" : false }, () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "mg-e2e-"));
    fs.chmodSync(dir, 0o755);
    assert.equal(ensurePrivateDir(dir), true);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  test("manifest 는 프로젝트 이름·경로만 담고 0600 이다", { skip: process.platform === "win32" ? "POSIX 권한 없음" : false }, () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "mg-e2e-"));
    fs.writeFileSync(path.join(dir, ".env"), `INITIAL_PASSWORD=${SECRET}\n`, { mode: 0o600 });
    const root = path.join(tmpRoot, "manifests");
    assert.equal(keepStackForCleanup({ project: "mg-e2e-sqlite-a1b2c3", dir }, root), "E_CLEANUP_STACK_KEPT");
    const file = path.join(root, "mg-e2e-sqlite-a1b2c3.json");
    const text = fs.readFileSync(file, "utf8");
    assert.deepEqual(JSON.parse(text), { project: "mg-e2e-sqlite-a1b2c3", dir: path.resolve(dir) });
    assert.ok(!text.includes("secret"));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.ok(fs.existsSync(path.join(dir, ".env")), "정리 실패 때 폴더를 지우지 않는다");
  });

  test("이 시험 형식이 아닌 프로젝트 이름이면 manifest 를 쓰지 않는다", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "mg-e2e-"));
    const root = path.join(tmpRoot, "manifests-bad");
    for (const project of ["../x", "other-project", "mg-e2e-sqlite-../../x", undefined]) {
      assert.equal(keepStackForCleanup({ project, dir }, root), "E_CLEANUP_MANIFEST");
    }
    assert.equal(fs.existsSync(root), false);
  });
});

describe("실패 시점 묶음 상태 한 줄", () => {
  test("정상 값은 고정 형식으로 낸다", () => {
    const line = formatStackSnapshot({ state: { Status: "running", ExitCode: 0, OOMKilled: false, Health: { Status: "healthy" } }, probe: { result: "ok", status: 200, ms: 35.4 }, load1: 14.234 });
    assert.equal(line, "진단 app=running/healthy exit=0 oom=false probe=ok/200/35ms load1=14.2");
  });

  test("멈춘 앱과 바쁜 장비를 서로 다른 값으로 남긴다", () => {
    assert.equal(formatStackSnapshot({ state: { Status: "running" }, probe: { result: "timeout", ms: 5000 }, load1: 3 }), "진단 app=running/none exit=unknown oom=unknown probe=timeout/-/5000ms load1=3.0");
    assert.equal(formatStackSnapshot({ state: { Status: "exited", ExitCode: 137, OOMKilled: true }, probe: { result: "error", ms: 2 } }), "진단 app=exited/none exit=137 oom=true probe=error/-/2ms load1=unknown");
  });

  test("허용 목록 밖 값·원문은 내지 않는다", () => {
    const line = formatStackSnapshot({
      state: { Status: SECRET, ExitCode: -1, OOMKilled: "yes", Health: { Status: SECRET, Log: [{ Output: SECRET }] }, Error: SECRET },
      probe: { result: SECRET, status: 99999, ms: -5 },
      load1: Number.NaN,
    });
    assert.equal(line, "진단 app=unknown/none exit=unknown oom=unknown probe=unknown/-/- load1=unknown");
    for (const word of ["secret", "postgres", "@", "SELECT"]) assert.ok(!line.includes(word), word);
  });

  test("값이 없어도 던지지 않는다", () => {
    assert.equal(formatStackSnapshot(), "진단 app=unknown/none exit=unknown oom=unknown probe=unknown/-/- load1=unknown");
  });
});
