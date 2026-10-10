import { defineConfig } from "vitest/config";

// pnpm test: Node 진입점 TC (SQLite 파일 DB). Node·Workers 비교는 pnpm test:both-runtimes (vitest.both-runtimes.config.ts),
// 여러 DB 에서 도는 TC(test/db.test.ts, test/**/*.db.test.ts)는 pnpm test:db (scripts/test-db.mjs → vitest.db.config.ts), wrangler dev TC(test/workers.test.ts, test/**/*.workers.test.ts)는 pnpm test:workers.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/both-runtimes.test.ts", "test/db.test.ts", "test/**/*.db.test.ts", "test/workers.test.ts", "test/**/*.workers.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
