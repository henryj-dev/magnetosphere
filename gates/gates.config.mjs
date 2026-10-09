// 실행판(docs/plan/phase1-todo.md) GATE 의 검사 정의. 검사 추가는 이 데이터만 고친다.
// 검사가 빈 단계는 gate 가 실행·봉인을 거부한다. 각 단계 검사는 그 단계를 시작할 때 실행판 GATE 표대로 채운다.
// outputs 는 --assert-order 가 잠긴 단계의 변경을 잡는 데 쓰는 글롭이다.

const nodeTest = (file, tc) => `node --test --test-reporter=tap --test-name-pattern="${tc}" ${file}`;

export const GATES = {
  S0: {
    needs: [],
    waivable: false,
    outputs: [
      "package.json", "pnpm-workspace.yaml", ".nvmrc", ".gitignore", "LICENSE",
      "apps/*/package.json", "packages/*/package.json",
      "scripts/check-workspace.mjs", "scripts/gate.mjs", "scripts/gate.test.mjs", "scripts/hook.test.mjs",
      "gates/gates.config.mjs", ".githooks/**", ".github/workflows/gate.yml",
    ],
    checks: [
      { id: "G-S0.1", how: "cmd", desc: "TC-S0.T1.a 워크스페이스 패키지 여섯", cmd: "node scripts/check-workspace.mjs" },
      { id: "G-S0.2", how: "test", desc: "TC-S0.T2.a 선행 미봉인 거부", cmd: nodeTest("scripts/gate.test.mjs", "TC-S0.T2.a") },
      { id: "G-S0.3", how: "test", desc: "TC-S0.T2.b 되돌리면 봉인 무효", cmd: nodeTest("scripts/gate.test.mjs", "TC-S0.T2.b") },
      { id: "G-S0.4", how: "test", desc: "TC-S0.T2.c --seal 재검", cmd: nodeTest("scripts/gate.test.mjs", "TC-S0.T2.c") },
      { id: "G-S0.5", how: "test", desc: "TC-S0.T2.d 검사 종류마다 이빨", cmd: nodeTest("scripts/gate.test.mjs", "TC-S0.T2.d") },
      { id: "G-S0.6", how: "test", desc: "TC-S0.T2.e 면제 조건", cmd: nodeTest("scripts/gate.test.mjs", "TC-S0.T2.e") },
      { id: "G-S0.7", how: "test", desc: "TC-S0.T2.f --assert-order", cmd: nodeTest("scripts/gate.test.mjs", "TC-S0.T2.f") },
      { id: "G-S0.8", how: "test", desc: "TC-S0.T3.a pre-push 훅 거부", cmd: nodeTest("scripts/hook.test.mjs", "TC-S0.T3.a") },
      { id: "G-S0.9", how: "cmd", desc: "봉인 디렉터리가 무시되지 않음", cmd: "git check-ignore -q gates/seals/S0.json", expectExit: 1 },
      { id: "G-S0.10", how: "test", desc: "TC-S0.T2.g 위조 봉인 무효", cmd: nodeTest("scripts/gate.test.mjs", "TC-S0.T2.g") },
      { id: "G-S0.11", how: "test", desc: "TC-S0.T2.h --verify-seals --rerun", cmd: nodeTest("scripts/gate.test.mjs", "TC-S0.T2.h") },
      { id: "G-S0.12", how: "test", desc: "TC-S0.T2.i 설정 변경으로 우회 불가", cmd: nodeTest("scripts/gate.test.mjs", "TC-S0.T2.i") },
      { id: "G-S0.13", how: "test", desc: "TC-S0.T2.j --head 지정", cmd: nodeTest("scripts/gate.test.mjs", "TC-S0.T2.j") },
      { id: "G-S0.14", how: "test", desc: "TC-S0.T3.b 다른 브랜치 push 거부", cmd: nodeTest("scripts/hook.test.mjs", "TC-S0.T3.b") },
      { id: "G-S0.15", how: "test", desc: "CI 테스트 명령", cmd: 'node --test --test-reporter=tap "scripts/*.test.mjs"' },
    ],
  },
  S1: {
    needs: ["S0"],
    waivable: false,
    outputs: ["spikes/**", "docs/verify/**"],
    checks: [],
  },
  S2: {
    needs: ["S1"],
    waivable: false,
    outputs: [
      "packages/db/src/**", "packages/db/scripts/**", "packages/db/migrations/**", "packages/db/test/**",
      "scripts/schema-lint.mjs", "docker-compose.test.yml",
    ],
    checks: [],
  },
  S3: {
    needs: ["S2"],
    waivable: false,
    outputs: ["packages/auth/src/**", "packages/auth/test/**", "scripts/check-sso-paths.mjs"],
    checks: [],
  },
  S4: {
    needs: ["S3"],
    waivable: false,
    outputs: ["packages/runtime/src/**", "packages/runtime/test/**", "apps/server/src/**", "apps/web/src/**", "apps/web/svelte.config.js"],
    checks: [],
  },
  S5: {
    needs: ["S4"],
    waivable: false,
    outputs: ["packages/omniroute/src/**", "packages/omniroute/test/**", "tests/contract/**", "apps/server/src/setup/omniroute.ts"],
    checks: [],
  },
  S6: {
    needs: ["S5"],
    waivable: false,
    outputs: ["scripts/init.mjs", ".env.example", "docker-compose.yml", "deploy/**", "apps/server/Dockerfile", "apps/server/wrangler.toml", "tests/e2e/**"],
    checks: [],
  },
  S7: {
    needs: ["S6"],
    waivable: false,
    outputs: [".github/workflows/ci.yml", "scripts/check-ci-matrix.mjs"],
    checks: [],
  },
};
