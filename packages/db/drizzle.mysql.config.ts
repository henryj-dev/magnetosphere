import { defineConfig } from "drizzle-kit";

// mysql 마이그레이션 생성 설정 (pnpm migrate:gen). 마이그레이션은 저장소에 커밋한다.
export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema/mysql.ts",
  out: "./migrations/mysql",
});
