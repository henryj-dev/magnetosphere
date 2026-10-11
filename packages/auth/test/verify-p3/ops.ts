// 3단계 확인 항목 시험의 DB 도구 (M0). 생성 스키마의 Drizzle 연결 하나로 다섯 DB(D1 포함)에서 같은 코드가 돈다.
// D1 시험 Worker 는 POST /__test/db { op, args } 로 이 함수들을 부른다 (apps/server/test/verify-p3/worker.ts).
import { and, eq } from "drizzle-orm";

type AnyDb = any;
type Schema = any;

export async function userById(db: AnyDb, s: Schema, id: string) {
  const [row] = await db.select({ id: s.user.id }).from(s.user).where(eq(s.user.id, id));
  return row;
}

export async function accountOfUser(db: AnyDb, s: Schema, userId: string) {
  const [row] = await db.select({ id: s.account.id }).from(s.account).where(and(eq(s.account.userId, userId), eq(s.account.providerId, "credential")));
  return row;
}

export async function statusOf(db: AnyDb, s: Schema, userId: string): Promise<string | undefined> {
  const [row] = await db.select({ status: s.user.status }).from(s.user).where(eq(s.user.id, userId));
  return row?.status;
}

export async function deleteSession(db: AnyDb, s: Schema, id: string) {
  await db.delete(s.session).where(eq(s.session.id, id));
}

const byEmail = (s: Schema, email: string) => eq(s.user.email, email.toLowerCase());

async function idOf(db: AnyDb, s: Schema, email: string): Promise<string | undefined> {
  const [row] = await db.select({ id: s.user.id }).from(s.user).where(byEmail(s, email));
  return row?.id;
}

/** 시험이 부르는 DB 동작. 값은 JSON 으로 오가므로 DB 마다 다른 표현(0/1, "5.000000")을 여기서 맞춘다 */
export const OPS = {
  /** user·account·verification·session 행 수 */
  async rows(db: AnyDb, s: Schema) {
    const n = async (t: any) => (await db.select({ id: t.id }).from(t)).length;
    return { user: await n(s.user), account: await n(s.account), verification: await n(s.verification), session: await n(s.session) };
  },
  async user(db: AnyDb, s: Schema, email: string) {
    const [r] = await db.select().from(s.user).where(byEmail(s, email));
    if (!r) return null;
    return {
      id: r.id as string,
      email: r.email as string,
      name: r.name as string,
      role: r.role as string,
      status: r.status as string,
      emailVerified: Boolean(r.emailVerified),
      monthlyLimitUsd: r.monthlyLimitUsd === null ? null : Number(r.monthlyLimitUsd),
    };
  },
  /** credential 계정의 비밀번호 해시 (바뀌었는지만 본다) */
  async passwordHash(db: AnyDb, s: Schema, email: string) {
    const id = await idOf(db, s, email);
    if (!id) return null;
    const [r] = await db.select({ password: s.account.password }).from(s.account).where(and(eq(s.account.userId, id), eq(s.account.providerId, "credential")));
    return (r?.password as string) ?? null;
  },
  async setUser(db: AnyDb, s: Schema, email: string, patch: { status?: string; emailVerified?: boolean }) {
    await db.update(s.user).set(patch).where(byEmail(s, email));
  },
  async sessionsOf(db: AnyDb, s: Schema, email: string) {
    const id = await idOf(db, s, email);
    if (!id) return 0;
    return (await db.select({ id: s.session.id }).from(s.session).where(eq(s.session.userId, id))).length;
  },
  async deleteSessionsOf(db: AnyDb, s: Schema, email: string) {
    const id = await idOf(db, s, email);
    if (id) await db.delete(s.session).where(eq(s.session.userId, id));
  },
  /** 설치가 끝난 상태 (관리자 한 명). signUpGate·userCreateGuard 가 가입을 막는다 */
  async addAdmin(db: AnyDb, s: Schema) {
    const now = new Date();
    const id = crypto.randomUUID();
    await db.insert(s.user).values({ id, name: "admin", email: `admin-${id}@example.test`, emailVerified: true, role: "admin", createdAt: now, updatedAt: now });
  },
};

export type OpName = keyof typeof OPS;
