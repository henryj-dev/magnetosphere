// 한도 분배의 DB 쓰기 도구. 1분 분배는 job_leases 임대 아래에서 돌고, 쓰기마다 펜싱한다 (K1.T2).
// 임대를 잃은 인스턴스(GC·절전으로 늦게 깨어난 쪽)의 쓰기는 0행이고, 새로 넣는 쓰기는 넣기 직전에 임대를 다시 본다.
// 방언마다 다른 upsert 대신 "펜싱한 UPDATE → 0행이면 임대 확인 → INSERT" 로 쓴다. 같은 행을 두 인스턴스가 동시에 넣는 일은
// 임대가 막는다 (임대를 잃은 쪽이 확인과 INSERT 사이에 끼면 기본 키 충돌로 그 실행이 실패하고, 다음 실행이 UPDATE 로 덮는다).
import { and, eq, type SQL } from "drizzle-orm";
import { fenced, LeaseLostError, updatedRows, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle } from "@magnetosphere/runtime/types";

/** 쓰기 조건에 임대 펜싱을 붙인다 (임대가 없으면 조건 그대로) */
export const guard = (h: DbHandle, lease: Lease | undefined, cond: SQL | undefined): SQL | undefined => (lease ? and(cond, fenced(h, lease)) : cond);

/** 이 임대가 아직 내 것인가 */
export async function holds(h: DbHandle, lease: Lease): Promise<boolean> {
  const t = h.schema.jobLeases;
  const rows = await h.db.select({ fence: t.fence }).from(t).where(and(eq(t.name, lease.name), eq(t.holder, lease.holder), eq(t.fence, lease.fence)));
  return rows.length === 1;
}

/** where 에 맞는 행을 set 으로 바꾸고, 없으면 row 를 넣는다. 임대를 잃었으면 LeaseLostError */
export async function upsert(h: DbHandle, lease: Lease | undefined, table: any, key: any, where: SQL | undefined, set: Record<string, unknown>, row: Record<string, unknown>): Promise<void> {
  const n = await updatedRows(h, h.db.update(table).set(set).where(guard(h, lease, where)), key);
  if (n === 1) return;
  if (lease && !(await holds(h, lease))) throw new LeaseLostError(lease);
  await h.db.insert(table).values(row);
}

export async function readSetting<T>(h: DbHandle, key: string): Promise<T | undefined> {
  const t = h.schema.appSettings;
  const [row] = await h.db.select({ value: t.value }).from(t).where(eq(t.key, key));
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export async function writeSetting(h: DbHandle, key: string, value: unknown, now: Date, lease?: Lease): Promise<void> {
  const t = h.schema.appSettings;
  const v = JSON.stringify(value);
  await upsert(h, lease, t, t.key, eq(t.key, key), { value: v, updatedAt: now, updatedBy: null }, { key, value: v, updatedAt: now, updatedBy: null });
}

export async function deleteSetting(h: DbHandle, key: string, lease?: Lease): Promise<void> {
  const t = h.schema.appSettings;
  await h.db.delete(t).where(guard(h, lease, eq(t.key, key)));
}
