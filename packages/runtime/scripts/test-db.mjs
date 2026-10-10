// 런타임 어댑터 DB 테스트 실행기 (pnpm -C packages/runtime test:db).
//
//   pnpm -C packages/runtime test:db [--db sqlite,mysql,mariadb,pg] [vitest 인자...]
//
// MySQL·MariaDB·Postgres 가 들어 있으면 저장소 최상위 docker-compose.test.yml 의 컨테이너를 띄우고
// 준비될 때까지 기다린다 (이미 떠 있으면 그대로 쓴다). docker 를 쓸 수 없으면 바로 실패한다.
// 나머지 인자(-t "TC-S4.T1.a" 등)는 vitest 에 그대로 넘긴다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeUp } from "../../../scripts/compose-up.mjs";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = path.resolve(PKG, "../../docker-compose.test.yml");
const ALL = ["sqlite", "mysql", "mariadb", "pg"];
const SERVICE = { mysql: "mysql", mariadb: "mariadb", pg: "postgres" };

const args = process.argv.slice(2);
let dbs = ALL;
const i = args.indexOf("--db");
if (i >= 0) {
  dbs = (args[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  args.splice(i, 2);
  const unknown = dbs.filter((d) => !ALL.includes(d));
  if (dbs.length === 0 || unknown.length) {
    console.error(`test:db: --db 는 ${ALL.join(",")} 중에서 고른다 (받은 값: ${unknown.join(",") || "없음"})`);
    process.exit(2);
  }
}

const services = dbs.filter((d) => SERVICE[d]).map((d) => SERVICE[d]);
if (services.length) {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    console.error(`test:db: docker 를 쓸 수 없다. ${services.join(", ")} 테스트에는 docker 가 필요하다 (docker info 실패).`);
    process.exit(1);
  }
  const up = composeUp(COMPOSE, services);
  if (up.status !== 0) {
    console.error(`test:db: 테스트 DB 컨테이너를 띄우지 못했다 (docker compose 종료코드 ${up.status}).`);
    process.exit(1);
  }
}

const r = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.db.config.ts", ...args], {
  cwd: PKG,
  stdio: "inherit",
  env: { ...process.env, MG_TEST_DBS: dbs.join(",") },
});
process.exit(r.status ?? 1);
