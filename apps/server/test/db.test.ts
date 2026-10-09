// 여러 DB 에서 Node 진입점을 띄우는 TC (pnpm test:db). DB 는 --db 로 고른다 (scripts/test-db.mjs → MG_TEST_DBS).
// 빈 DB 와 마이그레이션은 packages/runtime 테스트 도구(createTestDb)를 같이 쓴다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectNode } from "@magnetosphere/runtime/node";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, enabledDbs, LABEL, type DbKind } from "../../../packages/runtime/test/dbs.ts";
import { ADMIN, boot, closeAll, post, tokenIn, TEST_ENCRYPTION_KEY, TEST_SECRET, type TestEnv } from "./helpers.ts";

afterEach(closeAll);

async function envFor(kind: DbKind): Promise<TestEnv> {
  const db = await createTestDb(kind);
  const dir = mkdtempSync(path.join(tmpdir(), "mg-server-db-"));
  return {
    dir,
    dbFile: "",
    env: { DATABASE_URL: db.url, BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: TEST_SECRET, APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, NODE_ENV: "test" },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
      void db.drop();
    },
  };
}

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  describe("TC-S4.T4.f 동시에 설치 요청 10건이 와도 관리자는 하나다", () => {
    it(`${LABEL[kind]}: 같은 토큰으로 POST /api/setup 10건 동시 → 201 정확히 1개, 나머지 409·401, user 행 1개`, async () => {
      const r = await boot(await envFor(kind));
      const token = tokenIn(r.logs)!;
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => post(r, "/api/setup", { token, ...ADMIN, email: `admin${i}@example.com` }).then((res) => res.status)),
      );
      expect(results.filter((s) => s === 201)).toHaveLength(1);
      // 나머지는 이미 설치됨(409) 또는 이미 소비된 토큰(401) 이다. 관리자를 만드는 중에 온 요청은 토큰이 없어 401 이 된다. 500 은 없다
      expect(results.filter((s) => s !== 201).every((s) => s === 409 || s === 401)).toBe(true);
      const h = await connectNode(r.t.env.DATABASE_URL);
      try {
        const users = await h.db.select({ id: h.schema.user.id, role: h.schema.user.role }).from(h.schema.user);
        expect(users).toHaveLength(1);
        expect(users[0].role).toBe("admin");
      } finally {
        await h.close();
      }
    });
  });
});
