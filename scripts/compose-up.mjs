// 테스트 실행기들이 쓰는 docker compose up -d --wait.
//
//   composeUp(file, services, { tries, waitMs, docker }) → spawnSync 결과 ({ status })
//
// 테스트 DB·mailpit·계약 환경을 띄우는 실행기(test:db·test:migrate·auth test·test:smtp·test:contract)가 같이 쓴다.
// 이미지를 받다가 레지스트리가 잠깐 5xx 를 주면 (main 62e0ba7 CI 의 G-K4.6: Docker Hub 502) 한 번에 포기하지 않고
// 기다렸다가 다시 띄운다. up 은 이미 뜬 컨테이너를 그대로 두므로 다시 불러도 안전하다. 끝까지 실패하면 마지막 결과를 돌려준다.
import { spawnSync } from "node:child_process";

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function composeUp(file, services = [], { tries = 3, waitMs = [5_000, 15_000], docker = "docker" } = {}) {
  for (let n = 1; ; n++) {
    const r = spawnSync(docker, ["compose", "-f", file, "up", "-d", "--wait", ...services], { stdio: "inherit" });
    if (r.status === 0 || n >= tries) return r;
    const ms = waitMs[Math.min(n - 1, waitMs.length - 1)];
    console.error(`docker compose up 실패 (종료코드 ${r.status}). ${ms / 1000}초 뒤 다시 띄운다 (${n}/${tries}).`);
    pause(ms);
  }
}
