// 테스트 실행기들이 쓰는 docker compose up -d --wait.
//
//   composeUp(file, services, { docker }) → spawnSync 결과 ({ status })
//
// 테스트 DB·mailpit·계약 환경을 띄우는 실행기(test:db·test:migrate·auth test·test:smtp·test:contract)가 같이 쓴다.
import { spawnSync } from "node:child_process";

export function composeUp(file, services = [], { docker = "docker" } = {}) {
  return spawnSync(docker, ["compose", "-f", file, "up", "-d", "--wait", ...services], { stdio: "inherit" });
}
