// 공통 스키마 정의(src/schema/common.ts) 하나에서 sqlite·mysql·pg Drizzle 스키마 세 벌을 만든다.
// D1 은 sqlite 를 같이 쓴다. 생성 전에 Better Auth 테이블이 Better Auth 1.7.7 이 AUTH_SCHEMA_OPTIONS
// (src/auth-options.ts, Better Auth 구성과 같은 객체)로 기대하는 칼럼과 맞는지 검사하고, 어긋나면 아무것도 쓰지 않고 실패한다.
//
//   node scripts/gen-schema.mjs          (packages/db 에서, pnpm -C packages/db gen)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAuthTables } from "better-auth/db";
import { TABLES } from "../src/schema/common.ts";
import { AUTH_SCHEMA_OPTIONS } from "../src/auth-options.ts";

const OUT = (dialect) => fileURLToPath(new URL(`../src/schema/${dialect}.ts`, import.meta.url));

// ---------- Better Auth 와 대조 ----------

// Better Auth 필드 타입마다 받아들이는 우리 칼럼 종류
const BA_KINDS = { string: ["id", "string", "text", "json"], number: ["integer", "bigint", "usd"], boolean: ["boolean"], date: ["timestamp"] };

function checkBetterAuth() {
  const problems = [];
  const ba = getAuthTables(AUTH_SCHEMA_OPTIONS);
  const ours = Object.entries(TABLES).filter(([, t]) => t.owner === "better-auth");
  for (const [key, t] of Object.values(ba).map((t) => [t.modelName, t])) {
    const mine = TABLES[key];
    if (!mine || mine.owner !== "better-auth") {
      problems.push(`Better Auth 테이블 ${key} 가 공통 정의에 없다`);
      continue;
    }
    for (const [field, f] of Object.entries(t.fields)) {
      const c = mine.columns[f.fieldName ?? field];
      const at = `${key}.${f.fieldName ?? field}`;
      if (!c) {
        problems.push(`${at}: 칼럼 없음`);
        continue;
      }
      if (!BA_KINDS[f.type]?.includes(c.kind)) problems.push(`${at}: Better Auth 타입 ${f.type} 와 칼럼 종류 ${c.kind} 가 맞지 않는다`);
      if (f.required && !c.notNull) problems.push(`${at}: Better Auth 는 필수인데 NULL 허용`);
      if (!f.required && c.notNull && c.default === undefined && !c.defaultNow) problems.push(`${at}: Better Auth 는 선택인데 기본값 없는 NOT NULL`);
      if (f.defaultValue !== undefined && typeof f.defaultValue !== "function" && f.defaultValue !== c.default) {
        problems.push(`${at}: 기본값 ${JSON.stringify(f.defaultValue)} ≠ ${JSON.stringify(c.default)}`);
      }
      if (!!f.unique !== !!c.unique) problems.push(`${at}: unique 불일치`);
      if (f.references) {
        const r = c.references;
        // onDelete 를 정하지 않은 참조는 Better Auth 생성기가 cascade 로 만든다. 같은 규칙을 따른다.
        if (!r || r.table !== f.references.model || r.column !== f.references.field || r.onDelete !== (f.references.onDelete ?? "cascade")) {
          problems.push(`${at}: 참조 불일치`);
        }
      }
    }
    for (const col of Object.keys(mine.columns)) {
      if (col !== "id" && !Object.entries(t.fields).some(([field, f]) => (f.fieldName ?? field) === col)) problems.push(`${key}.${col}: Better Auth 가 모르는 칼럼`);
    }
  }
  for (const [key] of ours) if (!Object.values(ba).some((t) => t.modelName === key)) problems.push(`${key}: Better Auth 가 쓰지 않는 테이블을 better-auth 소유로 표시함`);
  return problems;
}

// ---------- 방언별 코드 ----------

const lit = (v) => JSON.stringify(v);

// defaultNow 칼럼의 현재 시각은 DB now() 가 아니라 앱이 넣는다 (Drizzle $defaultFn). DB now() 는 세션 시간대를 따르는데
// Hyperdrive 가 세션 시간대 설정을 지키는지 로컬에서 확인할 수 없다 (TC-S6.T3.c). 그래서 DDL 에는 기본값이 없다.
const APP_NOW = { sql: false, code: ".$defaultFn(() => new Date())" };

