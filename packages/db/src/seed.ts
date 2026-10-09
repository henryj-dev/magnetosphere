// app_settings 기본값 시드 (계획서 4.2). 설치 때와 업그레이드 때마다 돌려도 된다.
// 없는 키만 넣고 이미 있는 키는 건드리지 않는다 — 운영자가 바꾼 값을 시드가 되돌리지 않게.
import { is } from "drizzle-orm";
import { MySqlDatabase } from "drizzle-orm/mysql-core";

/** 기본 설정값. 값은 app_settings.value 에 JSON 으로 저장한다. */
export const DEFAULT_SETTINGS = {
  signup_mode: "invite_only",
  default_limit_usd: 5,
  default_max_keys: 2,
  daily_signup_cap: 20,
  signup_requires_approval: true,
} as const;

// 방언마다 다른 Drizzle 타입을 한 함수로 받으려고 느슨하게 둔다. 실제 값은 sqlite·mysql·pg 생성 스키마와 그 DB 연결이다.
type AnyDb = any;
type Schema = { appSettings: any };

/** 없는 기본값만 넣는다. 이 호출이 실제로 넣은 키 목록(INSERT 결과로 판정)을 돌려준다. */
export async function seedAppSettings(db: AnyDb, schema: Schema, now: Date = new Date()): Promise<string[]> {
  const t = schema.appSettings;
  const rows = Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value: JSON.stringify(value), updatedAt: now, updatedBy: null }));
  // 이미 있는 키는 충돌로 건너뛴다. 다른 인스턴스가 같은 순간 시드해도 실패하지 않고 먼저 들어간 값을 남긴다.
  if (is(db, MySqlDatabase)) {
    // MySQL 은 RETURNING 이 없다. 한 행씩 INSERT IGNORE 하고 영향 행 수로 판정한다.
    const inserted: string[] = [];
    for (const row of rows) {
      // is() 가 db 를 MySqlDatabase<unknown 결과> 로 좁혀 결과 타입이 사라진다. mysql2 결과는 [ResultSetHeader, ...] 다.
      const [result] = (await db.insert(t).ignore().values(row)) as [{ affectedRows: number }];
      if (result.affectedRows === 1) inserted.push(row.key);
    }
    return inserted;
  }
  const returned: { key: string }[] = await db.insert(t).values(rows).onConflictDoNothing().returning({ key: t.key });
  return returned.map((r) => r.key);
}

/** app_settings 를 키 → 파싱한 값으로 읽는다. */
export async function readAppSettings(db: AnyDb, schema: Schema): Promise<Record<string, unknown>> {
  const t = schema.appSettings;
  const rows: { key: string; value: string }[] = await db.select({ key: t.key, value: t.value }).from(t);
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
}
