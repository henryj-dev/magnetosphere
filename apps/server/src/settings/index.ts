// 설정 저장소 하나 (3단계 실행판 M1.T1, 계획서 4.2·5.9). 가입 정책 설정 여섯 키의 읽기·값 검사·정책 검사와
// app_settings 쓰기(upsert 한 문장)를 여기 둔다. 3단계 코드(가입 판정·설정 API·초대)는 이것만 쓴다.
//   - 읽기(readSettings): 행이 없으면 시드 기본값(DEFAULT_SETTINGS, allowed_domains 는 [])을 쓴다 (TC-M1.T1.c).
//     행이 있는데 값이 깨졌으면(검사에 맞지 않음·JSON 아님) 경고를 남기고 더 닫힌 값(BROKEN)으로 읽는다. 시드 값으로 읽으면
//     운영자가 둔 closed·cap 0 이 invite_only·20 으로 열린다 (TC-M1.T1.e, M1 리뷰 낮음 1).
//   - 쓰기(writeSetting): 키마다 zod 로 값을 검사·정규화하고, 정책 검사(메일·도메인·IdP)를 지난 값만 upsert 한다.
//     어긋나면 SettingsError 를 던지고 아무것도 쓰지 않는다 (TC-M1.T1.a·b).
//   - 정책 키가 아닌 값(public_base_url, mail_settings, OmniRoute 토큰 등)은 writeAppSetting 으로 같은 upsert 를 쓴다.
//   - 설정 API(M2.T5): checkSettings 가 여러 키를 바꾼 뒤 상태로 한 번에 검사하고, commitSettings 가 키마다 updated_at 조건부 쓰기와
//     감사 기록을 한 트랜잭션(D1 은 batch)으로 보낸다. 읽은 뒤 다른 쓰기가 끼었으면 stale_setting 이고 아무것도 남지 않는다 (M1 리뷰).
// 2단계 한도 분배의 설정 쓰기(limits/store.ts, 임대 펜싱)는 봉인한 시험이 걸려 있어 옮기지 않는다 (실행판 백로그).
import { and, eq, sql } from "drizzle-orm";
import {
  isSettingKey,
  mailSettingsExist,
  readSignupSettings,
  SETTING_SCHEMAS as SCHEMAS,
  type SettingKey,
  type SignupSettings,
} from "@magnetosphere/db/src/settings.ts";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { auditStatement, type AuditEntry } from "../audit/index.ts";

// 값 검사·읽기 규칙은 packages/db/src/settings.ts 에 있다 (Better Auth 가입 훅이 같은 규칙으로 읽는다, M2.T2)
export {
  MAX_ALLOWED_DOMAINS,
  MAX_USD,
  normalizeDomain,
  SETTING_KEYS,
  SIGNUP_MODES,
  type SettingKey,
  type SignupMode,
  type SignupSettings,
} from "@magnetosphere/db/src/settings.ts";

export type SettingsErrorCode = "unknown_key" | "policy_key" | "invalid_value" | "mail_required" | "domains_required" | "no_idp" | "stale_setting";

/** 저장하지 않은 설정. code 는 설정 API 의 오류 코드로 그대로 쓴다 (invalid_value 400, 나머지 409) */
export class SettingsError extends Error {
  readonly code: SettingsErrorCode;
  readonly key: string;
  constructor(code: SettingsErrorCode, key: string) {
    super(`설정 ${key}: ${code}`);
    this.name = "SettingsError";
    this.code = code;
    this.key = key;
  }
}

/** 정책 설정 여섯 키. 행이 없으면 시드 기본값, 값이 깨졌으면 경고와 함께 더 닫힌 값 */
export async function readSettings(h: DbHandle): Promise<SignupSettings> {
  return readSignupSettings(h.db, h.schema);
}

/** 메일이 설정됐나 = app_settings.mail_settings 행이 있다 (Q15) */
export async function mailConfigured(h: DbHandle): Promise<boolean> {
  return mailSettingsExist(h.db, h.schema);
}

/** 켜진 IdP 가 하나라도 있나 (sso_provider_settings.enabled). IdP 는 5단계에 생기므로 3단계에는 늘 false (Q18) */
async function idpEnabled(h: DbHandle): Promise<boolean> {
  const t = h.schema.ssoProviderSettings;
  return (await h.db.select({ id: t.providerId }).from(t).where(eq(t.enabled, true)).limit(1)).length > 0;
}

/**
 * 정책 검사 (계획서 4.2 "메일이 설정되지 않았으면 고를 수 없다", Q15·Q18).
 * 검사와 쓰기는 한 문장이 아니다. 그사이 다른 쓰기가 allowed_domains 를 비우면 domain_allowlist + [] 가 남을 수 있지만,
 * 그 상태의 가입 판정은 어떤 도메인과도 맞지 않아 모두 거부된다 (fail-closed). 메일 설정은 지우는 API 가 없다 (Q15).
 */
