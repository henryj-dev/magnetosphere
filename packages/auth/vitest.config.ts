import { defineConfig } from "vitest/config";

// pnpm test: scripts/test.mjs 가 테스트 DB 컨테이너(MySQL·MariaDB·Postgres)를 띄운 뒤 이 설정으로 vitest 를 돌린다.
// SMTP 테스트(test/smtp.test.ts)는 mailpit 이 필요해 따로 돈다: pnpm test:smtp (vitest.smtp.config.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/smtp.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
