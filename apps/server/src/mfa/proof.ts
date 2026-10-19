// 민감 작업의 step-up proof 소비 (A1 설계 4절 "민감 작업 step-up"). proof 는 작업 자신의 트랜잭션·batch 안에서 소비한다.
//   - Node: 트랜잭션 안에서 소비 UPDATE 를 돌려 정확히 한 행인지 본다. 아니면 작업 전체를 되돌린다 (호출자가 던진다).
//   - D1: batch 의 소비 UPDATE 바로 뒤에 verification guard INSERT 를 둔다. 0행이면 value 가 NULL 이라 NOT NULL 제약으로 batch 전체가 되돌려진다.
//     성공하면 batch 마지막 문장이 그 guard 행을 지운다 (safe-reset-adapter credentialWriter 와 같은 방식).
import { eq, sql } from "drizzle-orm";
import type { UnitStep } from "@magnetosphere/auth/mfa";
import type { DbHandle } from "@magnetosphere/runtime/types";

/** D1 proof guard 한 쌍: 소비 UPDATE 바로 뒤에 둘 INSERT 와 batch 끝에 둘 DELETE */
export function d1ProofGuard(h: DbHandle): { guard: any; drop: any } {
  const v = h.schema.verification;
  const id = crypto.randomUUID();
  const now = new Date();
  return {
    guard: h.db.insert(v).values({ id, identifier: `magnetosphere:mfa-proof-guard:${id}`, value: sql`case when changes() = 1 then 'internal-guard' else null end`, expiresAt: now, createdAt: now, updatedAt: now }),
    drop: h.db.delete(v).where(eq(v.id, id)),
  };
}

/** D1 batch 오류가 proof guard 실패(소비 0행)인가 */
export function proofGuardFailed(e: unknown): boolean {
  const messages: string[] = [];
  for (let cause: any = e, depth = 0; cause && depth < 8; cause = cause.cause, depth++) messages.push(String(cause.message ?? ""));
  return /NOT NULL constraint failed: verification\.value/.test(messages.join(" "));
}

/** Node 트랜잭션 안에서 proof 를 소비한다. 정확히 한 행이면 true */
export async function consumeProofIn(h: DbHandle, tx: any, step: UnitStep): Promise<boolean> {
  const statement = step.build(tx);
  const n = h.provider === "mysql" ? (await statement)[0].affectedRows : (await statement.returning({ k: step.one!(h.schema) })).length;
  return n === 1;
}
