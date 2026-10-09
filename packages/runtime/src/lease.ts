// job_leases 임대 잠금 (계획서 3.2, 5.9). 여러 인스턴스(MySQL·Postgres)가 같은 주기 작업을 동시에 돌리지 않게 한다.
// 판정은 DB 한 문장의 원자성에 맡긴다.
//   1) 행이 없으면 INSERT (기본 키 충돌이면 아무것도 안 함) — 동시에 넣어도 한쪽만 들어간다.
//   2) 행이 있으면 "만료됐거나 내 임대"일 때만 UPDATE — 행 잠금 뒤 조건을 다시 보므로 동시에 해도 한쪽만 바뀐다
//      (InnoDB 는 UPDATE 가 최신 커밋 값을 읽고, Postgres READ COMMITTED 는 바뀐 행에 조건을 다시 건다).
// 시각은 앱이 만든 값을 넘긴다. 인스턴스 시계가 맞는다는 전제다 (NTP).
import { and, eq, lt, or } from "drizzle-orm";
import type { DbHandle } from "./types.ts";

/** name 임대를 holder 가 ttlMs 동안 잡는다. 잡았으면(새로 잡았거나 내 임대를 늘렸으면) true */
export async function acquireLease(h: DbHandle, name: string, holder: string, ttlMs: number, now: Date = new Date()): Promise<boolean> {
  const t = h.schema.jobLeases;
  const lockedUntil = new Date(now.getTime() + ttlMs);
  const takeable = and(eq(t.name, name), or(lt(t.lockedUntil, now), eq(t.holder, holder)));
  if (h.provider === "mysql") {
    // MySQL 은 RETURNING 이 없다. INSERT IGNORE·UPDATE 의 영향 행 수로 판정한다 (mysql2 는 FOUND_ROWS 를 켜 둔다)
    const [ins] = await h.db.insert(t).ignore().values({ name, holder, lockedUntil });
    if (ins.affectedRows === 1) return true;
    const [upd] = await h.db.update(t).set({ holder, lockedUntil }).where(takeable);
    return upd.affectedRows === 1;
  }
  const ins = await h.db.insert(t).values({ name, holder, lockedUntil }).onConflictDoNothing().returning({ name: t.name });
  if (ins.length === 1) return true;
  const upd = await h.db.update(t).set({ holder, lockedUntil }).where(takeable).returning({ name: t.name });
  return upd.length === 1;
}
