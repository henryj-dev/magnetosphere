import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // 서버 시간대를 UTC 가 아닌 곳으로 둬서, 시각 저장 왕복에 시간대 오차가 섞이면 바로 드러나게 한다.
    env: { TZ: "Asia/Seoul" },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
