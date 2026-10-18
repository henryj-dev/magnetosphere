// 회원 E2E 진단 도우미 (M5). 불러와도 아무것도 실행하지 않는다 (diagnostics.test.mjs 가 오프라인으로 검사한다).
//   - 자식 프로세스 실패는 고정 코드(시간 초과·종료 번호)로만 바꾼다. stdout·stderr 원문은 돌려주지 않는다.
//   - DB 읽기 스크립트는 단계 marker(MGT <단계> <ms>)만 stderr 에 낸다. 부모는 그 형식의 줄만 읽어 멈춘 단계를 고른다.
//   - 묶음 정리가 실패하면 시험 폴더를 지우지 않고, 프로젝트 이름·폴더 경로만 담은 manifest 를 남긴다.
import fs from "node:fs";
import path from "node:path";

/** 시간 초과면 <prefix>_TIMEOUT, 아니면 <prefix>_EXIT_<0~255> (그 밖의 값은 UNKNOWN) */
export function commandFailureCode(prefix, r) {
  if (r?.timedOut) return `${prefix}_TIMEOUT`;
  const n = r?.code;
  return `${prefix}_EXIT_${Number.isInteger(n) && n >= 0 && n < 256 ? n : "UNKNOWN"}`;
}

/** DB 읽기 단계 (스크립트에서 이 순서로 찍힌다) */
export const READ_STAGES = ["start", "import", "connect", "query", "close"];
const MARKER = /^MGT (start|import|connect|query|close) \d+$/;

/** stderr 에서 marker 줄만 읽어 마지막으로 지난 단계를 돌려준다. marker 가 없으면 "boot" */
export function lastReadStage(stderr) {
  let last = -1;
  for (const line of String(stderr ?? "").split("\n")) {
    const m = MARKER.exec(line.replace(/\r$/, ""));
    if (m) last = Math.max(last, READ_STAGES.indexOf(m[1]));
  }
  return last < 0 ? "boot" : READ_STAGES[last];
}

/** 시간 초과된 DB 읽기의 고정 진단 코드 E_DB_READ_TIMEOUT_AT_<BOOT|START|IMPORT|CONNECT|QUERY|CLOSE> */
export const dbReadTimeoutCode = (stderr) => `E_DB_READ_TIMEOUT_AT_${lastReadStage(stderr).toUpperCase()}`;

/** DB 읽기 종류와 각 종류가 바인딩하는 op 필드 (이 밖의 kind 는 import 전에 거부한다) */
export const READ_OPS = Object.freeze({ userCount: [], auditCount: ["action"], counter: ["key"], user: ["email"] });

const USER_COLS = "email, role, status, monthly_limit_usd, is_bootstrap_admin, email_verified";
/**
 * 방언별 고정 SELECT (packages/db/src/schema/{sqlite,mysql,pg}.ts 의 표·열 이름). 값은 모두 자리표시자로 바인딩한다.
 * user·key 는 MySQL 예약어라 백틱, SQLite·Postgres 는 큰따옴표로 감싼다.
 * WHERE 로 범위를 좁힌 뒤 스크립트가 JS 의 === 로 한 번 더 거른다 (MySQL 기본 정렬의 대소문자 무시 비교와 상관없이 전과 같은 정확 일치).
 */
export const READ_SQL = Object.freeze({
  sqlite: {
    userCount: 'SELECT count(*) AS n FROM "user"',
    auditCount: "SELECT action FROM audit_log WHERE action = ?",
    counter: 'SELECT "key", "count" FROM rate_limit WHERE "key" = ?',
    user: `SELECT ${USER_COLS} FROM "user" WHERE email = ?`,
  },
  mysql: {
    userCount: "SELECT count(*) AS n FROM `user`",
    auditCount: "SELECT action FROM audit_log WHERE action = ?",
    counter: "SELECT `key`, `count` FROM rate_limit WHERE `key` = ?",
    user: `SELECT ${USER_COLS} FROM \`user\` WHERE email = ?`,
  },
  pg: {
    userCount: 'SELECT count(*) AS n FROM "user"',
    auditCount: "SELECT action FROM audit_log WHERE action = $1",
    counter: 'SELECT "key", "count" FROM rate_limit WHERE "key" = $1',
    user: `SELECT ${USER_COLS} FROM "user" WHERE email = $1`,
  },
});