const DIALECTS = {
  sqlite: {
    module: "drizzle-orm/sqlite-core",
    table: "sqliteTable",
    column(c) {
      switch (c.kind) {
        case "id": case "string": case "text": case "json": return ["text", `text(${lit(c.name)})`];
        case "integer": case "bigint": return ["integer", `integer(${lit(c.name)})`];
        case "boolean": return ["integer", `integer(${lit(c.name)}, { mode: "boolean" })`];
        case "timestamp": return ["integer", `integer(${lit(c.name)}, { mode: "timestamp_ms" })`];
        case "usd": return ["real", `real(${lit(c.name)})`];
      }
    },
    now: APP_NOW,
  },
  mysql: {
    module: "drizzle-orm/mysql-core",
    table: "mysqlTable",
    column(c) {
      switch (c.kind) {
        case "id": return ["varchar", `varchar(${lit(c.name)}, { length: 36 })`];
        case "string": return c.exact ? ["customType", `varcharBin(${lit(c.name)}, { length: ${c.length} })`] : ["varchar", `varchar(${lit(c.name)}, { length: ${c.length} })`];
        case "text": return c.exact ? ["customType", `textBin(${lit(c.name)})`] : ["text", `text(${lit(c.name)})`];
        case "json": return ["text", `text(${lit(c.name)})`];
        case "integer": return ["int", `int(${lit(c.name)})`];
        case "bigint": return ["bigint", `bigint(${lit(c.name)}, { mode: "number" })`];
        case "boolean": return ["boolean", `boolean(${lit(c.name)})`];
        case "timestamp": return ["datetime", `datetime(${lit(c.name)}, { fsp: 3 })`];
        case "usd": return ["decimal", `decimal(${lit(c.name)}, { precision: 12, scale: 6, mode: "number" })`];
      }
    },
    now: APP_NOW,
    // drizzle mysql-core 에는 칼럼 정렬 옵션이 없어 customType 으로 utf8mb4_bin 칼럼을 만든다.
    prelude: [
      "// 대소문자까지 정확히 같아야 하는 칼럼 (common.ts 의 exact). MySQL·MariaDB 기본 정렬은 대소문자를 무시한다.",
      "const varcharBin = customType<{ data: string; config: { length: number } }>({",
      "  dataType: (config) => `varchar(${config?.length}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,",
      "});",
      'const textBin = customType<{ data: string }>({ dataType: () => "text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin" });',
    ],
  },
  pg: {
    module: "drizzle-orm/pg-core",
    table: "pgTable",
    column(c) {
      switch (c.kind) {
        case "id": return ["varchar", `varchar(${lit(c.name)}, { length: 36 })`];
        case "string": return ["varchar", `varchar(${lit(c.name)}, { length: ${c.length} })`];
        case "text": case "json": return ["text", `text(${lit(c.name)})`];
        case "integer": return ["integer", `integer(${lit(c.name)})`];
        case "bigint": return ["bigint", `bigint(${lit(c.name)}, { mode: "number" })`];
        case "boolean": return ["boolean", `boolean(${lit(c.name)})`];
        case "timestamp": return ["timestamp", `timestamp(${lit(c.name)})`];
        case "usd": return ["numeric", `numeric(${lit(c.name)}, { precision: 12, scale: 6, mode: "number" })`];
      }
    },
    now: APP_NOW,
  },
};

const exportName = Object.fromEntries(Object.keys(TABLES).map((k) => [TABLES[k].name, k]));

function render(dialect) {
  const d = DIALECTS[dialect];
  const imports = new Set([d.table]);
  let usesSql = false;
  const blocks = [];
  for (const [key, t] of Object.entries(TABLES)) {
    const lines = [];
    for (const [field, c] of Object.entries(t.columns)) {
      if (c.kind === "string" && !Number.isInteger(c.length)) throw new Error(`${key}.${field}: string 칼럼에 length 가 없다`);
      if (c.exact && c.kind !== "string" && c.kind !== "text") throw new Error(`${key}.${field}: exact 는 string·text 칼럼에만 쓴다`);
      const [fn, base] = d.column(c);
      imports.add(fn);
      let code = base;
      if (c.primaryKey) code += ".primaryKey()";
      if (c.default !== undefined) code += `.default(${lit(c.default)})`;
      if (c.defaultNow) {
        code += d.now.code;
        usesSql ||= d.now.sql;
      }
      if (c.onUpdateNow) code += ".$onUpdate(() => new Date())";
      if (c.notNull && !c.primaryKey) code += ".notNull()";
      if (c.unique) code += ".unique()";
      if (c.references) {
        const r = c.references;
        const target = exportName[r.table] ?? r.table;
        const refField = Object.entries(TABLES[target].columns).find(([, rc]) => rc.name === r.column)[0];
        code += `.references(() => ${target}.${refField}${r.onDelete ? `, { onDelete: ${lit(r.onDelete)} }` : ""})`;
      }
      lines.push(`  ${field}: ${code},`);
    }
    let tail = "";
    if (t.indexes?.length) {
      imports.add("index");
      tail = `, (table) => [\n${t.indexes.map((i) => `  index(${lit(i.name)}).on(${i.columns.map((c) => `table.${c}`).join(", ")}),`).join("\n")}\n]`;
    }
    blocks.push(`// ${t.doc}\nexport const ${key} = ${d.table}(${lit(t.name)}, {\n${lines.join("\n")}\n}${tail});`);
  }
  const head = [
    "// 자동 생성 파일이다. 손으로 고치지 않는다.",
    "// 원본: packages/db/src/schema/common.ts · 생성: pnpm -C packages/db gen",
    ...(usesSql ? ['import { sql } from "drizzle-orm";'] : []),
    `import { ${[...imports].sort().join(", ")} } from "${d.module}";`,
  ];
  const prelude = imports.has("customType") ? `${d.prelude.join("\n")}\n\n` : "";
  return `${head.join("\n")}\n\n${prelude}${blocks.join("\n\n")}\n`;
}

const problems = checkBetterAuth();
if (problems.length) {
  console.error("[gen] 공통 정의가 Better Auth 1.7.7 + AUTH_SCHEMA_OPTIONS 와 맞지 않는다:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
for (const dialect of Object.keys(DIALECTS)) {
  writeFileSync(OUT(dialect), render(dialect));
  console.log(`[gen] src/schema/${dialect}.ts`);
}
