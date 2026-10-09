// S2.T3: 빈 DB 다섯에 커밋된 마이그레이션을 적용하고, 테이블 목록·시드·저장 계층을 확인한다.
// scripts/test-migrate.mjs 가 MG_TEST_DBS(--db)로 고른 DB 만 돈다.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { TABLES } from "../src/schema/common.ts";
import { DEFAULT_SETTINGS, readAppSettings, seedAppSettings } from "../src/seed.ts";
import { findUserByEmail, insertUser } from "../src/users.ts";
import { DBS, type Handle } from "./dbs.ts";

const selected = (process.env.MG_TEST_DBS ?? DBS.map((d) => d.kind).join(",")).split(",");
const cases = DBS.filter((d) => selected.includes(d.kind));
const EXPECTED_TABLES = Object.values(TABLES).map((t) => t.name).sort();

// 오류와 그 cause 사슬의 메시지를 모두 모은다 (Drizzle 은 드라이버 오류를 cause 로 감싼다).
function messages(e: unknown): string {
  const out: string[] = [];
  for (let cur: any = e; cur && out.length < 5; cur = cur.cause) out.push(String(cur.message ?? cur));
  return out.join(" | ");
}

test("고른 DB 가 하나 이상이다", () => {
  expect(cases.length).toBeGreaterThan(0);
});

describe.each(cases)("$label", (d) => {
  let h: Handle;
  beforeAll(async () => {
    h = await d.open();
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-S2.T3.a 빈 상태 → 최신 마이그레이션 성공, 테이블 13개, 시드", async () => {
    expect(EXPECTED_TABLES).toHaveLength(13);
    expect(await h.tables()).toEqual(EXPECTED_TABLES);

    // 두 인스턴스가 동시에 시드해도 실패하지 않고 기본값이 한 번만 들어간다.
    await Promise.all([seedAppSettings(h.db, h.schema), seedAppSettings(h.db, h.schema)]);
    expect(await readAppSettings(h.db, h.schema)).toEqual(DEFAULT_SETTINGS);

    // user 권한 칼럼 기본값과 금액 DECIMAL(12,6) 왕복
    const id = randomUUID();
    await insertUser(h.db, h.schema, { id, name: "기본값", email: `defaults-${id}@x.test` });
    const u = h.schema.user;
    await h.db.update(u).set({ monthlyLimitUsd: 12.345678 }).where(eq(u.id, id));
    const [row] = await h.db.select().from(u).where(eq(u.id, id));
    expect({ role: row.role, status: row.status, isBootstrapAdmin: row.isBootstrapAdmin, maxKeys: row.maxKeys, monthlyLimitUsd: row.monthlyLimitUsd }).toEqual({
      role: "member",
      status: "active",
      isBootstrapAdmin: false,
      maxKeys: null,
      monthlyLimitUsd: 12.345678,
    });
  });

  test("TC-S2.T3.c 이메일은 소문자로 저장되고 대소문자 중복이 막힌다", async () => {
    const tag = randomUUID().slice(0, 8);
    const upper = `A-${tag}@X.test`;
    const lower = upper.toLowerCase();

    await insertUser(h.db, h.schema, { id: randomUUID(), name: "첫째", email: upper });
    const [stored] = await h.db.select({ email: h.schema.user.email }).from(h.schema.user).where(eq(h.schema.user.email, lower));
    expect(stored?.email).toBe(lower);
    expect((await findUserByEmail(h.db, h.schema, upper))?.email).toBe(lower);

    const err = await insertUser(h.db, h.schema, { id: randomUUID(), name: "둘째", email: lower }).then(
      () => null,
      (e) => e,
    );
    expect(err, "같은 이메일 두 번째 저장이 성공했다").not.toBeNull();
    expect(messages(err)).toMatch(/unique|duplicate/i);
    const rows = await h.db.select({ id: h.schema.user.id }).from(h.schema.user).where(eq(h.schema.user.email, lower));
    expect(rows).toHaveLength(1);
  });
});
