// 커밋된 마이그레이션 적용 (Docker 조합의 일회성 migrate 서비스, Workers 배포 스크립트의 Hyperdrive 대상 DB).
// 서버는 마이그레이션을 직접 적용하지 않는다 (S4). app 이 뜨기 전에 이것이 먼저 끝나야 한다 (TC-S6.T2.f).
//   DATABASE_URL=<file:|mysql://|postgres://> node apps/server/src/migrate.ts
// DB 종류는 DATABASE_URL 형식으로 고르고, packages/db/migrations/<sqlite|mysql|pg> 를 적용한다. 이미 적용한 것은 건너뛴다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectNode } from "@magnetosphere/runtime/node";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));

export async function migrateDatabase(url: string): Promise<string> {
  const h = await connectNode(url);
  try {
    const folder = path.join(MIGRATIONS, h.provider);
    if (h.kind === "sqlite") await (await import("drizzle-orm/libsql/migrator")).migrate(h.db, { migrationsFolder: folder });
    else if (h.kind === "mysql") await (await import("drizzle-orm/mysql2/migrator")).migrate(h.db, { migrationsFolder: folder });
    else await (await import("drizzle-orm/postgres-js/migrator")).migrate(h.db, { migrationsFolder: folder });
    return folder;
  } finally {
    await h.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate] DATABASE_URL 이 없다");
    process.exit(2);
  }
  const folder = await migrateDatabase(url);
  console.log(`[migrate] ${path.relative(process.cwd(), folder) || folder} 적용 완료`);
}
