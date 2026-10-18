#!/usr/bin/env node
// AST 기반 경계 검사. 타입(any)은 판정하지 않는다. 제품 모듈은 import/실행하지 않는다.
// 한계: 함수 인자/반환값의 테이블 흐름, 외부 SDK(drizzleAdapter)의 canonical user 간접 쓰기는
// 추적하지 않는다. 전자는 UNKNOWN으로 닫고 정확한 함수/연산/칼럼 허용 항목을 요구한다.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 루트에는 typescript 직접 의존성이 없다. 기존 서버 workspace 의존성을 재사용한다.
const ts = createRequire(path.join(workspace, "apps/server/package.json"))("typescript");
const UNKNOWN = "UNKNOWN", OTHER = "OTHER", SCHEMA = "SCHEMA", USER = "USER";
const slash = (p) => p.split(path.sep).join("/");
const property = (n) => n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) ? n.text : undefined;
const unwrap = (n) => {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n) || ts.isAwaitExpression(n))) n = n.expression;
  return n;
};
const member = (n) => n && ts.isPropertyAccessExpression(n) ? n.name.text : n && ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : undefined;
const isFunction = (n) => ts.isFunctionLike(n) && !!n.body;
const safeName = (s) => typeof s === "string" && /^[a-zA-Z_$][\w$]*$/.test(s) ? s : "?";
// 고정 SQL 식별자는 ASCII 이름, 큰따옴표/백틱, 최대 세 단계 한정 이름만 읽는다.
// 대소문자·인용은 보존하고 점 주변 공백만 정규화한다. 복잡한 이름은 UNKNOWN 무명이다.
const sqlIdentifier = '(?:[a-zA-Z_]\\w*|"[a-zA-Z_]\\w*"|`[a-zA-Z_]\\w*`)';
const sqlTablePattern = `${sqlIdentifier}(?:\\s*\\.\\s*${sqlIdentifier}){0,2}`;
const fixedSqlPattern = new RegExp(`^\\s*(update|insert\\s+into|delete\\s+from)\\s+(${sqlTablePattern})\\s*(?=\\(|set\\b|where\\b|$)`, "i");
const validSqlTable = new RegExp(`^${sqlTablePattern}$`);

