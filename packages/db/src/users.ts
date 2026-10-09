// Better Auth 를 거치지 않고 user 행을 쓰거나 찾는 우리 코드(관리자 API, 최초 설치, 가져오기)의 저장 계층.
// 이메일은 항상 소문자로 바꿔 쓴다 (계획서 3.2, V26). Better Auth 는 스스로 소문자로 바꾸지만, 직접 넣으면
// SQLite·Postgres 는 대소문자 중복을 받고 MySQL·MariaDB 는 정렬 규칙 때문에 거부해 DB 마다 결과가 달라진다.
import { eq } from "drizzle-orm";

// 방언마다 다른 Drizzle 타입을 한 함수로 받으려고 느슨하게 둔다. 실제 값은 생성 스키마와 그 DB 연결이다.
type AnyDb = any;
type Schema = { user: any };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface NewUser {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean;
}

/** user 행을 넣는다. 같은 이메일(대소문자 무시)이 있으면 DB 고유 제약 오류가 난다. */
export async function insertUser(db: AnyDb, schema: Schema, input: NewUser): Promise<void> {
  const now = new Date();
  await db.insert(schema.user).values({
    id: input.id,
    name: input.name,
    email: normalizeEmail(input.email),
    emailVerified: input.emailVerified ?? false,
    createdAt: now,
    updatedAt: now,
  });
}

export async function findUserByEmail(db: AnyDb, schema: Schema, email: string) {
  const [row] = await db.select().from(schema.user).where(eq(schema.user.email, normalizeEmail(email)));
  return row;
}
