#!/usr/bin/env node
// Compose 배포 묶음 시험 실행기 (pnpm test:deploy, 실행판 S6.T2).
//
//   pnpm test:deploy [-t "TC-S6.T2.a"]
//
// 1. docker 를 확인하고 회원 앱 이미지(apps/server/Dockerfile)를 만든다 (층 캐시를 쓴다)
// 2. node --test --test-reporter=tap tests/deploy/deploy.test.mjs. -t 는 --test-name-pattern 으로 넘긴다
// 시험 묶음은 TC 가 띄우고 끝나면 볼륨째 지운다 (tests/deploy/stack.mjs). 사람이 쓰는 80·443·20128 은 쓰지 않는다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildAppImage, dockerAvailable, ROOT } from "./stack.mjs";

const args = process.argv.slice(2);
const ti = args.findIndex((a) => a === "-t" || a === "--testNamePattern");
const pattern = ti >= 0 ? (args[ti + 1] ?? "") : "";

if (!dockerAvailable()) {
  console.error("test:deploy: docker 를 쓸 수 없다 (docker info 실패). 배포 묶음 시험에는 docker 가 필요하다.");
  process.exit(1);
}
try {
  buildAppImage();
} catch (e) {
  console.error(`test:deploy: ${e.message}`);
  process.exit(1);
}
const r = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=tap", "--test-concurrency=1", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), path.join(ROOT, "tests/deploy/deploy.test.mjs")],
  { cwd: ROOT, stdio: "inherit" },
);
process.exit(r.status ?? 1);