/** DB 읽기 스크립트의 고정 종료 번호. 먼저 난 오류의 번호를 남긴다 (close 오류는 앞 오류를 덮지 않는다) */
export const READ_EXIT = Object.freeze({ op: 3, url: 4, driver: 5, connect: 6, query: 7, close: 8 });
const READ_EXIT_NAMES = Object.fromEntries(Object.entries(READ_EXIT).map(([k, v]) => [v, k.toUpperCase()]));

/** 시간 초과가 아닌 DB 읽기 실패의 고정 코드: E_DB_READ_<OP|URL|DRIVER|CONNECT|QUERY|CLOSE>, 그 밖은 E_DB_READ_EXIT_<n|UNKNOWN> */
export function dbReadFailureCode(r) {
  const name = r?.timedOut ? undefined : READ_EXIT_NAMES[r?.code];
  return name ? `E_DB_READ_${name}` : commandFailureCode("E_DB_READ", r);
}

/**
 * 회원 앱 DB 읽기 (SELECT 만). stdin 으로 넘겨 apps/server 폴더에서 돈다. 결과는 "@@<JSON>" 한 줄이다.
 * 첫 문장이 start marker 다. 드라이버는 그 뒤에 불러 import 시간도 따로 보인다.
 * marker 에는 단계 이름과 프로세스 시작 뒤 ms 만 넣는다 (값·주소·이메일·SQL 을 넣지 않는다).
 *
 * @magnetosphere/runtime/node 를 불러오지 않는다. 그 모듈은 Hono 서버·Better Auth 까지 끌어와 Docker 에서 import 만으로 5초를 넘겼다
 * (E_DB_READ_TIMEOUT_AT_START). 대신 DATABASE_URL 형식(connectNode 와 같은 규칙)에 맞는 SQL 드라이버 하나만,
 * runtime 이 쓰는 그 패키지(packages/runtime 의 의존성: @libsql/client·mysql2·postgres, 운영 이미지에도 설치됨)에서 불러온다.
 *   - runtime 의 SQLite 쓰기 차례(serializeSqliteWrites)를 거치지 않는다. 이 스크립트는 고정 SELECT 만 보내고 쓰지 않으므로 차례가 필요 없다.
 *   - 시험 fixture 를 읽는 용도다. 앱의 보호 함수를 대신 부르는 프록시가 아니고, 권한 검사를 우회해 앱 상태를 바꾸는 데 쓰지 않는다.
 *   - kind 는 READ_OPS 목록만 받는다. op 값(action·key·email)은 SQL 문자열에 넣지 않고 바인딩한다.
 *   - 비밀 열(비밀번호·토큰)은 고르지 않는다. 결과에는 수·권한 필드만 담는다 (이메일·키도 내지 않는다).
 *   - 연결은 하나만 쓴다 (mysql2 단일 연결, postgres max 1). 연결 대기 상한은 4초, 전체 상한은 부모의 5초다.
 *   - 실패는 고정 종료 번호(READ_EXIT)로만 알린다. 오류 원문·stack 을 쓰지 않는다.
 * 읽은 값의 뜻은 전 drizzle 질의와 같다: 수는 Number(), 금액은 null 또는 Number(), boolean 열은 !! (MySQL tinyint 0/1·SQLite 0/1·Postgres boolean).
 * 시각 열은 읽지 않는다 (MySQL timezone "Z"·Postgres TimeZone UTC 는 connectNode 와 맞춰 둔 것뿐이다).
 */
