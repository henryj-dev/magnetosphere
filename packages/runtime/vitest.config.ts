import { defineConfig } from "vitest/config";

// pnpm test: DB·workerd 가 필요 없는 테스트.
// DB 테스트(test/db.test.ts)는 pnpm test:db (scripts/test-db.mjs → vitest.db.config.ts),
// Node·Workers 교차 테스트(test/cross-runtime.test.ts)는 pnpm test:cross-runtime 으로 따로 돈다.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/db.test.ts", "test/cross-runtime.test.ts"],
    testTimeout: 30_000,
  },
});
