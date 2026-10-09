import { defineConfig } from "vitest/config";

// pnpm test: Node 진입점 TC (SQLite 파일 DB). Node·Workers 비교는 pnpm test:both-runtimes (vitest.both-runtimes.config.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/both-runtimes.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
