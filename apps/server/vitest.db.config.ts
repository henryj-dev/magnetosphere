import { defineConfig } from "vitest/config";

// pnpm test:db: SQLite·MySQL·MariaDB·Postgres 에서 Node 진입점을 띄우는 TC.
// 직접 부르지 말고 scripts/test-db.mjs 를 거친다 (테스트 DB 컨테이너를 띄우고 --db 를 넘긴다).
export default defineConfig({
  test: {
    include: ["test/db.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
