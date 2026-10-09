import { defineConfig } from "vitest/config";

// pnpm test: OmniRoute 없이 도는 어댑터 테스트 (가짜 fetch).
// 실제 OmniRoute 에 붙는 계약 테스트(test/contract/*.contract.ts)는 pnpm test:contract (저장소 최상위, tests/contract/run.mjs) 로 돈다.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
