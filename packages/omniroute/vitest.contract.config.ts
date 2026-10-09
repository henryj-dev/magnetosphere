import { defineConfig } from "vitest/config";

// 계약 테스트 (S5). 저장소 최상위 pnpm test:contract 가 tests/contract 의 OmniRoute 를 띄우고 준비한 뒤 이 설정으로 돈다.
// 가짜 fetch 로 도는 어댑터 테스트도 같이 돌려 TC ID 하나로 고를 수 있게 한다 (-t "TC-S5.T2.f").
// 테스트끼리 같은 OmniRoute 를 쓰므로 파일을 차례로 돌린다 (로그인 실패 잠금·예산 상태가 섞이지 않게).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/contract/**/*.contract.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
