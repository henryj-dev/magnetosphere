import { defineConfig } from "vitest/config";

// pnpm test:migrate: 빈 DB 다섯(SQLite, MySQL, MariaDB, Postgres, D1)에 마이그레이션을 적용하는 테스트.
// test/migrate.test.ts 는 빈 DB 에 전부, test/migrate-0001.test.ts 는 0000 → 기존 행 → 0001 순서 (K1.T1).
// 직접 부르지 말고 scripts/test-migrate.mjs 를 거친다 (테스트 DB 컨테이너를 띄우고 --db 를 넘긴다).
export default defineConfig({
  test: {
    include: ["test/migrate*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
