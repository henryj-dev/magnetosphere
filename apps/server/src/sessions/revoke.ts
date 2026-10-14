// 회원 세션 폐기 (3단계 실행판 M4.T1). 관리자 상태·역할 변경은 이 문장 하나로 해당 회원의 세션을 모두 지운다.
// 비밀번호 변경이 유지하는 현재 세션은 이 문장의 범위가 아니다. 그 예외는 credential writer 가 같은 원자 단위에서 따로 갱신한다.
import { eq } from "drizzle-orm";
import type { DbHandle } from "@magnetosphere/runtime/types";

/** 실행하지 않은 session DELETE. db 는 트랜잭션(tx)이나 D1 batch 에 넣을 연결이다 */
export function revokeSessionsStatement(h: DbHandle, db: any, userId: string) {
  return db.delete(h.schema.session).where(eq(h.schema.session.userId, userId));
}

export async function revokeSessions(h: DbHandle, userId: string): Promise<void> {
  await revokeSessionsStatement(h, h.db, userId);
}
