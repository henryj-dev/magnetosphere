import { defineConfig } from "vitest/config";

// pnpm test:cross-runtime: 같은 암호화 코드를 Node 와 로컬 workerd(wrangler unstable_startWorker)에서 돌려 비교한다.
export default defineConfig({
  test: {
    include: ["test/cross-runtime.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
