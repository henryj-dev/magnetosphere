// 가입 판정과 새 회원 기본값 (계획서 4.2). 서버의 경로 검사(apps/server app.ts)와 Better Auth 사용자 생성 훅(packages/auth)이 같이 쓴다.
// 3단계(가입 정책·초대) 전의 임시 규칙이다 — 3단계 실행판 Q1·Q16 이 이 파일을 바꾼다.
//   - 관리자가 생긴 뒤에는 signup_mode 가 무엇이든 공개 자가 가입을 받지 않는다 (PUBLIC_SIGNUP_MODES 가 비어 있다).
//     지금 있는 값은 시드 invite_only 뿐이고 초대 수락 경로가 아직 없어, 받을 수 있는 공개 가입이 없다.
//   - Better Auth 로 만드는 회원의 monthly_limit_usd 는 default_limit_usd 를 복사한다. NULL 은 무제한이라(5.3·5.9)
//     비워 두면 기본 한도가 걸리지 않는다. 관리자가 PATCH /api/admin/users/:id 로 null(무제한)을 고르는 것은 그대로다.
import { eq } from "drizzle-orm";
import { DEFAULT_SETTINGS } from "./seed.ts";

// 방언마다 다른 Drizzle 타입을 한 함수로 받으려고 느슨하게 둔다. 실제 값은 생성 스키마와 그 DB 연결이다.
type AnyDb = any;
type Schema = Record<string, any>; // user·appSettings 를 쓴다

/**
 * 공개 자가 가입을 받는 signup_mode 값. 3단계 전까지 비어 있다 — 어떤 값이든(설정 행이 없어도) 공개 가입은 닫힌다.
 * 3단계가 open·domain_allowlist 판정을 넣을 때 여기를 바꾼다 (3단계 실행판 Q1).
 */
const PUBLIC_SIGNUP_MODES: ReadonlySet<string> = new Set();

async function readSetting(db: AnyDb, schema: Schema, key: string): Promise<unknown> {
  const t = schema.appSettings;
  const [row] = await db.select({ value: t.value }).from(t).where(eq(t.key, key));
  return row ? JSON.parse(row.value) : undefined;
}

/** 관리자가 하나라도 있나 (= 최초 설치가 끝났나) */
export async function hasAdmin(db: AnyDb, schema: Schema): Promise<boolean> {
  const u = schema.user;
  return (await db.select({ id: u.id }).from(u).where(eq(u.role, "admin")).limit(1)).length > 0;
}

/** 설치가 끝난 뒤 공개 자가 가입이 닫혀 있나. 설치 전 판정(setup_required)은 부르는 쪽이 따로 한다 */
export async function publicSignupClosed(db: AnyDb, schema: Schema): Promise<boolean> {
  const mode = await readSetting(db, schema, "signup_mode");
  return !(typeof mode === "string" && PUBLIC_SIGNUP_MODES.has(mode));
}

/**
 * 새 회원의 월 한도. app_settings.default_limit_usd 가 0 이상 수면 그 값, 아니면(행 없음 — 운영에서는 시드를 돌리지 않는다,
 * null·잘못된 값) 시드 기본값. null(무제한 기본값)은 3단계 설정 API 가 생길 때 Q16 으로 정한다.
 */
export async function defaultMonthlyLimit(db: AnyDb, schema: Schema): Promise<number> {
  const v = await readSetting(db, schema, "default_limit_usd");
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS.default_limit_usd;
}
