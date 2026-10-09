// schema-lint 음성 대조용 픽스처 (TC-S2.T1.c). 일부러 규칙을 어긴 칼럼이 정확히 여덟이다.
//   1) settings.key       — MySQL 길이 없는 TEXT 기본 키 (R1)
//   2) settings.value     — JSON 칼럼 타입 (R4)
//   3) keys.budget_usd    — REAL 금액 (R3)
//   4) keys.id            — MySQL id 가 VARCHAR(36) 이 아님 (R2)
//   5) keys.owner_id      — MySQL TEXT 칼럼에 외래 키 (R1)
//   6) keys.label         — MySQL TEXT 칼럼에 인덱스 (R1)
//   7) keys.slug          — MySQL 고유 키 varchar(1024) 가 인덱스 3072바이트 한도 초과 (R5)
//   8) pg_tokens.token    — Postgres 길이 없는 TEXT 고유 키 (R1, pg 방언)
// 나머지 칼럼은 규칙을 지킨다. 이 파일은 어디서도 import 하지 않는다.
import { index, json, mysqlTable, real, text, varchar } from "drizzle-orm/mysql-core";
import * as pg from "drizzle-orm/pg-core";

export const settings = mysqlTable("settings", {
  key: text("key").primaryKey(),
  value: json("value").notNull(),
});

export const owners = mysqlTable("owners", {
  id: varchar("id", { length: 36 }).primaryKey(),
});

export const keys = mysqlTable("keys", {
  id: varchar("id", { length: 64 }).primaryKey(),
  owner_id: text("owner_id").references(() => owners.id),
  label: text("label"),
  note: text("note"),
  slug: varchar("slug", { length: 1024 }).unique(),
  budget_usd: real("budget_usd"),
}, (table) => [
  index("keys_label_idx").on(table.label),
]);

export const pgTokens = pg.pgTable("pg_tokens", {
  id: pg.varchar("id", { length: 36 }).primaryKey(),
  token: pg.text("token").unique(),
});
