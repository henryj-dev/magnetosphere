// packages/auth 테스트 실행기 (pnpm -C packages/auth test).
//
//   pnpm -C packages/auth test [vitest 인자...]      예: -t "TC-S3.T1.a"
//
// 권한 칼럼·미인증 로그인 TC 는 SQLite·MySQL·MariaDB·Postgres 에서 돈다. 저장소 최상위
// docker-compose.test.yml 의 컨테이너를 띄우고(이미 떠 있으면 그대로 쓴다) 준비될 때까지 기다린 뒤 vitest 를 부른다.
// docker 를 쓸 수 없으면 바로 실패한다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = path.resolve(PKG, "../../docker-compose.test.yml");
const SERVICES = ["mysql", "mariadb", "postgres"];

if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
  console.error(`auth test: docker 를 쓸 수 없다. ${SERVICES.join(", ")} 테스트 DB 에 docker 가 필요하다 (docker info 실패).`);
  process.exit(1);
}
const up = spawnSync("docker", ["compose", "-f", COMPOSE, "up", "-d", "--wait", ...SERVICES], { stdio: "inherit" });
if (up.status !== 0) {
  console.error(`auth test: 테스트 DB 컨테이너를 띄우지 못했다 (docker compose 종료코드 ${up.status}).`);
  process.exit(1);
}
const r = spawnSync("pnpm", ["exec", "vitest", "run", ...process.argv.slice(2)], { cwd: PKG, stdio: "inherit" });
process.exit(r.status ?? 1);
