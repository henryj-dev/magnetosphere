#!/usr/bin/env node
// 생성된 Drizzle 스키마가 네 DB 공통 작성 규칙(계획서 3.2 "DB 지원 원칙")을 지키는지 세어 본다.
//
//   node scripts/schema-lint.mjs                                   packages/db/src/schema/{sqlite,mysql,pg}.ts, 위반 0 이어야 통과
//   node scripts/schema-lint.mjs --fixture <file> --expect <n>     파일 하나의 위반 수가 정확히 n 이어야 통과 (음성 대조)
//
// 규칙 (칼럼마다 규칙 하나당 위반 1)
//   R1 길이 없는 문자열 기본 키·고유 키·인덱스·외래 키 (mysql·pg): text 계열 칼럼에 primaryKey·unique·index·references
//      — MySQL 은 길이 없는 TEXT 에 기본 키·인덱스를 못 건다. SQLite 는 길이가 없어 제외
//   R2 id 칼럼이 VARCHAR(36) 이 아님 (mysql)
//   R3 금액 칼럼(*_usd)이 DECIMAL(12,6) 이 아님 (mysql·pg), 실수가 아님 (sqlite)
//   R4 DB 전용 JSON 칼럼 타입: json()·jsonb(), text/blob 의 mode: "json"
//   R5 MySQL 인덱스 바이트 한도 초과: 키 칼럼 varchar 길이 × 4(utf8mb4) > 3072
//   R6 DB 현재 시각 기본값: .defaultNow(), .default(sql`... now() / unixepoch / current_timestamp ...`)
//      — DB now() 는 세션 시간대를 따르는데 Hyperdrive 가 세션 시간대 설정을 지키는지 알 수 없다. 앱 $defaultFn 을 쓴다 (TC-S6.T3.c)
// 방언은 테이블 함수(sqliteTable·mysqlTable·pgTable)로 테이블마다 정한다.
// 생성기는 칼럼 하나를 한 줄에 쓴다. 이 검사기도 그 모양을 읽는다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = ["sqlite", "mysql", "pg"].map((d) => path.join(ROOT, "packages/db/src/schema", `${d}.ts`));

const DIALECT_BY_TABLE_FN = { sqliteTable: "sqlite", mysqlTable: "mysql", pgTable: "pg" };
// 이름공간 import(pg.text(...))도 읽는다.
const TABLE_FN = /export const (\w+) = (?:\w+\.)?(sqliteTable|mysqlTable|pgTable)\("([^"]+)"/;
const MYSQL_INDEX_BYTES = 3072;
const COLUMN = /^\s*(\w+):\s*(?:\w+\.)?(\w+)\("([^"]+)"(?:,\s*(\{[^}]*\}))?\)(.*?),?\s*$/;
const INDEX = /\b(?:unique)?[iI]ndex\("[^"]*"\)\.on\(([^)]*)\)/;

function lint(file) {
  const src = fs.readFileSync(file, "utf8");
  const tables = [];
  let cur = null;
  for (const line of src.split("\n")) {
    const t = TABLE_FN.exec(line);
    if (t) {
      cur = { name: t[3], dialect: DIALECT_BY_TABLE_FN[t[2]], columns: new Map(), indexed: new Set() };
      tables.push(cur);
      continue;
    }
    if (!cur) continue;
    const idx = INDEX.exec(line);
    if (idx) {
      for (const ref of idx[1].split(",")) cur.indexed.add(ref.trim().replace(/^table\./, ""));
      continue;
    }
    const c = COLUMN.exec(line);
    if (c) cur.columns.set(c[1], { key: c[1], fn: c[2], name: c[3], opts: c[4] ?? "", chain: c[5] });
  }
  if (tables.length === 0 || tables.every((t) => t.columns.size === 0)) throw new Error(`${file}: 테이블·칼럼을 하나도 읽지 못함`);

  const violations = [];
  const add = (t, c, rule, msg) => violations.push(`${path.relative(ROOT, file)}: ${t.name}.${c.name} ${rule} ${msg}`);
  for (const t of tables) {
    const dialect = t.dialect;
    for (const c of t.columns.values()) {
      const keyed = /\.(primaryKey|unique|references)\(/.test(c.chain) || t.indexed.has(c.key);
      if (dialect !== "sqlite" && /^text/.test(c.fn) && keyed) add(t, c, "R1", "길이 없는 문자열에 기본 키·고유 키·인덱스·외래 키");
      const len = Number(/length:\s*(\d+)/.exec(c.opts)?.[1]);
      if (dialect === "mysql" && /^varchar/.test(c.fn) && keyed && len * 4 > MYSQL_INDEX_BYTES) add(t, c, "R5", `키 칼럼 varchar(${len}) 가 인덱스 한도 ${MYSQL_INDEX_BYTES}바이트를 넘음`);
      if (dialect === "mysql" && c.name === "id" && !(c.fn === "varchar" && /length:\s*36\b/.test(c.opts))) add(t, c, "R2", "id 가 VARCHAR(36) 이 아님");
      if (c.name.endsWith("_usd")) {
        const ok = dialect === "sqlite"
          ? c.fn === "real"
          : (c.fn === "decimal" || c.fn === "numeric") && /precision:\s*12\b/.test(c.opts) && /scale:\s*6\b/.test(c.opts);
        if (!ok) add(t, c, "R3", dialect === "sqlite" ? "금액이 실수가 아님" : "금액이 DECIMAL(12,6) 이 아님");
      }
      if (c.fn === "json" || c.fn === "jsonb" || /mode:\s*["']json["']/.test(c.opts)) add(t, c, "R4", "DB 전용 JSON 칼럼 타입");
      if (/\.defaultNow\(\)|\.default\(sql`[^`]*(now\(|unixepoch|current_timestamp)/i.test(c.chain)) add(t, c, "R6", "DB 현재 시각 기본값 (앱 $defaultFn 을 쓴다)");
    }
  }
  return violations;
}

const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fixture = opt("--fixture");
const expect = opt("--expect");

try {
  if (fixture !== undefined) {
    if (expect === undefined || !/^\d+$/.test(expect)) throw new Error("--fixture 에는 --expect <수> 가 필요하다");
    const v = lint(path.resolve(fixture));
    for (const x of v) console.log(`  ${x}`);
    console.log(`위반 ${v.length} (기대 ${expect})`);
    process.exit(v.length === Number(expect) ? 0 : 1);
  }
  const v = GENERATED.flatMap(lint);
  for (const x of v) console.log(`  ${x}`);
  console.log(`위반 ${v.length} (스키마 ${GENERATED.length}벌)`);
  process.exit(v.length === 0 ? 0 : 1);
} catch (e) {
  console.error(`schema-lint: ${e.message}`);
  process.exit(2);
}
