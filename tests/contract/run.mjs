#!/usr/bin/env node
// 계약 테스트 실행기 (pnpm test:contract, 계획서 5.6 · 실행판 S5).
//
//   pnpm test:contract [-t "TC-S5.T2.d"] [vitest 인자...]
//
// 1. tests/contract/docker-compose.yml 의 OmniRoute·가짜 상위 서버를 띄우고 준비될 때까지 기다린다 (이미 떠 있으면 그대로 쓴다)
// 2. setup.mjs 로 제공자 노드·연결·가격을 넣는다 (여러 번 돌려도 같은 상태)
// 3. vitest 계약 설정으로 테스트를 돈다. 인자는 vitest 에 그대로 넘긴다
//    - packages/omniroute (vitest.contract.config.ts): TC-S5.T1·T2 어댑터·환경, TC-K0.T5·T6·T8·T9·T10 확인 항목 (test/contract/verify)
//    - apps/server (vitest.contract.config.ts): TC-S5.T3 부트스트랩, TC-K2.T6·T7 한도 분배 (test/contract/limits), TC-K3.T3 정합성 점검 (test/contract/keys), TC-K4.T5 회원 키 API 수명주기 (test/contract/routes)
//    -t 가 한 쪽 TC 만 고르면 그쪽만 돈다.
// 계약 환경은 끝나도 내리지 않는다 (다음 실행·게이트 재검이 다시 쓴다). 내리려면:
//   docker compose -f tests/contract/docker-compose.yml down
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeUp } from "../../scripts/compose-up.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const COMPOSE = path.join(HERE, "docker-compose.yml");

const args = process.argv.slice(2);
const ti = args.findIndex((a) => a === "-t" || a === "--testNamePattern");
const pattern = ti >= 0 ? (args[ti + 1] ?? "") : "";

const SUITES = [
  { dir: "packages/omniroute", owns: /TC-S5\.T[12]\b|TC-K0\.T(5|6|8|9|10)\b/ },
  { dir: "apps/server", owns: /TC-S5\.T3\b|TC-K2\.T[67]\b|TC-K3\.T3\b|TC-K4\.T5\b/ },
];
const mentioned = SUITES.filter((s) => s.owns.test(pattern));
const suites = mentioned.length ? mentioned : SUITES;

if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
  console.error("test:contract: docker 를 쓸 수 없다 (docker info 실패). 계약 테스트에는 docker 가 필요하다.");
  process.exit(1);
}
const up = composeUp(COMPOSE);
if (up.status !== 0) {
  console.error(`test:contract: 계약 환경을 띄우지 못했다 (docker compose 종료코드 ${up.status}).`);
  process.exit(1);
}
const setup = spawnSync(process.execPath, [path.join(HERE, "setup.mjs")], { stdio: "inherit" });
if (setup.status !== 0) {
  console.error("test:contract: 계약 환경 준비(setup.mjs)가 실패했다.");
  process.exit(1);
}

let code = 0;
for (const s of suites) {
  const r = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.contract.config.ts", ...args], {
    cwd: path.join(ROOT, s.dir),
    stdio: "inherit",
  });
  if (r.status !== 0) code = r.status ?? 1;
}
process.exit(code);