async function checkPolicy(h: DbHandle, key: SettingKey, value: unknown): Promise<void> {
  if (key === "signup_mode") {
    if ((value === "open" || value === "domain_allowlist") && !(await mailConfigured(h))) throw new SettingsError("mail_required", key);
    if (value === "domain_allowlist" && (await readSettings(h)).allowed_domains.length === 0) throw new SettingsError("domains_required", key);
    if (value === "sso_only" && !(await idpEnabled(h))) throw new SettingsError("no_idp", key);
  }
  if (key === "allowed_domains" && (value as string[]).length === 0 && (await readSettings(h)).signup_mode === "domain_allowlist") {
    throw new SettingsError("domains_required", key);
  }
}

/** app_settings 한 행 upsert. 한 문장이라 같은 키를 동시에 써도 행이 사라지거나 기본 키 충돌이 나지 않는다 (TC-M1.T1.d) */
async function upsert(h: DbHandle, key: string, value: unknown, updatedBy: string | null, now: Date): Promise<void> {
  await upsertStatement(h, h.db, key, value, updatedBy, now);
}

/** upsert 한 문장 (실행하지 않은 문). db 는 트랜잭션(tx)이나 D1 batch 에 넣을 연결 */
function upsertStatement(h: DbHandle, db: any, key: string, value: unknown, updatedBy: string | null, now: Date) {
  const t = h.schema.appSettings;
  const json = JSON.stringify(value);
  const set = { value: json, updatedAt: now, updatedBy };
  const insert = db.insert(t).values({ key, ...set });
  return h.provider === "mysql" ? insert.onDuplicateKeyUpdate({ set }) : insert.onConflictDoUpdate({ target: t.key, set });
}

/** 정책 키가 아닌 값(메일 설정 등) 쓰기와 감사 기록 한 행을 같이 (Node 는 트랜잭션, D1 은 batch) (M2.T5) */
export async function commitAppSetting(h: DbHandle, key: string, value: unknown, actorId: string | null, now: Date, audit: AuditEntry): Promise<void> {
  if (isSettingKey(key)) throw new SettingsError("policy_key", key);
  if (h.kind === "d1") {
    await h.db.batch([upsertStatement(h, h.db, key, value, actorId, now), auditStatement(h, audit)]);
    return;
  }
  await h.db.transaction(async (tx: any) => {
    await upsertStatement(h, tx, key, value, actorId, now);
    await auditStatement(h, audit, tx);
  });
}

/** 정책 설정 하나를 검사해 쓴다. 저장한 값(정규화한 값)을 돌려준다. 어긋나면 SettingsError, 행은 그대로 */
export async function writeSetting<K extends SettingKey>(h: DbHandle, key: K, value: unknown, actorId: string | null, now: Date): Promise<SignupSettings[K]> {
  if (!isSettingKey(key)) throw new SettingsError("unknown_key", String(key));
  const p = SCHEMAS[key].safeParse(value);
  if (!p.success) throw new SettingsError("invalid_value", key);
  await checkPolicy(h, key, p.data);
  await upsert(h, key, p.data, actorId, now);
  return p.data as SignupSettings[K];
}

/** 정책 키가 아닌 app_settings 값 쓰기 (설치의 public_base_url·mail_settings 등). 정책 키는 writeSetting 만 쓴다 */
export async function writeAppSetting(h: DbHandle, key: string, value: unknown, updatedBy: string | null, now: Date): Promise<void> {
  if (isSettingKey(key)) throw new SettingsError("policy_key", key);
  await upsert(h, key, value, updatedBy, now);
}


/**
 * 설정 API 의 정책 검사 (M2.T5). 바꾸는 키들을 값 검사·정규화하고, 바꾼 뒤 상태로 정책 검사(메일·도메인·IdP)를 한다.
 * domain_allowlist 와 허용 도메인을 한 요청에서 같이 바꿀 수 있다. 정규화한 값을 돌려준다. 어긋나면 SettingsError, 아무것도 쓰지 않는다.
 */
export async function checkSettings(h: DbHandle, changes: Record<string, unknown>): Promise<Partial<SignupSettings>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!isSettingKey(key)) throw new SettingsError("unknown_key", key);
    const p = SCHEMAS[key].safeParse(value);
    if (!p.success) throw new SettingsError("invalid_value", key);
    out[key] = p.data;
  }
  const next = { ...(await readSettings(h)), ...out } as SignupSettings;
  if ("signup_mode" in out) {
    if ((next.signup_mode === "open" || next.signup_mode === "domain_allowlist") && !(await mailConfigured(h))) throw new SettingsError("mail_required", "signup_mode");
    if (next.signup_mode === "sso_only" && !(await idpEnabled(h))) throw new SettingsError("no_idp", "signup_mode");
  }
  if (("signup_mode" in out || "allowed_domains" in out) && next.signup_mode === "domain_allowlist" && next.allowed_domains.length === 0) {
    throw new SettingsError("domains_required", "allowed_domains" in out ? "allowed_domains" : "signup_mode");
  }
  return out as Partial<SignupSettings>;
}

