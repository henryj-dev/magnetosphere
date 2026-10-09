import { defineConfig } from "vitest/config";

// pnpm test: DB 서버 없이 도는 테스트 (SQLite). 다섯 DB 마이그레이션 테스트는 vitest.migrate.config.ts (pnpm test:migrate).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/migrate.test.ts"],
  },
});
