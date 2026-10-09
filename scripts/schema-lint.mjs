#!/usr/bin/env node
// 생성된 Drizzle 스키마가 네 DB 공통 작성 규칙(계획서 3.2 "DB 지원 원칙")을 지키는지 세어 본다.
//
//   node scripts/schema-lint.mjs                                   packages/db/src/schema/{sqlite,mysql,pg}.ts, 위반 0 이어야 통과
//   node scripts/schema-lint.mjs --fixture <file> --expect <n>     파일 하나의 위반 수가 정확히 n 이어야 통과 (음성 대조)
//
// 규칙 (칼럼마다 규칙 하나당 위반 1)
//   R1 길이 없는 문자열 기본 키·고유 키·인덱스 (mysql·pg): text 칼럼에 primaryKey·unique·index
//      — MySQL 은 길이 없는 TEXT 에 기본 키·인덱스를 못 건다. SQLite 는 길이가 없어 제외
//   R2 id 칼럼이 VARCHAR(36) 이 아님 (mysql)
//   R3 금액 칼럼(*_usd)이 DECIMAL(12,6) 이 아님 (mysql·pg), 실수가 아님 (sqlite)
//   R4 DB 전용 JSON 칼럼 타입: json()·jsonb(), text/blob 의 mode: "json"
// 생성기는 칼럼 하나를 한 줄에 쓴다. 이 검사기도 그 모양을 읽는다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = ["sqlite", "mysql", "pg"].map((d) => path.join(ROOT, "packages/db/src/schema", `${d}.ts`));

const DIALECT_BY_MODULE = { "drizzle-orm/sqlite-core": "sqlite", "drizzle-orm/mysql-core": "mysql", "drizzle-orm/pg-core": "pg" };
const TABLE_FN = /export const (\w+) = (?:sqliteTable|mysqlTable|pgTable)\("([^"]+)"/;
const COLUMN = /^\s*(\w+):\s*(\w+)\("([^"]+)"(?:,\s*(\{[^}]*\}))?\)(.*?),?\s*$/;
const INDEX = /\b(?:unique)?[iI]ndex\("[^"]*"\)\.on\(([^)]*)\)/;

function lint(file) {
  const src = fs.readFileSync(file, "utf8");
  const mod = /from "(drizzle-orm\/(?:sqlite|mysql|pg)-core)"/.exec(src)?.[1];
  const dialect = DIALECT_BY_MODULE[mod];
  if (!dialect) throw new Error(`${file}: drizzle 방언 import 를 찾지 못함`);

  const tables = [];
  let cur = null;
  for (const line of src.split("\n")) {
    const t = TABLE_FN.exec(line);
    if (t) {
      cur = { name: t[2], columns: new Map(), indexed: new Set() };
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
    for (const c of t.columns.values()) {
      const keyed = /\.primaryKey\(\)/.test(c.chain) || /\.unique\(\)/.test(c.chain) || t.indexed.has(c.key);
      if (dialect !== "sqlite" && c.fn === "text" && keyed) add(t, c, "R1", "길이 없는 문자열에 기본 키·고유 키·인덱스");
      if (dialect === "mysql" && c.name === "id" && !(c.fn === "varchar" && /length:\s*36\b/.test(c.opts))) add(t, c, "R2", "id 가 VARCHAR(36) 이 아님");
      if (c.name.endsWith("_usd")) {
        const ok = dialect === "sqlite"
          ? c.fn === "real"
          : (c.fn === "decimal" || c.fn === "numeric") && /precision:\s*12\b/.test(c.opts) && /scale:\s*6\b/.test(c.opts);
        if (!ok) add(t, c, "R3", dialect === "sqlite" ? "금액이 실수가 아님" : "금액이 DECIMAL(12,6) 이 아님");
      }
      if (c.fn === "json" || c.fn === "jsonb" || /mode:\s*["']json["']/.test(c.opts)) add(t, c, "R4", "DB 전용 JSON 칼럼 타입");
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