export function scan(root) {
  root = path.resolve(root);
  const files = [], modules = new Map(), sites = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.[cm]?[jt]sx?$/.test(e.name) && !/\.d\.[cm]?ts$|\.(test|spec)\./.test(e.name)) files.push(p);
    }
  }
  walk(path.join(root, "apps/server/src"));
  const packages = path.join(root, "packages");
  if (fs.existsSync(packages)) for (const p of fs.readdirSync(packages).sort()) walk(path.join(packages, p, "src"));
  if (!files.length) throw new Error("no source files");

  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const scope = { parent: null, bindings: new Map(), functionScope: true }, scopes = new Map();
    const mod = { sf, scope, scopes, functionNames: new Map() };
    modules.set(file, mod);
    function bind(name, value, s, access = []) {
      if (ts.isIdentifier(name)) {
        const b = { ...value, name: name.text, scope: s, access, mod, writes: [], reassigned: false };
        s.bindings.set(name.text, b);
      } else if (ts.isObjectBindingPattern(name)) {
        for (const e of name.elements) bind(e.name, { ...value, rest: !!e.dotDotDotToken }, s, [...access, property(e.propertyName ?? e.name)]);
      } else if (ts.isArrayBindingPattern(name)) {
        for (const e of name.elements) if (ts.isBindingElement(e)) bind(e.name, { ...value, rest: true }, s, access);
      }
    }
    function visit(n, s) {
      if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) bind(n.name, { nonTable: true }, s);
      if (isFunction(n) || ts.isClassLike(n) || ts.isBlock(n) || ts.isCaseBlock(n) || ts.isCatchClause(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) {
        s = { parent: s, bindings: new Map(), functionScope: isFunction(n) };
      }
      scopes.set(n, s);
      if (isFunction(n)) {
        if (n.name && ts.isIdentifier(n.name)) bind(n.name, { nonTable: true }, s);
        for (const p of n.parameters) bind(p.name, { parameter: true, init: p.initializer }, s);
      }
      if (ts.isVariableDeclaration(n)) {
        let target = s;
        if (ts.isVariableDeclarationList(n.parent) && !(n.parent.flags & ts.NodeFlags.BlockScoped)) while (!target.functionScope && target.parent) target = target.parent;
        bind(n.name, { declaration: n, init: n.initializer, parameter: ts.isCatchClause(n.parent) }, target);
      }
      if (ts.isImportDeclaration(n) && n.importClause) {
        const clause = n.importClause, from = n.moduleSpecifier.text;
        if (clause.name) bind(clause.name, { imported: "default", from, typeOnly: clause.isTypeOnly }, s);
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name, { imported: "*", from, typeOnly: clause.isTypeOnly }, s);
          else for (const e of clause.namedBindings.elements) bind(e.name, { imported: (e.propertyName ?? e.name).text, from, typeOnly: clause.isTypeOnly || e.isTypeOnly }, s);
        }
      }
      ts.forEachChild(n, (c) => visit(c, s));
    }
    visit(sf, scope);
    function writes(n) {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const left = unwrap(n.left);
        if (ts.isIdentifier(left)) { const b = lookup(left.text, scopes.get(left)); if (b) b.reassigned = true; }
        else if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
          const base = unwrap(left.expression);
          if (ts.isIdentifier(base)) { const b = lookup(base.text, scopes.get(base)); if (b) b.writes.push(member(left) ?? "?"); }
        }
      }
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) {
        const arg = unwrap(n.operand);
        if (ts.isIdentifier(arg)) { const b = lookup(arg.text, scopes.get(arg)); if (b) b.reassigned = true; }
      }
      ts.forEachChild(n, writes);
    }
    writes(sf);
    return mod;
  }
  function lookup(name, scope) {
    for (let s = scope; s; s = s.parent) if (s.bindings.has(name)) return s.bindings.get(name);
  }
  function relative(mod, from) {
    if (!from.startsWith(".")) return undefined;
    const p = path.resolve(path.dirname(mod.sf.fileName), from), stem = p.replace(/\.[cm]?js$/, "");
    for (const c of [p, `${stem}.ts`, `${stem}.tsx`, path.join(p, "index.ts")]) {
      if (c.startsWith(root + path.sep) && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
  }
  function exported(mod, name, hops, seen) {
    for (const n of mod.sf.statements) {
      if (ts.isExportDeclaration(n) && !n.isTypeOnly) {
        const local = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements.find((e) => !e.isTypeOnly && e.name.text === name) : undefined;
        if (n.moduleSpecifier && (local || !n.exportClause)) {
          if (hops >= 1) return UNKNOWN;
          const p = relative(mod, n.moduleSpecifier.text);
          if (p) { const result = exported(load(p), local ? (local.propertyName ?? local.name).text : name, hops + 1, seen); if (result !== UNKNOWN) return result; }
        } else if (local) return binding(lookup((local.propertyName ?? local.name).text, mod.scope), hops, seen);
      }
      if (ts.isVariableStatement(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const b = lookup(name, mod.scope);
        if (b && n.declarationList.declarations.includes(b.declaration)) return binding(b, hops, seen);
      }
    }
    return UNKNOWN;
  }
  function select(base, key) {
    if (!key) return UNKNOWN;
    if (base && typeof base === "object") {
      if (base.namespace) return exported(base.namespace, key, base.hops, base.seen);
      return base.fields?.get(key) ?? UNKNOWN;
    }
    if (base === OTHER) return OTHER;
    if (base === SCHEMA) return key === "user" ? USER : `TABLE:${key}`;
    if (key === "schema") return SCHEMA;
    return UNKNOWN;
  }
  function binding(b, hops = 0, seen = new Set()) {
    if (!b || seen.has(b) || b.reassigned || b.rest) return UNKNOWN;
    seen = new Set(seen).add(b);
    let result;
    if (b.typeOnly || b.nonTable) result = OTHER;
    else if (b.from) {
      const p = relative(b.mod, b.from);
      if (p) {
        if ([...seen].some((previous) => previous.mod !== b.mod)) { if (hops >= 1) return UNKNOWN; hops++; }
        result = b.imported === "*" ? { namespace: load(p), hops, seen } : exported(load(p), b.imported, hops, seen);
      }
      else if (b.from === "drizzle-orm" && b.imported === "sql") result = "SQL";
      else if (/^drizzle-orm\/.+-core$/.test(b.from) && /^(sqliteTable|pgTable|mysqlTable)$/.test(b.imported)) result = "TABLE_FACTORY";
      else result = UNKNOWN;
    } else if (b.init) result = value(b.init, b.mod, hops, seen);
    else result = b.name === "schema" ? SCHEMA : UNKNOWN;
    for (const key of b.access) result = select(result, key);
    if (b.writes.length) return UNKNOWN;
    // schema 구조분해(cfg.database)도 문법상 schema 경계를 유지한다.
    if (result === UNKNOWN && b.name === "schema" && b.access.at(-1) === "schema") return SCHEMA;
    return result;
  }
  function value(expr, mod, hops = 0, seen = new Set()) {
    const n = unwrap(expr);
    if (!n) return UNKNOWN;
    if (ts.isIdentifier(n)) {
      const b = lookup(n.text, mod.scopes.get(n));
      if (!b && n.text === "schema") return SCHEMA;
      if (!b && n.text === "sql") return "SQL";
      return binding(b, hops, seen);
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) return select(value(n.expression, mod, hops, seen), member(n));
    if (ts.isObjectLiteralExpression(n)) {
      const fields = new Map();
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) fields.set(property(p.name), value(p.initializer, mod, hops, seen));
        else if (ts.isShorthandPropertyAssignment(p)) fields.set(p.name.text, value(p.name, mod, hops, seen));
      }
      return { fields };
    }
    if (ts.isCallExpression(n) && value(n.expression, mod, hops, seen) === "TABLE_FACTORY") {
      const arg = n.arguments[0], name = arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
      return name === "user" ? USER : name ? `TABLE:${name}` : UNKNOWN;
    }
    if (ts.isConditionalExpression(n)) {
      const a = value(n.whenTrue, mod, hops, seen), b = value(n.whenFalse, mod, hops, seen);
      return a === b ? a : UNKNOWN;
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      const b = lookup(n.expression.text, mod.scopes.get(n.expression));
      if (!b && ["Map", "Set", "Headers"].includes(n.expression.text)) return OTHER;
      if (b?.from === "hono" && b.imported === "Hono" && !b.typeOnly) return OTHER;
    }
    return UNKNOWN;
  }
  function columns(expr, mod, seen = new Set()) {
    const n = unwrap(expr);
    if (!n) return ["?"];
    if (ts.isIdentifier(n)) {
      const b = lookup(n.text, mod.scopes.get(n));
      if (!b || seen.has(b) || b.reassigned) return ["?"];
      return [...columns(b.init, mod, new Set(seen).add(b)), ...b.writes];
    }
    if (ts.isConditionalExpression(n)) return [...columns(n.whenTrue, mod, seen), ...columns(n.whenFalse, mod, seen)];
    if (ts.isArrayLiteralExpression(n)) return n.elements.flatMap((e) => columns(e, mod, seen));
    if (ts.isObjectLiteralExpression(n)) return n.properties.flatMap((p) => ts.isSpreadAssignment(p) ? columns(p.expression, mod, seen) : [property(p.name) ?? "?"]);
    return ["?"];
  }
  // 익명 콜백은 조상 함수 + 호출 이름/인자 위치/같은 이름 순번으로 구별한다.
  // 줄 이동에는 영향받지 않는다. 경로·칼럼·함수 식별자 외 문자열 인자는 출력하지 않는다.
  function functionName(node, mod) {
    function label(n) {
      const p = n.parent;
      if (n.name) {
        let owner;
        if (ts.isClassLike(p)) owner = property(p.name);
        if (ts.isObjectLiteralExpression(p) && ts.isVariableDeclaration(p.parent)) owner = property(p.parent.name);
        return `${owner ? `${safeName(owner)}.` : ""}${safeName(property(n.name))}`;
      }
      if (ts.isVariableDeclaration(p)) return safeName(property(p.name));
      if (ts.isPropertyAssignment(p)) {
        const owner = ts.isObjectLiteralExpression(p.parent) && ts.isVariableDeclaration(p.parent.parent) ? property(p.parent.parent.name) : undefined;
        return `${owner ? `${safeName(owner)}.` : ""}${safeName(property(p.name))}`;
      }
      if (ts.isCallExpression(p)) {
        let name = `${safeName(member(p.expression) ?? (ts.isIdentifier(p.expression) ? p.expression.text : "call"))}[${p.arguments.indexOf(n)}]`;
        if (ts.isVariableDeclaration(p.parent)) name = `${safeName(property(p.parent.name))}.${name}`;
        return name;
      }
      return ts.isReturnStatement(p) ? "<return>" : "<anonymous>";
    }
    if (!mod.functionNames.size) {
      function index(n, prefix, siblings) {
        if (isFunction(n)) {
          const base = label(n), count = (siblings.get(base) ?? 0) + 1;
          siblings.set(base, count);
          const own = `${base}${count > 1 ? `~${count}` : ""}`;
          prefix = prefix ? `${prefix}/${own}` : own;
          mod.functionNames.set(n, prefix);
          siblings = new Map();
        }
        ts.forEachChild(n, (c) => index(c, prefix, siblings));
      }
      index(mod.sf, "", new Map());
    }
    for (let n = node.parent; n; n = n.parent) if (mod.functionNames.has(n)) return mod.functionNames.get(n);
    return "<module>";
  }
  function add(mod, n, operation, table, cols, sqlTable) {
    if (table === OTHER || (typeof table === "string" && table.startsWith("TABLE:"))) return;
    sites.push({ file: slash(path.relative(root, mod.sf.fileName)), function: functionName(n, mod), operation, table: table === USER ? USER : UNKNOWN, columns: [...new Set(cols.map(safeName))].sort(), ...(sqlTable ? { sqlTable } : {}) });
  }
  function sqlColumns(text, spans, at, op) {
    if (op === "delete") return [];
    let rest = text.slice(at + 1).map((t, j) => `${t}${at + 1 + j < spans.length ? `__slot${at + 1 + j}__` : ""}`).join("");
    function column(token) {
      const slot = token.trim().match(/^__slot(\d+)__$/);
      if (!slot) return /^["`]?[a-zA-Z_]\w*["`]?$/.test(token.trim()) ? token.trim().replace(/["`]/g, "") : "?";
      let expr = unwrap(spans[Number(slot[1])].expression);
      if (ts.isCallExpression(expr) && member(expr.expression) === "identifier") expr = unwrap(expr.arguments[0]);
      if (member(expr) === "name") expr = unwrap(expr.expression);
      return member(expr) ?? "?";
    }
    if (op === "insert") {
      const list = rest.match(/^\s*\(([^)]*)\)/);
      return list ? list[1].split(",").map(column) : ["?"];
    }
    const set = rest.match(/^\s+set\s+([\s\S]*)/i);
    if (!set) return ["?"];
    rest = set[1].split(/\bwhere\b|\breturning\b/i)[0];
    return rest.split(",").map((assignment) => {
      const match = assignment.match(/^\s*([^=]+)=/);
      return match ? column(match[1]) : "?";
    });
  }
  function fluentColumns(n, mod) {
    let cursor = n;
    const found = [];
    while ((ts.isPropertyAccessExpression(cursor.parent) || ts.isElementAccessExpression(cursor.parent)) && ts.isCallExpression(cursor.parent.parent)) {
      const call = cursor.parent.parent, name = member(call.expression);
      if (name === "set" || name === "values") found.push(...columns(call.arguments[0], mod));
      if (["onConflictDoUpdate", "onDuplicateKeyUpdate"].includes(name)) {
        const opts = unwrap(call.arguments[0]);
        const set = opts && ts.isObjectLiteralExpression(opts) ? opts.properties.find((p) => property(p.name) === "set") : undefined;
        found.push(...columns(set && ts.isPropertyAssignment(set) ? set.initializer : set && ts.isShorthandPropertyAssignment(set) ? set.name : undefined, mod));
      }
      cursor = call;
    }
    return found.length ? found : ["?"];
  }
  for (const file of files) {
    const mod = load(file);
    function visit(n) {
      if (ts.isCallExpression(n) && (ts.isPropertyAccessExpression(n.expression) || ts.isElementAccessExpression(n.expression))) {
        const op = member(n.expression);
        if (["insert", "update", "delete"].includes(op)) {
          const table = value(n.arguments[0], mod);
          // 알려진 Map/Set/Headers/Hono만 제외한다. 출처 불명 호출은 UNKNOWN이다.
          if (table !== OTHER && value(n.expression.expression, mod) !== OTHER) add(mod, n, op, table, op === "delete" ? [] : fluentColumns(n, mod));
        }
      }
      if (ts.isTaggedTemplateExpression(n) && value(n.tag, mod) === "SQL") {
        const spans = ts.isTemplateExpression(n.template) ? n.template.templateSpans : [];
        const text = [n.template.head?.text ?? n.template.text, ...spans.map((s) => s.literal.text)];
        for (let i = 0; i < spans.length; i++) {
          const match = text[i].match(/\b(update|insert\s+into|delete\s+from)\s*$/i);
          if (!match) continue;
          const op = match[1].toLowerCase().split(/\s/)[0];
          add(mod, n, `sql:${op}`, value(spans[i].expression, mod), sqlColumns(text, spans, i, op));
        }
        // 고정 user는 USER로 분류하고 모든 고정 표 이름을 자리 식별자에 보존한다.
        // 그 외 고정 표는 schema 객체 출처 미증명 UNKNOWN이나 무명 동적 표와 합치지 않는다.
        for (const part of text) {
          const fixed = part.match(fixedSqlPattern);
          if (fixed) {
            const op = fixed[1].toLowerCase().split(/\s/)[0];
            const tail = part.slice(fixed[0].length);
            const sqlTable = fixed[2].replace(/\s*\.\s*/g, ".");
            const last = sqlTable.split(".").at(-1).replace(/["`]/g, "");
            add(mod, n, `sql:${op}`, last.toLowerCase() === "user" ? USER : UNKNOWN, sqlColumns(["", ` ${tail}`], [], 0, op), sqlTable);
          } else if (/\b(update|insert\s+into|delete\s+from)\s+[^\s]/i.test(part)) add(mod, n, "sql:dynamic", UNKNOWN, ["?"]);
        }
      }
      ts.forEachChild(n, visit);
    }
    if (mod.sf.parseDiagnostics.length) sites.push({ file: slash(path.relative(root, file)), function: "<parse>", operation: "parse", table: UNKNOWN, columns: ["?"] });
    visit(mod.sf);
  }
  const merged = new Map();
  for (const s of sites) {
    const key = JSON.stringify([s.file, s.function, s.operation, s.table, s.sqlTable ?? null]);
    if (!merged.has(key)) merged.set(key, s);
    else merged.get(key).columns = [...new Set([...merged.get(key).columns, ...s.columns])].sort();
  }
  return [...merged.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function compare(sites, allow) {
  if (!Array.isArray(allow)) throw new Error("invalid allow");
  const key = (s) => JSON.stringify([s.file, s.function, s.operation, s.table, s.sqlTable ?? null]);
  const entries = new Map();
  for (const a of allow) {
    if (!a || typeof a.reason !== "string" || !a.reason.trim() || !["USER", "UNKNOWN"].includes(a.table) || !Array.isArray(a.columns) || !a.columns.every((c) => typeof c === "string") || ![a.file, a.function, a.operation].every((v) => typeof v === "string" && v.length > 0) || a.file.includes("*") || entries.has(key(a))) throw new Error("invalid allow");
    if (a.sqlTable !== undefined && (typeof a.sqlTable !== "string" || !validSqlTable.test(a.sqlTable) || a.sqlTable !== a.sqlTable.replace(/\s*\.\s*/g, "."))) throw new Error("invalid allow");
    entries.set(key(a), a);
  }
  const failures = [];
  for (const s of sites) {
    const a = entries.get(key(s));
    if (!a) failures.push({ kind: "UNAUTHORIZED", ...s });
    else if (s.columns.some((c) => !a.columns.includes(c)) || a.columns.some((c) => !s.columns.includes(c))) failures.push({ kind: "COLUMNS", ...s });
    entries.delete(key(s));
  }
  for (const a of entries.values()) failures.push({ kind: "STALE", file: a.file, function: a.function, operation: a.operation, table: a.table, columns: a.columns, ...(a.sqlTable ? { sqlTable: a.sqlTable } : {}) });
  return failures;
}

function main() {
  let root = workspace, allowFile;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--root" || args[i] === "--allow") && args[i + 1]) {
      if (args[i] === "--root") root = path.resolve(args[++i]);
      else allowFile = path.resolve(args[++i]);
    } else throw new Error("invalid arguments");
  }
  const sites = scan(root);
  const allow = JSON.parse(fs.readFileSync(allowFile ?? path.join(root, "scripts/user-writes.allow.json"), "utf8"));
  const failures = compare(sites, allow);
  for (const s of sites) console.log(`${s.table} ${s.file}#${s.function} ${s.operation}${s.sqlTable ? ` table=${s.sqlTable}` : ""} [${s.columns.join(",")}]`);
  for (const f of failures) console.error(`${f.kind} ${f.table} ${f.file}#${f.function} ${f.operation}${f.sqlTable ? ` table=${f.sqlTable}` : ""} [${f.columns.join(",")}]`);
  process.exitCode = failures.length ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { console.error("검사 설정·의존성·파일을 읽을 수 없어요. 원문은 출력하지 않아요."); process.exitCode = 2; }
}
