// schema-lint 음성 대조용 픽스처 (TC-S2.T1.c). 일부러 규칙을 어긴 칼럼이 정확히 셋이다.
//   1) settings.key  — 길이 없는 TEXT 기본 키 (R1)
//   2) keys.budget_usd — REAL 금액 (R3)
//   3) settings.value — JSON 칼럼 타입 (R4)
// 나머지 칼럼은 규칙을 지킨다. 이 파일은 어디서도 import 하지 않는다.
import { json, mysqlTable, real, text, varchar } from "drizzle-orm/mysql-core";

export const settings = mysqlTable("settings", {
  key: text("key").primaryKey(),
  value: json("value").notNull(),
});

export const keys = mysqlTable("keys", {
  id: varchar("id", { length: 36 }).primaryKey(),
  label: text("label"),
  budget_usd: real("budget_usd"),
});