/** 조건부 쓰기 하나. expected 는 읽은 updated_at 이고, 행이 없었으면 null 이다 (그때는 행이 없을 때만 넣는다) */
export interface SettingWrite {
  key: string;
  value: unknown;
  expected: Date | null;
}

/** 키 하나의 조건부 쓰기 문장. 새 updated_at 은 읽은 값보다 늘 뒤다 (같은 밀리초에 다시 써도 조건이 갈린다) */
function casStatement(h: DbHandle, db: any, w: SettingWrite, actorId: string | null, now: Date) {
  const t = h.schema.appSettings;
  const at = new Date(Math.max(now.getTime(), (w.expected?.getTime() ?? 0) + 1));
  const row = { value: JSON.stringify(w.value), updatedAt: at, updatedBy: actorId };
  if (w.expected === null) {
    const insert = db.insert(t);
    return h.provider === "mysql" ? insert.ignore().values({ key: w.key, ...row }) : insert.values({ key: w.key, ...row }).onConflictDoNothing();
  }
  return db.update(t).set(row).where(and(eq(t.key, w.key), eq(t.updatedAt, w.expected)));
}

/** 문장이 바꾼 행 수 (mysql 은 affectedRows, sqlite·pg 는 RETURNING 행 수) */
async function affected(h: DbHandle, stmt: any): Promise<number> {
  if (h.provider === "mysql") return (await stmt)[0].affectedRows;
  return (await stmt.returning({ key: h.schema.appSettings.key })).length;
}

/** D1 batch 안에서 바로 앞 조건부 쓰기가 0행이면 value 를 NULL 로 바꿔 NOT NULL 제약으로 batch 전체를 되돌린다 (D1 batch 는 한 트랜잭션이다) */
const STALE_GUARD = /NOT NULL constraint failed: app_settings\.value/;
function guardStatement(h: DbHandle, key: string) {
  const t = h.schema.appSettings;
  return h.db.update(t).set({ value: sql`CASE WHEN changes() = 1 THEN ${t.value} ELSE NULL END` }).where(eq(t.key, key));
}

/**
 * 설정 쓰기들과 감사 기록 한 행을 같이 남기거나 같이 남기지 않는다 (M2.T5, M1 리뷰). Node 네 DB 는 트랜잭션, D1 은 batch 하나다.
 * 어느 키든 updated_at 이 읽은 값과 다르면(그사이 다른 관리자가 썼으면) SettingsError("stale_setting") 이고 설정·감사 기록 모두 그대로다.
 * 감사 기록 문장이 실패하면 그 오류를 던지고 설정도 되돌린다.
 */
export async function commitSettings(h: DbHandle, writes: SettingWrite[], actorId: string | null, now: Date, audit: AuditEntry): Promise<void> {
  if (h.kind === "d1") {
    const stmts: any[] = [];
    for (const w of writes) stmts.push(casStatement(h, h.db, w, actorId, now), guardStatement(h, w.key));
    stmts.push(auditStatement(h, audit));
    try {
      await h.db.batch(stmts);
    } catch (e) {
      const msg = `${(e as Error)?.message ?? ""} ${((e as Error)?.cause as Error)?.message ?? ""}`;
      if (STALE_GUARD.test(msg)) throw new SettingsError("stale_setting", writes.map((w) => w.key).join(","));
      throw e;
    }
    return;
  }
  await h.db.transaction(async (tx: any) => {
    for (const w of writes) {
      if ((await affected(h, casStatement(h, tx, w, actorId, now))) !== 1) throw new SettingsError("stale_setting", w.key);
    }
    await auditStatement(h, audit, tx);
  });
}

/** 정책 설정 여섯 키의 updated_at (행이 없으면 null) */
export async function settingsUpdatedAt(h: DbHandle, keys: readonly string[]): Promise<Record<string, Date | null>> {
  const t = h.schema.appSettings;
  const out: Record<string, Date | null> = Object.fromEntries(keys.map((k) => [k, null]));
  const rows: { key: string; updatedAt: Date | number }[] = await h.db.select({ key: t.key, updatedAt: t.updatedAt }).from(t);
  for (const r of rows) if (r.key in out) out[r.key] = new Date(r.updatedAt);
  return out;
}
