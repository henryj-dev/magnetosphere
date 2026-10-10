import { defineConfig } from "vitest/config";

// pnpm test:db: MySQL·MariaDB·Postgres(·SQLite) 에 붙는 런타임 어댑터 테스트.
// 직접 부르지 말고 scripts/test-db.mjs 를 거친다 (테스트 DB 컨테이너를 띄우고 --db 를 넘긴다).
// 서버 전역 시간대를 바꾸는 TC 가 있어 파일을 동시에 돌리지 않는다.
export default defineConfig({
  test: {
    include: ["test/db.test.ts", "test/lease-fence/**/*.db.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
