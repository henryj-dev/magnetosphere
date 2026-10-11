// 미인증 계정 선점 막기 (3단계 실행판 M2.T8, M2 보안 리뷰 H1). open·domain_allowlist 에서 공격자가 피해자 이메일로 먼저 가입해 두면,
// 피해자가 같은 이메일로 가입할 때 가짜 200 을 받고 인증 메일을 다시 받아 인증한 순간 공격자가 정한 비밀번호의 계정이 인증된다.
//   - 다툼 표시: 인증 전 계정에 같은 이메일로 공개 가입이 다시 오면(onExistingUserSignUp) verification 행 signup-dispute:<회원 id> 를 남긴다.
//     응답은 그대로 가짜 200 이고, 이 쓰기는 백그라운드 작업이라 응답 시간도 같다. 새 칼럼을 만들지 않으려고 기존 verification 표를 쓴다
//     (Better Auth 는 모르는 identifier 를 읽지 않는다. 요청 본문으로는 쓸 수 없다).
//   - 다툼이 있는 계정이 처음 인증되면(afterEmailVerification) credential 비밀번호를 아무도 모르는 값으로 바꾸고 세션을 모두 지운 뒤
//     재설정 메일을 보낸다. 메일함 주인만 비밀번호를 정할 수 있다. 다툼이 없는 정상 가입은 그대로 쓴다.
// 이 파일은 Workers 에서도 import 된다.
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";

type AnyDb = any;
type Schema = Record<string, any>;

const identifier = (userId: string) => `signup-dispute:${userId}`;
/** 다툼 표시의 수명. 인증 링크(1시간)보다 길게 둔다. 미인증 공개 가입 정리 작업이 회원과 같이 지운다 */
const DISPUTE_TTL_MS = 7 * 24 * 60 * 60_000;

/** 다툼 표시를 남긴다 (이미 있으면 그대로) */
export async function markDispute(db: AnyDb, schema: Schema, userId: string, now = new Date()): Promise<void> {
  const v = schema.verification;
  const [row] = await db.select({ id: v.id }).from(v).where(eq(v.identifier, identifier(userId))).limit(1);
  if (row) return;
  await db.insert(v).values({ id: crypto.randomUUID(), identifier: identifier(userId), value: userId, expiresAt: new Date(now.getTime() + DISPUTE_TTL_MS), createdAt: now, updatedAt: now });
}

/** 다툼 표시가 있으면 지우고 true */
export async function takeDispute(db: AnyDb, schema: Schema, userId: string): Promise<boolean> {
  const v = schema.verification;
  const rows = await db.select({ id: v.id }).from(v).where(eq(v.identifier, identifier(userId)));
  if (rows.length === 0) return false;
  await db.delete(v).where(eq(v.identifier, identifier(userId)));
  return true;
}

/** credential 비밀번호를 아무도 모르는 값으로 바꾸고 그 회원의 세션을 모두 지운다 */
export async function lockOutPassword(db: AnyDb, schema: Schema, userId: string): Promise<void> {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  await db
    .update(schema.account)
    .set({ password: await hashPassword(random), updatedAt: new Date() })
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential")));
  await db.delete(schema.session).where(eq(schema.session.userId, userId));
}
