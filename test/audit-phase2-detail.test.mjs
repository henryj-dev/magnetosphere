// TC-M6.T6.a·b: 2단계 audit_log 직접 INSERT 자리의 detail 키가 M1 writeAudit 규칙(auditRow)에 걸리는지 (3단계 실행판 M6 백로그 "audit detail 키").
// 제품 모듈을 실행하지 않는다. 여섯 파일을 AST 로 읽어 detail 객체의 키 경로를 모으고, 그 키로 만든 detail 을 auditRow 에 넣어 본다.
// 값은 실행 때 정해지므로(오류 문자열·회원 id 등) 이메일 꼴 값 규칙은 여기서 보지 않는다. 키를 더하거나 바꾸면 TC-M6.T6.a 가 실패한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AuditError, auditRow } from "../apps/server/src/audit/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(path.join(ROOT, "apps/server/package.json"))("typescript");
const FILES = ["apps/server/src/routes/admin-limits.ts", "apps/server/src/limits/daily.ts", "apps/server/src/limits/rebalance.ts", "apps/server/src/keys/apply.ts", "apps/server/src/keys/reconcile.ts", "apps/server/src/queue/index.ts"];

// 객체 리터럴의 키 경로. ...이름 은 같은 파일의 const 이름 = { … } 를 펼친다. 단축 속성은 그 이름이 키다
function keysOf(obj, consts, prefix = "") {
  const out = [];
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      const init = ts.isIdentifier(p.expression) ? consts.get(p.expression.text) : undefined;
      out.push(...(init ? keysOf(init, consts, prefix) : [`${prefix}...?`]));
      continue;
    }
    const key = `${prefix}${p.name.getText().replace(/^["']|["']$/g, "")}`;
    out.push(key);
    if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) out.push(...keysOf(p.initializer, consts, `${key}.`));
  }
  return out;
}

// detail 이 되는 객체: detail: JSON.stringify({…}), const detail = JSON.stringify({…}), alertOnce(…, {…}, now)·reconcile 의 alert(kind, {…})
function sites() {
  const found = [];
  for (const file of FILES) {
    const sf = ts.createSourceFile(file, fs.readFileSync(path.join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
    const consts = new Map();
    const objects = [];
    const stringified = (n) => n && ts.isCallExpression(n) && n.expression.getText(sf) === "JSON.stringify" && ts.isObjectLiteralExpression(n.arguments[0]) ? n.arguments[0] : undefined;
    (function visit(n) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isObjectLiteralExpression(n.initializer)) consts.set(n.name.text, n.initializer);
      if ((ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n)) && n.name.getText(sf) === "detail" && stringified(n.initializer)) objects.push(stringified(n.initializer));
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const arg = n.expression.text === "alertOnce" ? n.arguments[4] : n.expression.text === "alert" && file.endsWith("reconcile.ts") ? n.arguments[1] : undefined;
        if (arg && ts.isObjectLiteralExpression(arg)) objects.push(arg);
      }
      ts.forEachChild(n, visit);
    })(sf);
    for (const o of objects) found.push(`${file} ${keysOf(o, consts).join(",")}`);
  }
  return found.sort();
}

// 읽어서 정한 기대값 (2026-10-18). keys/alerts.ts 는 detail 을 매개변수로 받아 그대로 쓰므로 부르는 쪽(apply·reconcile)에서 센다
const EXPECTED = [
  "apps/server/src/keys/apply.ts keyId",
  "apps/server/src/keys/reconcile.ts keyId,isActive",
  "apps/server/src/keys/reconcile.ts name,isActive",
  "apps/server/src/keys/reconcile.ts name,isActive",
  "apps/server/src/keys/reconcile.ts name,scopes,mapped,wasActive",
  "apps/server/src/limits/daily.ts keyDays,diffUsd,from,until",
  "apps/server/src/limits/rebalance.ts members,userIds,errors",
  "apps/server/src/limits/rebalance.ts runs,error",
  "apps/server/src/queue/index.ts action,attempts,keyId,error",
  "apps/server/src/routes/admin-limits.ts before,before.monthlyLimitUsd,before.maxKeys,after,after.monthlyLimitUsd,after.maxKeys",
].sort();

// alertOnce 를 부르는 파일. 새 호출 자리가 생기면 FILES 에 넣어야 키를 센다
function alertCallers(dir = path.join(ROOT, "apps/server/src"), out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) alertCallers(p, out);
    else if (/\.ts$/.test(e.name) && /\balertOnce\(/.test(fs.readFileSync(p, "utf8").replace(/export async function alertOnce\(/, ""))) out.push(path.relative(ROOT, p).split(path.sep).join("/"));
  }
  return out.sort();
}

test("TC-M6.T6.a 2단계 audit_log 직접 INSERT 의 detail 키 경로가 읽어서 정한 목록과 같다", () => {
  assert.deepEqual(alertCallers(), ["apps/server/src/keys/apply.ts", "apps/server/src/keys/reconcile.ts"]);
  assert.deepEqual(sites(), EXPECTED);
});

test("TC-M6.T6.b writeAudit 으로 옮기면 키 name 을 쓰는 키 알림 셋(reconcile unknown_m_key·manage_scope_key)만 forbidden_detail_key 로 걸린다", () => {
  const blocked = [];
  for (const site of sites()) {
    const detail = {};
    for (const key of site.split(" ")[1].split(",")) {
      const parts = key.split(".");
      let at = detail;
      for (const p of parts.slice(0, -1)) at = typeof at[p] === "object" ? at[p] : (at[p] = {});
      at[parts.at(-1)] ??= 1;
    }
    try {
      // action 은 키 검사와 무관하다 (detail 키 규칙만 본다). 허용된 action 하나로 고정한다
      auditRow({ actorId: null, action: "alert.key_stuck", target: "k-1", detail, ip: null, now: new Date(0) });
    } catch (e) {
      assert.ok(e instanceof AuditError, site);
      assert.equal(e.code, "forbidden_detail_key", site);
      blocked.push(site);
    }
  }
  assert.deepEqual(blocked, EXPECTED.filter((s) => / name,/.test(s)));
  assert.equal(blocked.length, 3);
});
