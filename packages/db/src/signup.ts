// 가입 판정 한 곳 (계획서 4.2, 3단계 실행판 M2.T1~T3). 서버의 앞 판정(apps/server app.ts), Better Auth 의 앞 판정(hooks.before signUpGate)과
// 뒷받침 훅(databaseHooks.user.create.before, packages/auth)이 모두 decideSignup 하나를 부른다. 판정은 순수 함수이고, 입력(관리자 있음·설정·메일·오늘 가입 수)은
// loadSignupInputs 가 읽는다. 이 파일은 Workers 에서도 import 된다.
//   - 공개 가입(via public): open(메일 필요)·domain_allowlist(메일·도메인 정확히 일치 필요)만 통과한다. invite_only·closed·sso_only 는 signup_closed.
//     허용 도메인이 비면 어떤 이메일도 맞지 않는다 (빈 목록 = 모두 허용이 아니다, TC-M2.T2.d). 하루 상한에 닿았으면 signup_cap (Q13).
//   - 초대 가입(via invite): invite_only·open·domain_allowlist 는 통과, closed·sso_only 는 signup_closed (Q3). 상한·도메인을 보지 않는다.
//   - 통과하면 새 회원 값(data)을 같이 돌려준다. 공개 가입은 signup_requires_approval 이면 pending (Q6), 초대는 active.
//     monthly_limit_usd 는 default_limit_usd 를 복사한다 (NULL 은 무제한이라 비워 두면 기본 한도가 걸리지 않는다, Q16). max_keys 는 NULL(설정 기본값을 따른다).
// 하루 가입 수는 rate_limit 의 칸 signup-day|<UTC 날짜> 다. 세기(countSignup)는 회원 행이 커밋된 뒤 user.create.after 에서 하고, 앞 판정은 읽기만 한다 (Q13 (가)).
import { and, eq, sql } from "drizzle-orm";
import { mailSettingsExist, normalizeDomain, readSignupSettings, type SignupSettings } from "./settings.ts";

// 방언마다 다른 Drizzle 타입을 한 함수로 받으려고 느슨하게 둔다. 실제 값은 생성 스키마와 그 DB 연결이다.
type AnyDb = any;
type Schema = Record<string, any>; // user·appSettings·rateLimit 을 쓴다

/** 공개 자가 가입을 받는 signup_mode (Q1·Q19) */
const PUBLIC_SIGNUP_MODES: ReadonlySet<string> = new Set(["open", "domain_allowlist"]);
/** 초대 수락을 받는 signup_mode (Q3) */
const INVITE_SIGNUP_MODES: ReadonlySet<string> = new Set(["invite_only", "open", "domain_allowlist"]);

/** 거부 사유. 공개 가입 응답의 403 사유 코드 그대로다 (Q19 (가)). 같은 정책·같은 도메인이면 이메일 존재와 관계없이 같다 */
export type SignupDenial = "signup_closed" | "domain_not_allowed" | "mail_required" | "signup_cap";

export interface SignupInputs {
  /** 관리자가 있나 (= 최초 설치가 끝났나). 없으면 판정하지 않는다 — 서버가 setup_required 로 막는 구간이다 */
  adminExists: boolean;
  settings: SignupSettings;
  /** app_settings.mail_settings 행이 있나 (Q15) */
  mailConfigured: boolean;
  /** 오늘(UTC) 센 공개 가입 수 */
  todaySignups: number;
}

/** 초대 문맥 (packages/auth invite-context.ts 가 넘긴다). 이메일을 지정한 초대면 email, 수락이 인증을 대신하면 verified (Q5) */
export interface SignupInvite {
  role: "member" | "admin";
  email: string | null;
  verified: boolean;
}

/** 새 회원 값. Better Auth user.create.before 가 { data } 로 넣는다 (input: false 칼럼이라 요청 본문으로는 못 바꾼다) */
export interface NewMemberData {
  role: "member" | "admin";
  status: "pending" | "active";
  emailVerified?: boolean;
  monthlyLimitUsd: number;
  maxKeys: null;
}

export type SignupDecision = { ok: true; data: NewMemberData } | { ok: false; code: SignupDenial };

/**
 * 이메일의 도메인을 허용 목록과 같은 꼴(소문자·punycode)로. 주소가 아니면 null — null 은 어떤 허용 목록과도 맞지 않는다.
 * @ 가 정확히 하나여야 하고, 따옴표·공백·제어 문자가 든 주소는 받지 않는다 ("a@x"@example.com 처럼 도메인이 둘로 읽히는 꼴).
 * 국제 도메인은 NFC 로 쓴 꼴만 받는다. 전각 문자처럼 IDNA 가 다른 글자로 바꾸는 꼴(ｅｘａｍｐｌｅ.com)은 바꾸지 않고 거부한다.
 * 동형 문자(키릴 а)는 다른 punycode 가 되어 허용 목록과 맞지 않는다. 끝 점(example.com.)은 normalizeDomain 이 거부한다.
 */
