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
    outputs: ["spikes/**", "docs/verify/**", "scripts/check-verify.mjs", "scripts/check-verify.test.mjs"],
    checks: [
      { id: "G-S1.1", how: "cmd", desc: "TC-S1.T1.a 최소 범위 토큰으로 관리 호출 7개", cmd: "node spikes/v10/run.mjs --assert min" },
      { id: "G-S1.2", how: "cmd", desc: "TC-S1.T1.b 더 낮은 범위는 실패", cmd: "node spikes/v10/run.mjs --assert lower-fails" },
      { id: "G-S1.3", how: "cmd", desc: "TC-S1.T2.a 끈 키 즉시 거부", cmd: "node spikes/v11/run.mjs --assert" },
      { id: "G-S1.4", how: "cmd", desc: "TC-S1.T3.a 허용 목록이 실제 요청을 덮음", cmd: "node spikes/v16/check.mjs covers" },
      { id: "G-S1.5", how: "cmd", desc: "TC-S1.T3.b 관리 별칭은 허용 목록 밖", cmd: "node spikes/v16/check.mjs deny" },
      { id: "G-S1.6", how: "test", desc: "TC-S1.T4.a input:false 권한 칼럼 보호", cmd: 'pnpm -C spikes/v17 test -t "TC-S1.T4.a"' },
      { id: "G-S1.7", how: "test", desc: "TC-S1.T4.b 대조군", cmd: 'pnpm -C spikes/v17 test -t "TC-S1.T4.b"' },
      { id: "G-S1.8", how: "cmd", desc: "TC-S1.T5.a 비밀 값 전부로 운영 모드 시작", cmd: "node spikes/v21/run.mjs all" },
      { id: "G-S1.9", how: "cmd", desc: "TC-S1.T5.b 각 비밀 값의 필수 여부", cmd: "node spikes/v21/run.mjs each" },
      { id: "G-S1.10", how: "test", desc: "TC-S1.T6.a 네 DB 가입·로그인·세션", cmd: 'pnpm -C spikes/v26 test -t "TC-S1.T6.a"' },
      { id: "G-S1.11", how: "test", desc: "TC-S1.T6.b resolveUser 트랜잭션 롤백", cmd: 'pnpm -C spikes/v26 test -t "TC-S1.T6.b"' },
      { id: "G-S1.12", how: "test", desc: "TC-S1.T6.c 대소문자 이메일 중복", cmd: 'pnpm -C spikes/v26 test -t "TC-S1.T6.c"' },
      { id: "G-S1.13", how: "cmd", desc: "TC-S1.T7.a Workers + MySQL", cmd: "node spikes/v27/probe.mjs" },
      { id: "G-S1.14", how: "cmd", desc: "확인 파일 7개 존재·모양", cmd: "node scripts/check-verify.mjs present" },
      { id: "G-S1.15", how: "cmd", desc: "설계를 막는 결과 없음", cmd: "node scripts/check-verify.mjs unblocked" },
      { id: "G-S1.16", how: "cmd", desc: "막았던 결과는 현재 계획서 버전을 가리킴", cmd: "node scripts/check-verify.mjs resolved" },
      { id: "G-S1.17", how: "test", desc: "TC-S1.G.a~d 확인 결과 검사기 음성 대조", cmd: "node --test --test-reporter=tap scripts/check-verify.test.mjs" },
    ],
  },
  S2: {
    needs: ["S1"],
    waivable: false,
    outputs: [
      "packages/db/package.json", "packages/db/src/**", "packages/db/scripts/**", "packages/db/migrations/**", "packages/db/test/**",
      "packages/db/*.config.ts", "scripts/schema-lint.mjs", "test/fixtures/**", "docker-compose.test.yml",
    ],
    checks: [
      { id: "G-S2.1", how: "cmd", desc: "TC-S2.T1.a 생성물이 공통 정의와 같음", cmd: "pnpm -C packages/db gen && git diff --exit-code packages/db/src/schema/" },
    ],
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
