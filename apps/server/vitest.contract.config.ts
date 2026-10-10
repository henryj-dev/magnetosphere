import { defineConfig } from "vitest/config";

// OmniRoute 계약 테스트 (S5.T3 부트스트랩, K2 한도 분배 test/contract/limits). 저장소 최상위 pnpm test:contract 가 tests/contract 의 OmniRoute 를 띄우고 준비한 뒤 돈다.
// 파일 이름이 *.contract.ts 라 pnpm test 의 기본 설정(test/**/*.test.ts)에는 걸리지 않는다.
export default defineConfig({
  test: {
    include: ["test/contract/**/*.contract.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