export function emailDomain(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim();
  if (/["\s\u0000-\u001f\u007f]/.test(e)) return null;
  const parts = e.split("@");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  const raw = parts[1];
  if (raw.normalize("NFKC") !== raw) return null;
  return normalizeDomain(raw);
}

/**
 * 가입 판정. via public 은 공개 자가 가입(/sign-up/email, 서버 안 호출 포함), via invite 는 초대 문맥(runAsInvite) 안의 가입이다.
 * 이메일이 있는지는 보지 않는다 — 판정은 Better Auth 가 이메일을 찾기 전에 돈다 (Q19).
 */
export function decideSignup(i: { inputs: SignupInputs; email: unknown; via: "public" | "invite"; invite?: SignupInvite | null }): SignupDecision {
  const { settings } = i.inputs;
  const monthlyLimitUsd = settings.default_limit_usd;
  if (i.via === "invite") {
    if (!INVITE_SIGNUP_MODES.has(settings.signup_mode) || !i.invite) return { ok: false, code: "signup_closed" };
    // 이메일을 지정한 초대는 그 이메일로만 (Q4). 수락 API(M3)가 먼저 보지만 판정에서도 막는다
    if (i.invite.email !== null && (typeof i.email !== "string" || i.email.trim().toLowerCase() !== i.invite.email.trim().toLowerCase())) return { ok: false, code: "signup_closed" };
    return { ok: true, data: { role: i.invite.role, status: "active", emailVerified: i.invite.verified, monthlyLimitUsd, maxKeys: null } };
  }
  if (!PUBLIC_SIGNUP_MODES.has(settings.signup_mode)) return { ok: false, code: "signup_closed" };
  if (!i.inputs.mailConfigured) return { ok: false, code: "mail_required" };
  if (settings.signup_mode === "domain_allowlist") {
    const d = emailDomain(i.email);
    if (d === null || !settings.allowed_domains.includes(d)) return { ok: false, code: "domain_not_allowed" };
  }
  if (settings.daily_signup_cap !== null && i.inputs.todaySignups >= settings.daily_signup_cap) return { ok: false, code: "signup_cap" };
  return { ok: true, data: { role: "member", status: settings.signup_requires_approval ? "pending" : "active", emailVerified: false, monthlyLimitUsd, maxKeys: null } };
}

/** 관리자가 하나라도 있나 (= 최초 설치가 끝났나) */
export async function hasAdmin(db: AnyDb, schema: Schema): Promise<boolean> {
  const u = schema.user;
  return (await db.select({ id: u.id }).from(u).where(eq(u.role, "admin")).limit(1)).length > 0;
}

/** 하루 가입 수 칸의 키 (UTC 날짜) */
export const signupDayKey = (now: Date) => `signup-day|${now.toISOString().slice(0, 10)}`;

/** 오늘(UTC) 센 공개 가입 수 */
export async function todaySignups(db: AnyDb, schema: Schema, now: Date): Promise<number> {
  const t = schema.rateLimit;
  const [row] = await db.select({ count: t.count }).from(t).where(eq(t.key, signupDayKey(now)));
  return row ? Number(row.count) : 0;
}

/** 판정 입력. 요청 하나에서 한 번만 읽는다 (서버는 요청 문맥에 메모한다, apps/server/src/signup/request-memo.ts) */
export async function loadSignupInputs(db: AnyDb, schema: Schema, now: Date = new Date()): Promise<SignupInputs> {
  const [adminExists, settings, mailConfigured, today] = await Promise.all([hasAdmin(db, schema), readSignupSettings(db, schema), mailSettingsExist(db, schema), todaySignups(db, schema, now)]);
  return { adminExists, settings, mailConfigured, todaySignups: today };
}

/**
 * 공개 가입 하나를 센다 (Q13 (가)). 회원 행이 커밋된 뒤(user.create.after)에만 부른다. 상한을 넘어도 센다 — 센 값이 실제로 생긴 공개 가입 수와 같아야
 * 다음 앞 판정이 맞는다. 세 문장은 각각 한 문장이라 D1 에서도 동시 가입이 칸을 잃지 않는다 (routes/guard.ts consume 과 같은 모양).
 * 지난 날의 칸은 지운다 (키에 날짜가 있어 겹치지 않는다).
 */
export async function countSignup(db: AnyDb, schema: Schema, provider: "sqlite" | "mysql" | "pg", now: Date): Promise<void> {
  const t = schema.rateLimit;
  const key = signupDayKey(now);
  const ms = now.getTime();
  await db.delete(t).where(and(sql`${t.key} like 'signup-day|%'`, sql`${t.key} <> ${key}`));
  const row = { id: crypto.randomUUID(), key, count: 1, lastRequest: ms };
  const inserted = provider === "mysql" ? (await db.insert(t).ignore().values(row))[0].affectedRows === 1 : (await db.insert(t).values(row).onConflictDoNothing().returning()).length === 1;
  if (inserted) return;
  await db.update(t).set({ count: sql`${t.count} + 1`, lastRequest: ms }).where(eq(t.key, key));
}
