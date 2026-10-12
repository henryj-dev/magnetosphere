// 만료·취소한 초대 정리 (3단계 실행판 M3.T3). 1분 작업 큐 실행기(queue/runner.ts queueJob)가 pruneDone 옆에서 부른다.
//   - 지우는 것: 미사용(used_at IS NULL) 초대 가운데 expires_at 이 30일 지난 것, 또는 revoked_at 이 30일 지난 것.
//   - 남기는 것: 사용한 초대(used_at 있음)는 취소 여부와 관계없이 모두 남긴다. 누가 누구를 초대했는지(created_by → used_by)가 남아야 한다.
//     수락이 차지 중인 행(used_at 있음·used_by 없음, accept.ts 2~5단계 사이)도 used_at 이 있으므로 지우지도 풀지도 않는다 (M3.T2 보안 리뷰 L-4).
//   - 만료 직후에는 지우지 않는다. 관리자가 "만료됨" 목록을 30일 동안 본다.
//   - 한 번에 PRUNE_BATCH(500)행까지 만료 시각 오래된 것부터. 남은 것은 다음 tick 이 잇는다. 고르기·지우기 꼴은 pruneDone 과 같다
//     (MySQL·MariaDB 는 DELETE 대상 표를 같은 문장의 부분 질의에서 읽지 못해 파생 테이블로 감싼다, 영향 행은 updatedRows).
//   - 임대를 주면 펜싱한다. 조건을 DELETE 에 다시 걸어 늦은 실행기가 지워도 결과는 같지만, 큐 실행기의 "임대를 잃은 쓰기는 0행" 규칙을 맞춘다.
import { and, asc, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { fenced, updatedRows, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { PRUNE_BATCH } from "../queue/index.ts";

/** 만료·취소한 뒤 이만큼 지난 미사용 초대를 지운다 */
export const INVITE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** 지울 초대를 PRUNE_BATCH 행까지 지운다. 지운 행 수를 돌려준다 */
export async function pruneInvites(h: DbHandle, now: Date, opts: { lease?: Lease } = {}): Promise<number> {
  const t = h.schema.invites;
  const cutoff = new Date(now.getTime() - INVITE_RETENTION_MS);
  const old = and(isNull(t.usedAt), or(lt(t.expiresAt, cutoff), and(isNotNull(t.revokedAt), lt(t.revokedAt, cutoff))));
  const ids = h.db.select({ id: t.id }).from(t).where(old).orderBy(asc(t.expiresAt), asc(t.id)).limit(PRUNE_BATCH);
  const batch = h.provider === "mysql" ? sql`${t.id} in (select id from (${ids}) as prune_invites)` : inArray(t.id, ids);
  // 고르는 사이에 수락이 차지했을 수 있어 조건(old)을 DELETE 에도 다시 건다
  const where = and(batch, old, opts.lease ? fenced(h, opts.lease) : undefined);
  return updatedRows(h, h.db.delete(t).where(where), t.id);
}
