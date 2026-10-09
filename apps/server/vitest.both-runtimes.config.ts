import { defineConfig } from "vitest/config";

// pnpm test:both-runtimes: apps/web 빌드를 Node 진입점과 로컬 workerd 의 Workers 진입점에서 같이 내주는지 비교한다.
export default defineConfig({
  test: {
    include: ["test/both-runtimes.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
