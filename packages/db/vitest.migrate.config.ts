import { defineConfig } from "vitest/config";

// pnpm test:migrate: 빈 DB 다섯(SQLite, MySQL, MariaDB, Postgres, D1)에 마이그레이션을 적용하는 테스트.
// test/migrate.test.ts 는 빈 DB 에 전부, test/migrate-0001.test.ts 는 0000 → 기존 행 → 0001 순서 (K1.T1),
// test/migrate-0002.test.ts 는 usage_daily·api_keys.budget_at (K2.T7).
// 직접 부르지 말고 scripts/test-migrate.mjs 를 거친다 (테스트 DB 컨테이너를 띄우고 --db 를 넘긴다).
export default defineConfig({
  test: {
    include: ["test/migrate*.test.ts"],
    // migrate.test.ts 와 migrate-0002.test.ts 는 같은 DB 이름(test/dbs.ts 의 mg_migrate_test)을 지우고 다시 만든다. 파일을 차례로 돈다
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
