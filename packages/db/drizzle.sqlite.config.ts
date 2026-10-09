import { defineConfig } from "drizzle-kit";

// sqlite 마이그레이션 생성 설정 (pnpm migrate:gen). D1 도 이 마이그레이션을 wrangler 로 적용한다. 마이그레이션은 저장소에 커밋한다.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/sqlite.ts",
  out: "./migrations/sqlite",
});
