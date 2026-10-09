import { defineConfig } from "vitest/config";

// pnpm test:workers: apps/server/wrangler.toml 을 로컬 `wrangler dev` 로 띄워 Workers 전용 동작을 본다 (TC-S6.T3.b·d).
// wrangler dev 를 여러 번 띄우므로 파일을 동시에 돌리지 않는다. apps/web 빌드(정적 자산)가 있어야 한다 (beforeAll 이 만든다).
export default defineConfig({
  test: {
    include: ["test/workers.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
