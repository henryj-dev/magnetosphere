// 마이그레이션과 스키마가 어긋나지 않았는지 본다 (TC-S2.T3.b). 두 가지를 본다.
//   1) 스키마 ↔ 마지막 스냅숏: 아래 generate 검사
//   2) 스냅숏 ↔ SQL: 커밋된 마이그레이션 SQL 이 직전·현재 스냅숏에서 다시 만든 SQL 과 같은지 (공백 정규화 후).
//      drizzle-kit 은 SQL 이 아니라 스냅숏만 비교하므로, SQL 을 손으로 고치면 1) 만으로는 못 잡는다 (S2 리뷰 H1).
// DB별로 커밋된 마이그레이션을 임시 폴더에 복사해 그 위에서 drizzle-kit generate 를 돌린다.
// 새 마이그레이션 파일이 생기면 스키마만 고치고 마이그레이션을 안 만든 것이다. 저장소의 파일은 건드리지 않는다.
// drizzle-kit 0.31 은 오류가 나도 종료코드 0 을 내고(--out 절대 경로 앞에 "./" 를 붙여 실패하는 등),
// 그래서 "변경 없음" 문구가 출력에 있을 때만 통과로 본다.
//
//   node scripts/check-drift.mjs          (packages/db 에서, pnpm -C packages/db check:drift)
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIALECTS = { sqlite: "sqlite", mysql: "mysql", pg: "postgresql" };
const sqlFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const kit = createRequire(import.meta.url)("drizzle-kit/api"); // CJS 모듈
const GENERATE = {
  sqlite: [kit.generateSQLiteDrizzleJson, kit.generateSQLiteMigration],
  mysql: [kit.generateMySQLDrizzleJson, kit.generateMySQLMigration],
  pg: [kit.generateDrizzleJson, kit.generateMigration],
};
const norm = (sql) => sql.replace(/\s+/g, " ").trim();

// 커밋된 SQL 이 스냅숏에서 다시 만든 SQL 과 다른 마이그레이션 목록
async function sqlMismatches(name) {
  const dir = path.join(PKG, "migrations", name);
  const [emptyJson, generate] = GENERATE[name];
  const journal = JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8"));
  const bad = [];
  let prev = await emptyJson({});
  for (const entry of journal.entries) {
    const snap = JSON.parse(readFileSync(path.join(dir, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`), "utf8"));
    const expected = (await generate(prev, snap)).map(norm);
    const actual = readFileSync(path.join(dir, `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint").map(norm).filter(Boolean);
    const at = expected.findIndex((x, i) => x !== actual[i]);
    if (at >= 0 || actual.length !== expected.length) {
      const i = at >= 0 ? at : Math.min(expected.length, actual.length);
      bad.push(`${entry.tag}.sql 문장 ${i + 1}: 기대 ${JSON.stringify(expected[i] ?? null)} / 실제 ${JSON.stringify(actual[i] ?? null)}`);
    }
    prev = snap;
  }
  return bad;
}

let drift = 0;
for (const [name, dialect] of Object.entries(DIALECTS)) {
  const committed = path.join(PKG, "migrations", name);
  const tmp = mkdtempSync(path.join(tmpdir(), `mg-drift-${name}-`));
  try {
    cpSync(committed, tmp, { recursive: true });
    const before = sqlFiles(tmp);
    const r = spawnSync("pnpm", ["exec", "drizzle-kit", "generate", "--dialect", dialect, "--schema", `./src/schema/${name}.ts`, "--out", path.relative(PKG, tmp), "--name", "drift"], { cwd: PKG, encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    const added = sqlFiles(tmp).filter((f) => !before.includes(f));
    if (r.status !== 0 || (!added.length && !/No schema changes/.test(out))) {
      console.error(`[drift] ${name}: drizzle-kit generate 가 결과를 내지 못함 (종료코드 ${r.status})\n${out}`);
      drift++;
      continue;
    }
    if (added.length) {
      drift++;
      console.error(`[drift] ${name}: 스키마가 마이그레이션보다 앞서 있다. pnpm -C packages/db migrate:gen 으로 마이그레이션을 만든다. 새로 생길 파일: ${added.join(", ")}`);
    } else {
      console.log(`[drift] ${name}: 스키마 = 스냅숏 (마이그레이션 ${before.length}개)`);
    }
    const bad = await sqlMismatches(name);
    if (bad.length) {
      drift++;
      console.error(`[drift] ${name}: 마이그레이션 SQL 이 스냅숏과 다르다 (손으로 고친 SQL). pnpm -C packages/db migrate:gen 으로 다시 만든다.\n  ${bad.join("\n  ")}`);
    } else {
      console.log(`[drift] ${name}: SQL = 스냅숏`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
process.exit(drift ? 1 : 0);