export const READ_SCRIPT = `
const mark = (stage) => process.stderr.write("\\nMGT " + stage + " " + Math.round(performance.now()) + "\\n");
mark("start");
const OPS = ${JSON.stringify(READ_OPS)};
const SQL = ${JSON.stringify(READ_SQL)};
const EXIT = ${JSON.stringify(READ_EXIT)};
let stage = EXIT.op, code = 0, out = null, close = null;
try {
  let op = null;
  try { op = JSON.parse(process.env.MG_E2E_OP ?? ""); } catch {}
  const kind = op?.kind;
  if (typeof kind !== "string" || !Object.hasOwn(OPS, kind) || !OPS[kind].every((f) => typeof op[f] === "string")) throw 0;
  stage = EXIT.url;
  const url = String(process.env.MG_E2E_DB || process.env.DATABASE_URL || "");
  const scheme = url.slice(0, Math.max(0, url.indexOf(":"))).toLowerCase();
  const dialect = scheme === "file" || scheme === "libsql" ? "sqlite" : scheme === "mysql" || scheme === "mariadb" ? "mysql" : scheme === "postgres" || scheme === "postgresql" ? "pg" : null;
  if (!dialect) throw 0;
  stage = EXIT.driver;
  const { createRequire } = process.getBuiltinModule("node:module");
  const { resolve } = process.getBuiltinModule("node:path");
  const driver = createRequire(resolve(process.cwd(), "../../packages/runtime/package.json"))({ sqlite: "@libsql/client", mysql: "mysql2/promise", pg: "postgres" }[dialect]);
  mark("import");
  stage = EXIT.connect;
  let all;
  if (dialect === "sqlite") {
    const client = driver.createClient({ url });
    close = () => client.close();
    all = async (q, args) => (await client.execute({ sql: q, args })).rows;
  } else if (dialect === "mysql") {
    const conn = await driver.createConnection({ uri: url.replace(/^mariadb:/i, "mysql:"), timezone: "Z", connectTimeout: 4000 });
    close = () => conn.end();
    all = async (q, args) => (await conn.execute(q, args))[0];
  } else {
    const sql = driver(url, { connection: { TimeZone: "UTC" }, max: 1, connect_timeout: 4, onnotice: () => {} });
    close = () => sql.end({ timeout: 1 });
    all = (q, args) => sql.unsafe(q, args);
  }
  mark("connect");
  stage = EXIT.query;
  const rows = await all(SQL[dialect][kind], OPS[kind].map((f) => op[f]));
  if (kind === "userCount") out = Number(rows[0].n);
  else if (kind === "auditCount") out = rows.filter((r) => r.action === op.action).length;
  else if (kind === "counter") {
    const row = rows.find((r) => r.key === op.key);
    out = row ? Number(row.count) : null;
  } else {
    const row = rows.find((r) => r.email === op.email);
    out = row ? { role: row.role, status: row.status, monthlyLimitUsd: row.monthly_limit_usd == null ? null : Number(row.monthly_limit_usd), isBootstrapAdmin: !!row.is_bootstrap_admin, emailVerified: !!row.email_verified } : null;
  }
  mark("query");
} catch {
  code = stage;
}
if (close) {
  try { await close(); } catch { if (!code) code = EXIT.close; }
  mark("close");
}
if (code) process.exitCode = code;
else process.stdout.write("\\n@@" + JSON.stringify(out) + "\\n");
`;

