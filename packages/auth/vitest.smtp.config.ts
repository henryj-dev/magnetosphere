import { defineConfig } from "vitest/config";

// pnpm test:smtp: mailpit 컨테이너로 SMTP 어댑터를 확인한다 (TC-S3.T2.b). scripts/test-smtp.mjs 가 컨테이너를 띄운 뒤 부른다.
export default defineConfig({
  test: {
    include: ["test/smtp.test.ts"],
    testTimeout: 60_000,
  },
});
