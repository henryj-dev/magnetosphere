// SMTP 어댑터 테스트 실행기 (pnpm -C packages/auth test:smtp).
//
// test/mailpit.compose.yml 의 mailpit(SMTP 127.0.0.1:31025, API 127.0.0.1:38025)을 띄우고(이미 떠 있으면 그대로 쓴다)
// 준비될 때까지 기다린 뒤 vitest.smtp.config.ts 로 vitest 를 부른다. docker 를 쓸 수 없으면 바로 실패한다.
// 컨테이너는 남겨 둔다. 지우려면: docker compose -f packages/auth/test/mailpit.compose.yml down
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeUp } from "../../../scripts/compose-up.mjs";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = path.join(PKG, "test/mailpit.compose.yml");

if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
  console.error("test:smtp: docker 를 쓸 수 없다. mailpit 컨테이너에 docker 가 필요하다 (docker info 실패).");
  process.exit(1);
}
const up = composeUp(COMPOSE, ["mailpit"]);
if (up.status !== 0) {
  console.error(`test:smtp: mailpit 컨테이너를 띄우지 못했다 (docker compose 종료코드 ${up.status}). 포트 31025·38025 가 비어 있는지 확인한다.`);
  process.exit(1);
}
const r = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.smtp.config.ts", ...process.argv.slice(2)], { cwd: PKG, stdio: "inherit" });
process.exit(r.status ?? 1);