/** 이 시험이 만든 묶음 폴더인지 본다: tmpRoot 바로 아래, 이름이 mg-e2e- 로 시작, 심볼릭 링크가 아닌 폴더 */
export function ownedStackDir(dir, tmpRoot) {
  if (typeof dir !== "string" || !dir) return false;
  const abs = path.resolve(dir);
  if (path.dirname(abs) !== path.resolve(tmpRoot) || !/^mg-e2e-[A-Za-z0-9]+$/.test(path.basename(abs))) return false;
  try {
    const st = fs.lstatSync(abs);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** 폴더가 이 사용자만 읽고 쓸 수 있게(0700) 맞추고 확인한다. 실패하면 false */
export function ensurePrivateDir(dir) {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === "function" && st.uid !== process.getuid())) return false;
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    return (fs.lstatSync(dir).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * 정리 실패 때 남길 manifest (manifestRoot/<project>.json, 0600). 프로젝트 이름·폴더 경로만 담는다 (.env 내용을 담지 않는다).
 * 돌려주는 값은 고정 코드 하나다: E_CLEANUP_STACK_KEPT (남김) 또는 E_CLEANUP_MANIFEST (남기지 못함).
 */
export function keepStackForCleanup(stack, manifestRoot) {
  try {
    if (!/^mg-e2e-[a-z]+-[0-9a-f]+$/.test(String(stack?.project)) || !ensurePrivateDir(stack.dir)) return "E_CLEANUP_MANIFEST";
    fs.mkdirSync(manifestRoot, { recursive: true, mode: 0o700 });
    if (!ensurePrivateDir(manifestRoot)) return "E_CLEANUP_MANIFEST";
    const file = path.join(manifestRoot, `${stack.project}.json`);
    fs.writeFileSync(file, JSON.stringify({ project: stack.project, dir: path.resolve(stack.dir) }) + "\n", { mode: 0o600, flag: "w" });
    fs.chmodSync(file, 0o600);
    return "E_CLEANUP_STACK_KEPT";
  } catch {
    return "E_CLEANUP_MANIFEST";
  }
}

// ---------- 실패 시점 묶음 상태 (원인 구분용) ----------
// 실패한 뒤·정리하기 전에 한 줄만 남긴다: app 컨테이너 상태, 짧은 상태 확인 요청의 결과, 호스트 1분 부하.
// "앱이 멈췄는지(probe 시간 초과·exited)" 와 "장비가 바빠 늦었는지(probe 200·부하 높음)" 를 가르기 위한 것이다.
// 값은 아래 허용 목록·숫자로만 만든다. 컨테이너 이름·주소·로그·오류 원문은 넣지 않는다.
const SNAPSHOT_STATUS = new Set(["created", "running", "paused", "restarting", "removing", "exited", "dead"]);
const SNAPSHOT_HEALTH = new Set(["healthy", "unhealthy", "starting"]);
const SNAPSHOT_PROBE = new Set(["ok", "timeout", "error"]);
const intIn = (n, lo, hi) => (Number.isInteger(n) && n >= lo && n <= hi ? n : null);

/**
 * @param {{ state?: any, probe?: { result?: string, status?: number, ms?: number }, load1?: number }} s
 *   state 는 docker inspect 의 .State JSON (Status·ExitCode·OOMKilled·Health.Status 만 읽는다)
 * @returns {string} 예: "진단 app=running/healthy exit=0 oom=false probe=ok/200/35ms load1=14.2"
 */
export function formatStackSnapshot({ state, probe, load1 } = {}) {
  const status = SNAPSHOT_STATUS.has(state?.Status) ? state.Status : "unknown";
  const health = SNAPSHOT_HEALTH.has(state?.Health?.Status) ? state.Health.Status : "none";
  const exit = intIn(state?.ExitCode, 0, 255) ?? "unknown";
  const oom = typeof state?.OOMKilled === "boolean" ? String(state.OOMKilled) : "unknown";
  const result = SNAPSHOT_PROBE.has(probe?.result) ? probe.result : "unknown";
  const code = intIn(probe?.status, 100, 599) ?? "-";
  const ms = intIn(Math.round(probe?.ms ?? NaN), 0, 600_000);
  const load = Number.isFinite(load1) && load1 >= 0 && load1 < 10_000 ? load1.toFixed(1) : "unknown";
  return `진단 app=${status}/${health} exit=${exit} oom=${oom} probe=${result}/${code}/${ms === null ? "-" : `${ms}ms`} load1=${load}`;
}
