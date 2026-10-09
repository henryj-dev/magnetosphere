// S2.T2: app_settings 기본값 시드. SQLite(libsql) 빈 DB 에 공통 정의에서 만든 스키마를 올려 확인한다.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "../src/schema/sqlite.ts";
import { DEFAULT_SETTINGS, readAppSettings, seedAppSettings } from "../src/seed.ts";

const kit = createRequire(import.meta.url)("drizzle-kit/api");

let dir: string;
let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "mg-seed-"));
  client = createClient({ url: "file:" + path.join(dir, "seed.sqlite") });
  db = drizzle(client, { schema });
  const ddl: string[] = await kit.generateSQLiteMigration(await kit.generateSQLiteDrizzleJson({}), await kit.generateSQLiteDrizzleJson(schema));
  for (const s of ddl) await client.execute(s);
});

afterEach(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("app_settings 시드", () => {
  test("TC-S2.T2.a 시드 기본값이 계획서 숫자와 같다", async () => {
    expect(await readAppSettings(db, schema)).toEqual({});
    const inserted = await seedAppSettings(db, schema);
    expect(inserted.sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(await readAppSettings(db, schema)).toEqual({
      signup_mode: "invite_only",
      default_limit_usd: 5,
      default_max_keys: 2,
      daily_signup_cap: 20,
      signup_requires_approval: true,
    });
  });

  test("TC-S2.T2.b 시드는 두 번 돌려도 운영자 값을 덮지 않는다", async () => {
    await seedAppSettings(db, schema);
    await db.update(schema.appSettings).set({ value: JSON.stringify(10), updatedAt: new Date(), updatedBy: "operator-1" }).where(eq(schema.appSettings.key, "default_limit_usd"));
    // 지운 키는 다시 채운다 (업그레이드로 새 기본값이 생긴 경우와 같은 경로)
    await db.delete(schema.appSettings).where(eq(schema.appSettings.key, "daily_signup_cap"));

    const inserted = await seedAppSettings(db, schema);

    expect(inserted).toEqual(["daily_signup_cap"]);
    const settings = await readAppSettings(db, schema);
    expect(settings.default_limit_usd).toBe(10);
    expect(settings.daily_signup_cap).toBe(20);
    const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, "default_limit_usd"));
    expect(row.updatedBy).toBe("operator-1");
  });
});
