// 관리자 MFA 의 여러 문장 원자 단위 (A1 설계 5절). 등록 확인·challenge·step-up·복구 코드 재발급·승격·초기화가 이것으로 묶인다.
//   - Node 네 DB: 트랜잭션 하나. pg·MySQL 은 READ COMMITTED 를 명시하고 첫 잠금으로 회원 행을 FOR UPDATE 한다 (잠금 순서 user → factor → session).
//     SQLite 는 첫 문장으로 회원 행 빈 UPDATE 를 해 쓰기 잠금을 먼저 잡는다 (credentialWriter 와 같은 방식).
//     "한 행이어야 하는" 단계가 0행이면 UnitAborted 를 던져 트랜잭션 전체를 되돌린다.
//   - D1: batch 하나. 한 행이어야 하는 단계 바로 뒤에 verification guard INSERT 를 둔다.
//     value 가 CASE WHEN changes() = 1 THEN 고정값 ELSE NULL 이라 0행이면 NOT NULL 제약으로 batch 전체가 되돌려진다
//     (safe-reset-adapter credentialWriter 와 같은 guard). 성공하면 마지막 문장이 이번 guard 행만 지운다.
// 오류 원문(query·params·cause)에는 해시·토큰이 들 수 있어 밖으로 넘기지 않는다. 호출자는 UnitAborted 와 그 밖 오류만 구분한다.
import { eq, inArray, sql } from "drizzle-orm";
import type { AuthDatabase } from "../index.ts";

export type UnitDatabase = Pick<AuthDatabase, "db" | "provider" | "schema" | "kind">;

export interface UnitStep {
  /** 실행하지 않은 문장. db 는 트랜잭션(tx) 또는 D1 의 h.db */
  build(db: any): any;
  /** 주면 이 단계는 정확히 한 행을 바꿔야 한다. RETURNING 에 쓸 칼럼 (MySQL 은 affectedRows) */
  one?: (schema: any) => any;
}

/** 한 행이어야 하는 단계가 0행이었다. 단위 전체가 되돌려졌다 */
export class UnitAborted extends Error {
  constructor() {
    super("MFA 원자 단위가 조건을 만족하지 못해 되돌려졌다");
    this.name = "UnitAborted";
  }
}

const D1_GUARD_FAILED = /NOT NULL constraint failed: verification\.value/;

function causeText(e: unknown): string {
  const out: string[] = [];
  for (let c: any = e, depth = 0; c && depth < 8; c = c.cause, depth++) out.push(String(c.message ?? ""));
  return out.join(" ");
}

async function rows(h: UnitDatabase, statement: any, key: any): Promise<number> {
  if (h.provider === "mysql") return (await statement)[0].affectedRows;
  return (await statement.returning({ k: key })).length;
}

/**
 * 단계를 한 단위로 실행한다. lockUserId 를 주면 Node 에서 그 회원 행을 먼저 잠근다.
 * 실패하면 UnitAborted(조건 불일치) 또는 원래 오류(DB 장애)다. D1 의 guard 실패는 UnitAborted 로 바꾼다.
 */
export async function runUnit(h: UnitDatabase, steps: readonly UnitStep[], o: { lockUserId?: string } = {}): Promise<void> {
  const s = h.schema as any;
  if (h.kind === "d1") {
    const v = s.verification;
    const guardIds: string[] = [];
    const guard = () => {
      const id = crypto.randomUUID();
      guardIds.push(id);
      const now = new Date();
      return h.db.insert(v).values({ id, identifier: `magnetosphere:mfa-unit-guard:${id}`, value: sql`case when changes() = 1 then 'internal-guard' else null end`, expiresAt: now, createdAt: now, updatedAt: now });
    };
    const statements: any[] = [];
    for (const step of steps) {
      statements.push(step.build(h.db));
      if (step.one) statements.push(guard());
    }
    if (guardIds.length) statements.push(h.db.delete(v).where(inArray(v.id, guardIds)));
    try {
      await h.db.batch(statements);
    } catch (e) {
      if (D1_GUARD_FAILED.test(causeText(e))) throw new UnitAborted();
      throw e;
    }
    return;
  }
  const body = async (tx: any) => {
    if (o.lockUserId) {
      const u = s.user;
      if (h.provider === "sqlite") await tx.update(u).set({ authVersion: sql`${u.authVersion}` }).where(eq(u.id, o.lockUserId));
      else await tx.select({ id: u.id }).from(u).where(eq(u.id, o.lockUserId)).for("update");
    }
    for (const step of steps) {
      const statement = step.build(tx);
      if (!step.one) {
        await statement;
        continue;
      }
      if ((await rows(h, statement, step.one(s))) !== 1) throw new UnitAborted();
    }
  };
  await (h.provider === "sqlite" ? h.db.transaction(body) : h.db.transaction(body, { isolationLevel: "read committed" }));
}
