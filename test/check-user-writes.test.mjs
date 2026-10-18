// M6.T2 전용 시험. 기존 고정 통과 수가 있는 시험 파일은 변경하지 않는다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { scan, compare } from "../scripts/check-user-writes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/check-user-writes.mjs");
const FIXTURES = path.join(ROOT, "test/fixtures/user-writes");
const EMPTY = path.join(FIXTURES, "empty.allow.json");
const fixture = (name) => path.join(FIXTURES, name);
const get = (name) => scan(fixture(name));
const row = (fn, operation, columns, table = "USER", sqlTable) => ({ file: "apps/server/src/write.ts", function: fn, operation, table, columns: [...columns].sort(), ...(sqlTable ? { sqlTable } : {}) });
const sorted = (rows) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const allow = (rows) => rows.map((s) => ({ ...s, reason: "시험에서 명시한 정확한 쓰기 자리만 허용한다." }));
function cli(name, file = EMPTY) {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", fixture(name), "--allow", file], { encoding: "utf8" });
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null);
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
function unauthorized(name, expected) {
  assert.deepEqual(get(name), sorted(expected));
  const r = cli(name);
  assert.equal(r.status, 1, r.out); // 실행 오류(2)는 검출 성공으로 세지 않는다.
  assert.match(r.out, /UNAUTHORIZED/);
  assert.match(r.out, /apps\/server\/src\/write\.ts#/);
  assert.doesNotMatch(r.out, /never-print-this-secret|not-logged/);
}

test("TC-M6.T2.a 운영 쓰기와 명시 허용 목록이 정확히 일치한다", () => {
  const entries = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/user-writes.allow.json"), "utf8"));
  const sites = scan(ROOT);
  assert.ok(sites.some((s) => s.table === "USER"));
  assert.ok(sites.some((s) => s.table === "UNKNOWN"));
  assert.deepEqual(compare(sites, entries), []);
  const r = spawnSync(process.execPath, [SCRIPT, "--root", ROOT], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /USER .*#runSetup insert/);
  assert.match(r.stdout, /UNKNOWN .*#upsert/);
});

test("TC-M6.T2.b 별칭·괄호·schema 문자열 접근을 검출한다", () => {
  unauthorized("alias", [row("alias", "insert", ["email"]), row("alias", "update", ["status"]), row("alias", "delete", [])]);
});

test("TC-M6.T2.c 구조 분해와 schema 별칭을 추적하고 account는 제외한다", () => {
  unauthorized("destructure", [row("destructure", "update", ["emailVerified"]), row("destructure", "insert", ["name"])]);
});

test("TC-M6.T2.d 상대경로 재내보내기 한 단계를 추적한다", () => {
  unauthorized("reexport", [row("reexport", "delete", [])]);
});

test("TC-M6.T2.e SQL tag의 세 쓰기와 칼럼 보간을 검출한다", () => {
  unauthorized("sqlTemplate", [row("raw", "sql:update", ["email", "status"]), row("raw", "sql:insert", ["email", "name"]), row("raw", "sql:delete", []), row("interpolatedColumn", "sql:update", ["emailVerified", "updatedAt"])]);
});

test("TC-M6.T2.f 같은 이름·블록 스코프·다른 표·type import는 user 쓰기가 아니다", () => {
  assert.deepEqual(get("shadow"), []);
  const r = cli("shadow");
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out, "");
});

test("TC-M6.T2.g 생성 스키마의 직접 named·namespace import를 추적한다", () => {
  unauthorized("direct-import", [row("direct", "insert", ["email"]), row("direct", "delete", [])]);
});

test("TC-M6.T2.h 동적·재할당은 UNKNOWN이고 고정 user SQL도 검출한다", () => {
  unauthorized("dynamic", [row("dynamic", "insert", ["email"], "UNKNOWN"), row("dynamic", "update", ["name"], "UNKNOWN"), row("dynamic", "delete", [], "UNKNOWN"), row("dynamic", "sql:delete", [], "UNKNOWN"), row("reassigned", "delete", [], "UNKNOWN"), row("rawLiteral", "sql:update", ["email"], "USER", "user")]);
});

test("TC-M6.T2.i 사라진 허용 자리는 STALE로 실패한다", () => {
  assert.deepEqual(get("stale"), []);
  const r = cli("stale", path.join(fixture("stale"), "allow.json"));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /STALE USER apps\/server\/src\/clean\.ts#removedWriter update \[name\]/);
});

test("TC-M6.T2.j 함수식·객체 메서드·클래스 메서드를 독립 식별한다", () => {
  unauthorized("functions", [row("handlers.method", "update", ["status"]), row("handlers.arrow", "insert", ["name"]), row("Writer.method", "delete", [])]);
});

test("TC-M6.T2.k root·allow 옵션으로 정확한 정상 픽스처를 허용한다", () => {
  const r = cli("alias", path.join(fixture("alias"), "allow.json"));
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /UNAUTHORIZED|COLUMNS|STALE/);
  assert.match(r.out, /USER apps\/server\/src\/write\.ts#alias insert \[email\]/);
});

test("TC-M6.T2.l 허용된 함수라도 칼럼을 넓히면 실패한다", () => {
  const rows = get("alias");
  const entries = allow(rows).map((a) => a.operation === "update" ? { ...a, columns: ["name"] } : a);
  assert.deepEqual(compare(rows, entries), [{ kind: "COLUMNS", ...rows.find((s) => s.operation === "update") }]);
});

test("TC-M6.T2.m 디렉터리 와일드카드·중복·근거 없는 허용은 설정 오류다", () => {
  const entries = allow(get("alias"));
  assert.throws(() => compare([], [{ ...entries[0], file: "apps/server/src/admin/**" }]), /invalid allow/);
  assert.throws(() => compare([], [...entries, entries[0]]), /invalid allow/);
  assert.throws(() => compare([], [{ ...entries[0], reason: "" }]), /invalid allow/);
});

test("TC-M6.T2.n UNKNOWN은 USER 허용으로 통과할 수 없다", () => {
  const rows = get("dynamic").filter((s) => s.table === "UNKNOWN");
  assert.ok(rows.length > 0);
  const failures = compare(rows, allow(rows).map((a) => ({ ...a, table: "USER" })));
  assert.equal(failures.filter((f) => f.kind === "UNAUTHORIZED").length, rows.length);
  assert.equal(failures.filter((f) => f.kind === "STALE").length, rows.length);
});

test("TC-M6.T2.o 소스가 없는 root는 초록 대신 설정 오류다", () => {
  const r = cli("missing-root");
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /검사 설정/);
  assert.doesNotMatch(r.out, /ENOENT|stack|at main/);
});

test("TC-M6.T2.p 객체 별칭·spread·후속 대입·upsert 칼럼을 합친다", () => {
  unauthorized("columns", [row("bounded", "update", ["email", "name"]), row("bounded", "insert", ["name", "role"])]);
});

test("TC-M6.T2.q 재내보내기 두 단계는 미지원 UNKNOWN으로 구분한다", () => {
  unauthorized("deep-export", [row("deeper", "delete", [], "UNKNOWN")]);
});

test("TC-M6.T2.r 고정 SQL의 표 이름·연산·칼럼을 보존한다", () => {
  unauthorized("fixed-sql", [row("reserveSlot", "sql:insert", ["id", "user_id", "omniroute_key_id", "key_preview", "label", "state", "disabled_reason", "sync_state", "created_at"], "UNKNOWN", "api_keys"), row("fixedUser", "sql:update", ["email"], "USER", "user")]);
  const rows = get("fixed-sql");
  const entries = allow(rows.filter((s) => s.function === "reserveSlot"));
  assert.deepEqual(compare(rows, entries), [{ kind: "UNAUTHORIZED", ...rows.find((s) => s.function === "fixedUser") }]);
});

test("TC-M6.T2.s 쓰지 않는 민감 칼럼이 허용에 남아도 실패한다", () => {
  assert.deepEqual(get("stale-columns"), [row("narrow", "update", ["name"])]);
  const r = cli("stale-columns", path.join(fixture("stale-columns"), "allow.json"));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /COLUMNS USER .*#narrow update \[name\]/);
  const rows = get("columns");
  assert.deepEqual(compare(rows, allow(rows).map((a) => ({ ...a, columns: [...a.columns].reverse().concat(a.columns) }))), []);
});

test("TC-M6.T2.t 같은 함수·연산·칼럼이어도 다른 고정 표 허용을 빌릴 수 없다", () => {
  const expected = [row("same", "sql:insert", ["id"], "UNKNOWN", "api_keys"), row("same", "sql:insert", ["id"], "USER", "user"), row("same", "sql:insert", ["id"], "UNKNOWN", "audit_log")];
  unauthorized("table-identity", expected);
  const rows = get("table-identity"), permitted = rows.find((s) => s.sqlTable === "api_keys");
  const r = cli("table-identity", path.join(fixture("table-identity"), "allow.json"));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /UNAUTHORIZED USER .*sql:insert table=user/);
  assert.match(r.out, /UNAUTHORIZED UNKNOWN .*sql:insert table=audit_log/);
  for (const replacement of rows.filter((s) => s.sqlTable !== "api_keys")) {
    assert.deepEqual(compare([replacement], allow([permitted])), [{ kind: "UNAUTHORIZED", ...replacement }, { kind: "STALE", ...permitted }]);
  }
  // 무명 UNKNOWN도 이름이 명시된 api_keys 허용과 합쳐지지 않는다.
  const { sqlTable, ...unnamed } = permitted;
  assert.deepEqual(compare([unnamed], allow([permitted])), [{ kind: "UNAUTHORIZED", ...unnamed }, { kind: "STALE", ...permitted }]);
});

test("TC-M6.T2.u 인용·대소문자·한정 표 이름을 보존하고 미지원 구문은 무명 UNKNOWN이다", () => {
  unauthorized("qualified-sql", [row("quoted", "sql:update", ["email"], "USER", '"User"'), row("quoted", "sql:insert", ["id"], "USER", '"public"."user"'), row("quoted", "sql:delete", [], "USER", "`tenant`.`user`"), row("qualified", "sql:insert", ["id"], "UNKNOWN", "public.api_keys"), row("qualified", "sql:update", ["name"], "USER", "tenant.USER"), row("unsupported", "sql:dynamic", ["?"], "UNKNOWN")]);
  const rows = get("qualified-sql"), quoted = rows.find((s) => s.sqlTable === '"User"');
  const changed = { ...quoted, sqlTable: "user" };
  assert.deepEqual(compare([changed], allow([quoted])), [{ kind: "UNAUTHORIZED", ...changed }, { kind: "STALE", ...quoted }]);
});
