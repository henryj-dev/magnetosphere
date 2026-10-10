import { defineConfig } from "vitest/config";

// pnpm test: Node 진입점 TC (SQLite 파일 DB). Node·Workers 비교는 pnpm test:both-runtimes (vitest.both-runtimes.config.ts),
// 여러 DB 에서 도는 TC(test/db.test.ts, test/**/*.db.test.ts)는 pnpm test:db (scripts/test-db.mjs → vitest.db.config.ts), wrangler dev TC(test/workers.test.ts, test/**/*.workers.test.ts)는 pnpm test:workers.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/both-runtimes.test.ts", "test/db.test.ts", "test/**/*.db.test.ts", "test/workers.test.ts", "test/**/*.workers.test.ts"],
    // 같은 컴퓨터에서 게이트 검사가 vitest 를 여러 번 띄운다. 작업자 수를 4 로 묶어 부하를 줄인다
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
