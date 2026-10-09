// 최초 설치 (계획서 4.7 1·2·4·5번).
//   1. 관리자가 없으면 시작할 때 일회용 설치 토큰을 만들어 콘솔에 한 번 출력한다. DB 에는 SHA-256 해시만 둔다 (7장).
//   2. POST /api/setup 에서 토큰 + 이메일·비밀번호로 최초 관리자를 만든다 (role=admin, is_bootstrap_admin, 이메일 인증 완료).
//   4. 회원이 도구에 넣을 공개 주소(public_base_url)를 저장한다.
//   5. 메일 발송 설정(선택). 지금은 Resend 하나만 받고, API 키는 APP_ENCRYPTION_KEY 로 암호화해 둔다 (mail.ts).
//   3. OmniRoute 부트스트랩(oma_live_ 토큰 발급·암호화 저장)은 S5 가 setup/omniroute.ts 로 만들어
//      아래 "OmniRoute 부트스트랩 자리"에 붙인다. 관리자 생성과 같은 요청에서 돌지, 다음 화면에서 돌지는 S5 에서 정한다.
// 관리자가 생긴 뒤에는 /api/setup 이 항상 409 다. 토큰도 다시 만들지 않는다.
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { normalizeEmail } from "@magnetosphere/db/src/users.ts";
import type { Cipher } from "@magnetosphere/runtime/crypto";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { MAIL_API_KEY_AAD, MAIL_SETTINGS_KEY } from "./mail.ts";

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

/** 지운 행 수 (MySQL 은 RETURNING 이 없어 영향 행 수로 본다) */
async function deleteCount(h: DbHandle, table: any, where: unknown): Promise<number> {
  if (h.provider === "mysql") {
    const [r] = await h.db.delete(table).where(where);
    return r.affectedRows;
  }
  return (await h.db.delete(table).where(where).returning()).length;
}

export interface IssueOptions {
  log: (line: string) => void;
  /** true 면 이미 있는 토큰을 새로 바꾼다 (Node 시작 때). false 면 없을 때만 만든다 (Workers 첫 요청) */
  rotate: boolean;
}

/** 관리자가 없으면 설치 토큰을 만들어 log 로 한 번 내보낸다. 만든 토큰(없으면 null)을 돌려준다 */
export async function ensureSetupToken(h: DbHandle, opts: IssueOptions): Promise<string | null> {
  if (await adminExists(h)) return null;
  if (!opts.rotate && (await readSetting(h, SETUP_TOKEN_KEY)) !== undefined) return null;
  const token = newToken();
  await writeSetting(h, SETUP_TOKEN_KEY, await sha256Hex(token), null);
  opts.log(`[setup] 최초 설치 토큰: ${token}\n[setup] /setup 화면에 넣어 첫 관리자를 만든다. 다시 출력하지 않는다.`);
  return token;
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
  | { ok: true; userId: string }
  | { ok: false; status: 400 | 401 | 409; error: string };

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

export async function runSetup(h: DbHandle, input: Partial<SetupInput>, cipher: () => Promise<Cipher>): Promise<SetupResult> {
  if (await adminExists(h)) return { ok: false, status: 409, error: "already_set_up" };
  const stored = await readSetting(h, SETUP_TOKEN_KEY);
  const given = typeof input.token === "string" ? await sha256Hex(input.token.trim()) : "";
  if (typeof stored !== "string" || !sameText(given, stored)) return { ok: false, status: 401, error: "invalid_token" };
  const bad = invalid(input);
  if (bad) return { ok: false, status: 400, error: `invalid_${bad}` };
  const v = input as SetupInput;

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
    await writeSetting(h, SETUP_TOKEN_KEY, stored, null);
    throw e;
  }

  await writeSetting(h, PUBLIC_BASE_URL_KEY, v.publicBaseUrl.trim(), userId);
  if (v.mail) {
    const c = await cipher();
    await writeSetting(h, MAIL_SETTINGS_KEY, { provider: "resend", from: v.mail.from.trim(), apiKey: await c.encrypt(v.mail.apiKey.trim(), MAIL_API_KEY_AAD) }, userId);
  }
  // OmniRoute 부트스트랩 자리 (계획서 4.7 3번, S5 의 setup/omniroute.ts)
  return { ok: true, userId };
}
