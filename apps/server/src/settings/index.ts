// 설정 저장소 하나 (3단계 실행판 M1.T1, 계획서 4.2·5.9). 가입 정책 설정 여섯 키의 읽기·값 검사·정책 검사와
// app_settings 쓰기(upsert 한 문장)를 여기 둔다. 3단계 코드(가입 판정·설정 API·초대)는 이것만 쓴다.
//   - 읽기(readSettings): 행이 없으면 시드 기본값(DEFAULT_SETTINGS, allowed_domains 는 [])을 쓴다 (TC-M1.T1.c).
//     행이 있는데 값이 깨졌으면(검사에 맞지 않음·JSON 아님) 경고를 남기고 더 닫힌 값(BROKEN)으로 읽는다. 시드 값으로 읽으면
//     운영자가 둔 closed·cap 0 이 invite_only·20 으로 열린다 (TC-M1.T1.e, M1 리뷰 낮음 1).
//   - 쓰기(writeSetting): 키마다 zod 로 값을 검사·정규화하고, 정책 검사(메일·도메인·IdP)를 지난 값만 upsert 한다.
//     어긋나면 SettingsError 를 던지고 아무것도 쓰지 않는다 (TC-M1.T1.a·b).
//   - 정책 키가 아닌 값(public_base_url, mail_settings, OmniRoute 토큰 등)은 writeAppSetting 으로 같은 upsert 를 쓴다.
// 2단계 한도 분배의 설정 쓰기(limits/store.ts, 임대 펜싱)는 봉인한 시험이 걸려 있어 옮기지 않는다 (실행판 백로그).
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_SETTINGS } from "@magnetosphere/db/src/seed.ts";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { MAIL_SETTINGS_KEY } from "../setup/mail.ts";

export const SIGNUP_MODES = ["open", "invite_only", "domain_allowlist", "sso_only", "closed"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** 허용 도메인 최대 개수 (Q14) */
export const MAX_ALLOWED_DOMAINS = 100;
/** DECIMAL(12,6) 의 최댓값. default_limit_usd 는 user.monthly_limit_usd 로 복사된다 (Q16) */
export const MAX_USD = 999_999.999_999;
/** user.max_keys 는 32비트 정수 칼럼이다 */
const MAX_INT32 = 2_147_483_647;

/** 도메인 하나를 소문자·punycode 로 바꾼다. 도메인 이름이 아니면 null. `*.` 표기·하위 도메인 규칙은 없다 (Q14 정확히 일치) */
export function normalizeDomain(raw: string): string | null {
  const s = raw.trim();
  // URL 이 받아 주는 사용자·포트·경로·와일드카드·공백을 먼저 거른다
  if (s === "" || /[\s*/\\:@?#%[\]]/.test(s)) return null;
  let host: string;
  try {
    host = new URL(`http://${s}`).hostname;
  } catch {
    return null;
  }
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2) return null;
  if (!labels.every((l) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l))) return null;
  // IPv4 주소는 이메일 도메인으로 받지 않는다
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;
  return host;
}

const domains = z
  .array(z.string())
  .max(MAX_ALLOWED_DOMAINS)
  .transform((list, ctx) => {
    const out: string[] = [];
    for (const raw of list) {
      const d = normalizeDomain(raw);
      if (d === null) {
        ctx.issues.push({ code: "custom", message: `도메인이 아니다: ${JSON.stringify(raw)}`, input: raw });
        return z.NEVER;
      }
      if (!out.includes(d)) out.push(d);
    }
    return out;
  });

/** 키마다 값 검사 (계획서 4.2, Q13·Q14·Q16). 통과한 값이 저장되는 값이다 (도메인은 정규화된다) */
const SCHEMAS = {
  signup_mode: z.enum(SIGNUP_MODES),
  allowed_domains: domains,
  signup_requires_approval: z.boolean(),
  // null = 상한 없음, 0 = 자기 가입 모두 막음 (Q13)
  daily_signup_cap: z.number().int().min(0).max(MAX_INT32).nullable(),
  // null 은 받지 않는다. 무제한은 회원마다 관리자가 PATCH /api/admin/users/:id 로만 준다 (Q16 남은 결정 (가))
  default_limit_usd: z.number().min(0).max(MAX_USD),
  default_max_keys: z.number().int().min(0).max(MAX_INT32),
} as const;

export type SettingKey = keyof typeof SCHEMAS;
export const SETTING_KEYS = Object.keys(SCHEMAS) as SettingKey[];
export type SignupSettings = { [K in SettingKey]: z.output<(typeof SCHEMAS)[K]> };

const DEFAULTS: SignupSettings = { ...DEFAULT_SETTINGS, allowed_domains: [] };
/** 행의 값이 깨졌을 때 읽는 값. 가입을 더 막는 쪽이다. 기본 한도는 #13 과 같이 시드 값 5 다 */
const BROKEN: SignupSettings = { ...DEFAULTS, signup_mode: "closed", daily_signup_cap: 0, signup_requires_approval: true, allowed_domains: [] };

export type SettingsErrorCode = "unknown_key" | "policy_key" | "invalid_value" | "mail_required" | "domains_required" | "no_idp";

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

const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SCHEMAS, key);

/** 정책 설정 여섯 키. 행이 없으면 시드 기본값, 값이 깨졌으면 경고와 함께 더 닫힌 값 */
export async function readSettings(h: DbHandle): Promise<SignupSettings> {
  const t = h.schema.appSettings;
  const rows: { key: string; value: string }[] = await h.db.select({ key: t.key, value: t.value }).from(t).where(inArray(t.key, SETTING_KEYS));
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) {
    if (!isSettingKey(r.key)) continue;
    let p: { success: boolean; data?: unknown } = { success: false };
    try {
      p = SCHEMAS[r.key].safeParse(JSON.parse(r.value));
    } catch {
      // JSON 이 아니면 아래에서 깨진 값으로 본다
    }
    if (p.success) {
      out[r.key] = p.data;
    } else {
      out[r.key] = BROKEN[r.key];
      console.warn(`[settings] app_settings.${r.key} 값이 깨져 ${JSON.stringify(BROKEN[r.key])} 로 읽는다`);
    }
  }
  return out as SignupSettings;
}

/** 메일이 설정됐나 = app_settings.mail_settings 행이 있다 (Q15) */
export async function mailConfigured(h: DbHandle): Promise<boolean> {
  const t = h.schema.appSettings;
  return (await h.db.select({ key: t.key }).from(t).where(eq(t.key, MAIL_SETTINGS_KEY)).limit(1)).length > 0;
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
  const t = h.schema.appSettings;
  const json = JSON.stringify(value);
  const set = { value: json, updatedAt: now, updatedBy };
  const insert = h.db.insert(t).values({ key, ...set });
  if (h.provider === "mysql") await insert.onDuplicateKeyUpdate({ set });
  else await insert.onConflictDoUpdate({ target: t.key, set });
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

