// 최초 설치 (계획서 4.7 1·2·4·5번).
//   1. 관리자가 없으면 시작할 때 일회용 설치 토큰을 만들어 콘솔에 한 번 출력한다. DB 에는 SHA-256 해시만 둔다 (7장).
//   2. POST /api/setup 에서 토큰 + 이메일·비밀번호로 최초 관리자를 만든다 (role=admin, is_bootstrap_admin, 이메일 인증 완료).
//   4. 회원이 도구에 넣을 공개 주소(public_base_url)를 저장한다.
//   5. 메일 발송 설정(선택). 지금은 Resend 하나만 받고, API 키는 APP_ENCRYPTION_KEY 로 암호화해 둔다 (mail.ts).
//   3. OmniRoute 부트스트랩(oma_live_ 토큰 발급·암호화 저장, setup/omniroute.ts)은 관리자를 만든 같은 요청에서 돈다.
//      실패해도 설치는 끝나고 응답의 omniroute 가 "manual_required" 다. 관리자가 로그인해 토큰을 붙여 넣는다 (routes.ts).
// 관리자가 생긴 뒤에는 /api/setup 이 항상 409 다. 토큰도 다시 만들지 않는다.
import { and, eq, lt, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { findUserByEmail, normalizeEmail } from "@magnetosphere/db/src/users.ts";
import type { Cipher } from "@magnetosphere/runtime/crypto";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { MAIL_API_KEY_AAD, MAIL_SETTINGS_KEY } from "./mail.ts";
import type { OmniRouteStatus } from "./omniroute.ts";

export const SETUP_TOKEN_KEY = "setup_token_hash";
export const PUBLIC_BASE_URL_KEY = "public_base_url";
// Better Auth emailAndPassword 기본 길이 제한과 같게 둔다
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 길이가 같은 두 문자열을 시간 차 없이 비교한다 */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function adminExists(h: DbHandle): Promise<boolean> {
  const u = h.schema.user;
  const rows = await h.db.select({ id: u.id }).from(u).where(eq(u.role, "admin")).limit(1);
  return rows.length > 0;
}

async function readSetting(h: DbHandle, key: string): Promise<unknown> {
  const t = h.schema.appSettings;
  const [row] = await h.db.select({ value: t.value }).from(t).where(eq(t.key, key));
  return row ? JSON.parse(row.value) : undefined;
}

/** app_settings 값 바꾸기. 방언마다 다른 upsert 대신 지우고 넣는다 (설치 때 한 번 쓰는 값들이다) */
export async function writeSetting(h: DbHandle, key: string, value: unknown, updatedBy: string | null): Promise<void> {
  const t = h.schema.appSettings;
  await h.db.delete(t).where(eq(t.key, key));
  await h.db.insert(t).values({ key, value: JSON.stringify(value), updatedAt: new Date(), updatedBy });
}

/**
 * 소비한 설치 토큰 해시를 되돌린다. 그사이 다른 인스턴스가 새 토큰을 넣었으면(행이 있으면) 건드리지 않는다
 * — 새 토큰을 옛 토큰으로 덮으면 운영자가 방금 본 토큰이 듣지 않는다 (S4 보안 리뷰 L5).
 */
export async function restoreSetupToken(h: DbHandle, hash: string): Promise<void> {
  const t = h.schema.appSettings;
  const row = { key: SETUP_TOKEN_KEY, value: JSON.stringify(hash), updatedAt: new Date(), updatedBy: null };
  if (h.provider === "mysql") await h.db.insert(t).ignore().values(row);
  else await h.db.insert(t).values(row).onConflictDoNothing();
}

/** 지운 행 수 (MySQL 은 RETURNING 이 없어 영향 행 수로 본다) */
async function deleteCount(h: DbHandle, table: any, where: unknown): Promise<number> {
  if (h.provider === "mysql") {
    const [r] = await h.db.delete(table).where(where);
    return r.affectedRows;
  }
  return (await h.db.delete(table).where(where).returning()).length;
}

/** 운영자가 출력을 못 본 채 잃었을 수 있는 설치 토큰을 다시 만드는 나이 (Workers, S4 보안 리뷰 M2) */
export const SETUP_TOKEN_MAX_AGE_MS = 15 * 60_000;

export interface IssueOptions {
  log: (line: string) => void;
  /** true 면 이미 있는 토큰을 새로 바꾼다 (Node 시작 때). false 면 없거나 15분보다 오래됐을 때만 만든다 (Workers GET /api/setup) */
  rotate: boolean;
  /**
   * 운영자가 정한 설치 토큰 (SETUP_TOKEN 시크릿). 있으면 무작위로 만들지 않고 이 값의 해시를 두며, 로그에 토큰을 내지 않는다.
   * 운영자가 이미 아는 값이라 출력을 잃을 일이 없다.
   */
  fixedToken?: string | null;
  now?: () => Date;
}

/** 운영자가 정한 설치 토큰(SETUP_TOKEN)의 최소 길이. openssl rand -base64 32 는 44자다 (S6 보안 리뷰 M1) */
export const SETUP_TOKEN_MIN_LENGTH = 32;

/** SETUP_TOKEN 이 너무 짧으면 시작을 거부한다. 공개 주소에서 무차별 대입으로 첫 관리자를 가로챌 수 있다 */
export function assertSetupTokenStrength(token: string | null | undefined): void {
  if (token && token.trim().length < SETUP_TOKEN_MIN_LENGTH) {
    throw new Error(`SETUP_TOKEN 은 ${SETUP_TOKEN_MIN_LENGTH}자 이상이어야 한다 (지금 ${token.trim().length}자). openssl rand -base64 32 로 만든다`);
  }
}

/** POST /api/setup 시도 한도: 클라이언트 IP 마다 SETUP_ATTEMPT_WINDOW_MS 동안 SETUP_ATTEMPT_MAX 회 (S6 보안 리뷰 M1) */
export const SETUP_ATTEMPT_MAX = 10;
export const SETUP_ATTEMPT_WINDOW_MS = 10 * 60_000;

/**
 * 설치 시도 한 번을 센다. 한도 안이면 true. Better Auth 와 같은 rate_limit 테이블을 쓰되 키 앞머리("setup-attempt|")로 구분한다.
 * 창은 첫 시도 때 시작한다(last_request = 창 시작). 지난 창은 지우고, 없을 때만 넣고, 한도 아래일 때만 1 늘린다 —
 * 세 문장 모두 조건부라 여러 요청·인스턴스가 동시에 와도 한도를 넘겨 세지 않는다.
 */
export async function consumeSetupAttempt(h: DbHandle, ip: string | null, now = Date.now()): Promise<boolean> {
  const t = h.schema.rateLimit;
  const key = `setup-attempt|${ip ?? "unknown"}`;
  await h.db.delete(t).where(and(eq(t.key, key), lt(t.lastRequest, now - SETUP_ATTEMPT_WINDOW_MS)));
  const row = { id: crypto.randomUUID(), key, count: 1, lastRequest: now };
  const inserted =
    h.provider === "mysql"
      ? (await h.db.insert(t).ignore().values(row))[0].affectedRows === 1
      : (await h.db.insert(t).values(row).onConflictDoNothing().returning()).length === 1;
  if (inserted) return true;
  const bump = h.db.update(t).set({ count: sql`${t.count} + 1` }).where(and(eq(t.key, key), lt(t.count, SETUP_ATTEMPT_MAX)));
  if (h.provider === "mysql") return (await bump)[0].affectedRows === 1;
  return (await bump.returning()).length === 1;
}

/** 설치 토큰 행을 없을 때만 넣는다. 넣었으면 true (동시에 둘이 넣어도 하나만 true, 고유 키 충돌로 500 이 나지 않는다) */
async function insertTokenIfAbsent(h: DbHandle, hash: string, at: Date): Promise<boolean> {
  const t = h.schema.appSettings;
  const row = { key: SETUP_TOKEN_KEY, value: JSON.stringify(hash), updatedAt: at, updatedBy: null };
  if (h.provider === "mysql") {
    const [r] = await h.db.insert(t).ignore().values(row);
    return r.affectedRows === 1;
  }
  return (await h.db.insert(t).values(row).onConflictDoNothing().returning()).length === 1;
}

/**
 * 관리자가 없으면 설치 토큰을 정한다. 무작위로 만든 토큰은 log 로 한 번 내보낸다. 새로 정한 토큰(없으면 null)을 돌려준다.
 * - rotate: 있던 토큰을 지우고 새로 만든다 (Node 는 시작할 때마다 새 토큰을 출력한다).
 * - rotate 가 아니면: 없을 때, 또는 저장한 토큰이 SETUP_TOKEN_MAX_AGE_MS 보다 오래됐을 때만 만든다. 옛 행을 그 값 그대로일 때만
 *   지우고(조건부 삭제) 없을 때만 넣으므로(조건부 쓰기) 처음 GET 이 동시에 여럿 와도 토큰은 하나, 출력도 한 번이다.
 */
export async function ensureSetupToken(h: DbHandle, opts: IssueOptions): Promise<string | null> {
  if (await adminExists(h)) return null;
  const now = opts.now?.() ?? new Date();
  const t = h.schema.appSettings;
  const fixed = opts.fixedToken?.trim() || null;
  const token = fixed ?? newToken();
  const hash = await sha256Hex(token);
  const [row] = await h.db.select({ value: t.value, updatedAt: t.updatedAt }).from(t).where(eq(t.key, SETUP_TOKEN_KEY));
  if (row) {
    if (fixed && JSON.parse(row.value) === hash) return null;
    const fresh = now.getTime() - new Date(row.updatedAt).getTime() < SETUP_TOKEN_MAX_AGE_MS;
    if (!opts.rotate && !fixed && fresh) return null;
    // 그사이 다른 요청이 바꿨으면 지우지 못한다. 그쪽 토큰을 그대로 둔다
    if ((await deleteCount(h, t, and(eq(t.key, SETUP_TOKEN_KEY), eq(t.value, row.value)))) !== 1) return null;
  }
  if (!(await insertTokenIfAbsent(h, hash, now))) return null;
  if (!fixed) opts.log(`[setup] 최초 설치 토큰: ${token}\n[setup] /setup 화면에 넣어 첫 관리자를 만든다. 다시 출력하지 않는다.`);
  return token;
}

/**
 * 관리자가 있는데 OMNIROUTE_INITIAL_PASSWORD 가 아직 회원 앱 환경에 있으면 경고 한 줄을 남긴다 (S5 보안 리뷰 M2, TC-S6.T2.g).
 * 이 비밀번호로는 OmniRoute admin 접근 토큰도 만들 수 있어 설치 뒤에는 지워야 한다 (Compose 는 .env.setup 삭제).
 * 값은 출력하지 않는다. 경고를 냈으면 true.
 */
export async function warnLeftoverInitialPassword(h: DbHandle, initialPassword: string | null, log: (line: string) => void): Promise<boolean> {
  if (!initialPassword || !(await adminExists(h))) return false;
  log("[setup] 경고: 최초 설치가 끝났는데 OMNIROUTE_INITIAL_PASSWORD 가 남아 있다. .env.setup(Workers 는 해당 시크릿)을 지우고 다시 띄운다.");
  return true;
}

export interface SetupInput {
  token: string;
  email: string;
  password: string;
  name?: string;
  publicBaseUrl: string;
  mail?: { provider: "resend"; apiKey: string; from: string };
}

export type SetupResult =
  | { ok: true; userId: string; omniroute: OmniRouteStatus }
  | { ok: false; status: 400 | 401 | 409; error: string };

const EMAIL_TAKEN = { ok: false, status: 409, error: "email_taken" } as const;

function invalid(input: Partial<SetupInput>): string | null {
  const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  if (!isText(input.email) || !/^[^\s@]+@[^\s@]+$/.test(input.email.trim())) return "email";
  if (typeof input.password !== "string" || input.password.length < PASSWORD_MIN || input.password.length > PASSWORD_MAX) return "password";
  if (!isText(input.publicBaseUrl)) return "publicBaseUrl";
  try {
    if (!["http:", "https:"].includes(new URL(input.publicBaseUrl).protocol)) return "publicBaseUrl";
  } catch {
    return "publicBaseUrl";
  }
  if (input.mail !== undefined && (input.mail?.provider !== "resend" || !isText(input.mail.apiKey) || !isText(input.mail.from))) return "mail";
  return null;
}

/**
 * bootstrapOmniRoute: 관리자를 만든 뒤 부를 OmniRoute 부트스트랩 (setup/omniroute.ts). 예외를 던지지 않고 상태를 돌려준다.
 * 없으면 "manual_required".
 */
export async function runSetup(
  h: DbHandle,
  input: Partial<SetupInput>,
  cipher: () => Promise<Cipher>,
  bootstrapOmniRoute?: (userId: string) => Promise<OmniRouteStatus>,
): Promise<SetupResult> {
  if (await adminExists(h)) return { ok: false, status: 409, error: "already_set_up" };
  const stored = await readSetting(h, SETUP_TOKEN_KEY);
  const given = typeof input.token === "string" ? await sha256Hex(input.token.trim()) : "";
  if (typeof stored !== "string" || !sameText(given, stored)) return { ok: false, status: 401, error: "invalid_token" };
  const bad = invalid(input);
  if (bad) return { ok: false, status: 400, error: `invalid_${bad}` };
  const v = input as SetupInput;
  // 같은 이메일 계정이 이미 있으면 토큰을 소비하지 않고 알려 준다 (설치 전 가입은 서버가 막지만, 그 전에 생긴 계정도 있을 수 있다)
  if (await findUserByEmail(h.db, { user: h.schema.user }, v.email)) return EMAIL_TAKEN;

  // 토큰을 먼저 지워 소비한다. 동시에 두 요청이 와도 지운 쪽 하나만 관리자를 만든다
  const s = h.schema.appSettings;
  if ((await deleteCount(h, s, and(eq(s.key, SETUP_TOKEN_KEY), eq(s.value, JSON.stringify(stored))))) !== 1) {
    return { ok: false, status: 409, error: "already_set_up" };
  }

  const userId = crypto.randomUUID();
  const now = new Date();
  try {
    // Better Auth 가입 경로는 인증 메일을 보내고 권한 칼럼을 받지 않으므로(input: false) 행을 직접 만든다.
    // 비밀번호 해시와 credential 계정 모양은 Better Auth 이메일 가입과 같다 (만든 뒤 /sign-in/email 로 로그인된다)
    await h.db.insert(h.schema.user).values({
      id: userId,
      name: v.name?.trim() || normalizeEmail(v.email),
      email: normalizeEmail(v.email),
      emailVerified: true,
      role: "admin",
      isBootstrapAdmin: true,
      createdAt: now,
      updatedAt: now,
    });
    await h.db.insert(h.schema.account).values({
      id: crypto.randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(v.password),
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    // 반쯤 만든 관리자를 지우고 토큰을 되돌려 다시 시도할 수 있게 한다 (D1 은 대화형 트랜잭션이 없다)
    await h.db.delete(h.schema.account).where(eq(h.schema.account.userId, userId));
    await h.db.delete(h.schema.user).where(eq(h.schema.user.id, userId));
    await restoreSetupToken(h, stored);
    // 위 검사와 관리자 생성 사이에 같은 이메일이 들어왔으면 고유 제약 위반이다. 500 대신 409 로 알린다
    if (await findUserByEmail(h.db, { user: h.schema.user }, v.email)) return EMAIL_TAKEN;
    throw e;
  }

  await writeSetting(h, PUBLIC_BASE_URL_KEY, v.publicBaseUrl.trim(), userId);
  if (v.mail) {
    const c = await cipher();
    await writeSetting(h, MAIL_SETTINGS_KEY, { provider: "resend", from: v.mail.from.trim(), apiKey: await c.encrypt(v.mail.apiKey.trim(), MAIL_API_KEY_AAD) }, userId);
  }
  // OmniRoute 부트스트랩 (계획서 4.7 3번). 관리자를 만든 뒤라 실패해도 관리자는 남는다 (TC-S5.T3.c)
  const omniroute = bootstrapOmniRoute ? await bootstrapOmniRoute(userId) : "manual_required";
  return { ok: true, userId, omniroute };
}
