// 서버 테스트 공용: 마이그레이션을 적용한 빈 SQLite 파일과 그 DB 를 쓰는 환경 변수.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/migrations/sqlite", import.meta.url));

export const TEST_SECRET = "mg-server-test-secret-mg-server-test-secret";

export interface TestEnv {
  dir: string;
  dbFile: string;
  env: Record<string, string>;
  cleanup(): void;
}

export async function makeTestEnv(): Promise<TestEnv> {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-server-"));
  const dbFile = path.join(dir, "app.sqlite");
  const client = createClient({ url: `file:${dbFile}` });
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  client.close();
  return {
    dir,
    dbFile,
    env: {
      DATABASE_URL: `file:${dbFile}`,
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: TEST_SECRET,
      NODE_ENV: "test",
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** SPA 빌드 대신 쓰는 작은 정적 디렉터리 */
export function fakeWebDir(dir: string): string {
  const web = path.join(dir, "web");
  rmSync(web, { recursive: true, force: true });
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>spa</title>");
  writeFileSync(path.join(web, "robots.txt"), "User-agent: *\n");
  return web;
}
