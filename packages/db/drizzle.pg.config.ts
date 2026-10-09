import { defineConfig } from "drizzle-kit";

// pg 마이그레이션 생성 설정 (pnpm migrate:gen). 마이그레이션은 저장소에 커밋한다.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/pg.ts",
  out: "./migrations/pg",
});
