// 세션 주기 정리 (M6 후속 L1). 1분 작업 큐 실행기(queue/runner.ts queueJob)가 pruneDone·pruneInvites 옆에서 부른다.
// 새 cron 을 만들지 않는다. jobs.ts 의 cron 집합은 wrangler.toml 과 같아야 한다 (TC-K1.T4.b).
//   - 지우는 것: 만료한 세션(expires_at < now), 삭제한 회원(user.status = 'deleted')의 세션.
//     삭제는 같은 원자 단위에서 세션을 지운다(admin/guard-sql.ts cleanupOwned). 여기는 그 뒤에 남은 행을 치우는 안전망이다.
//   - 만료 세션은 인증에 쓰이지 않지만(getSession 이 expires_at 을 본다) 표에 쌓이므로 지운다.
//   - 한 번에 PRUNE_BATCH(500)행까지 만료 시각 오래된 것부터. 고르기·지우기 꼴은 pruneInvites 와 같다
//     (MySQL·MariaDB 는 DELETE 대상 표를 같은 문장의 부분 질의에서 읽지 못해 파생 테이블로 감싼다, 영향 행은 updatedRows).
//   - 임대를 주면 펜싱한다. 큐 실행기의 "임대를 잃은 쓰기는 0행" 규칙을 맞춘다.
//   - 알려진 한계: session.expires_at 에 인덱스가 없어 1분마다 표를 훑는다 (D1 읽은 행 수). 인덱스는 스키마 변경이라 생성 마이그레이션과
//     함께 별도로 더한다 (M6 후속 리뷰 N1).
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { fenced, updatedRows, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { PRUNE_BATCH } from "../queue/index.ts";

/** 지울 세션을 PRUNE_BATCH 행까지 지운다. 지운 행 수를 돌려준다 */
export async function pruneSessions(h: DbHandle, now: Date, opts: { lease?: Lease } = {}): Promise<number> {
  const s = h.schema.session;
  const u = h.schema.user;
  const deletedMember = inArray(s.userId, h.db.select({ id: u.id }).from(u).where(eq(u.status, "deleted")));
  const stale = or(lt(s.expiresAt, now), deletedMember);
  const ids = h.db.select({ id: s.id }).from(s).where(stale).orderBy(asc(s.expiresAt), asc(s.id)).limit(PRUNE_BATCH);
  const batch = h.provider === "mysql" ? sql`${s.id} in (select id from (${ids}) as prune_sessions)` : inArray(s.id, ids);
  // 고르는 사이에 세션이 갱신됐을 수 있어 조건(stale)을 DELETE 에도 다시 건다
  const where = and(batch, stale, opts.lease ? fenced(h, opts.lease) : undefined);
  return updatedRows(h, h.db.delete(s).where(where), s.id);
}
