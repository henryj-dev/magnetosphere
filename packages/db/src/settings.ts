// 가입 정책 설정 여섯 키의 값 검사와 읽기 (3단계 실행판 M1.T1·M2.T2, 계획서 4.2·5.9).
// 서버 설정 저장소(apps/server/src/settings)와 Better Auth 가입 훅(packages/auth, 판정 packages/db/src/signup.ts)이 같은 규칙으로 읽도록
// 여기 둔다. packages/auth 가 서버 코드에 기대지 않게 하려는 것이다 (M1 리뷰). 쓰기·정책 검사는 서버 설정 저장소에 있다.
//   - 행이 없으면 시드 기본값(DEFAULT_SETTINGS, allowed_domains 는 [])을 쓴다 (TC-M1.T1.c).
//   - 행이 있는데 값이 깨졌으면(검사에 맞지 않음·JSON 아님) 경고를 남기고 더 닫힌 값(BROKEN_SETTINGS)으로 읽는다 (TC-M1.T1.e).
// 이 파일은 Workers 에서도 import 된다.
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_SETTINGS } from "./seed.ts";

type AnyDb = any;
type Schema = Record<string, any>; // appSettings 를 쓴다

export const SIGNUP_MODES = ["open", "invite_only", "domain_allowlist", "sso_only", "closed"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** 허용 도메인 최대 개수 (Q14) */
export const MAX_ALLOWED_DOMAINS = 100;
/** DECIMAL(12,6) 의 최댓값. default_limit_usd 는 user.monthly_limit_usd 로 복사된다 (Q16) */
export const MAX_USD = 999_999.999_999;
/** user.max_keys 는 32비트 정수 칼럼이다 */
const MAX_INT32 = 2_147_483_647;

/** 메일 설정 행의 키. 이 행이 있으면 "메일 설정됨"이다 (Q15) */
export const MAIL_SETTINGS_KEY = "mail_settings";

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
export const SETTING_SCHEMAS = {
  signup_mode: z.enum(SIGNUP_MODES),
  allowed_domains: domains,
  signup_requires_approval: z.boolean(),
  // null = 상한 없음, 0 = 자기 가입 모두 막음 (Q13)
  daily_signup_cap: z.number().int().min(0).max(MAX_INT32).nullable(),
  // null 은 받지 않는다. 무제한은 회원마다 관리자가 PATCH /api/admin/users/:id 로만 준다 (Q16 남은 결정 (가))
  default_limit_usd: z.number().min(0).max(MAX_USD),
  default_max_keys: z.number().int().min(0).max(MAX_INT32),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];
export type SignupSettings = { [K in SettingKey]: z.output<(typeof SETTING_SCHEMAS)[K]> };

export const DEFAULT_SIGNUP_SETTINGS: SignupSettings = { ...DEFAULT_SETTINGS, allowed_domains: [] };
/** 행의 값이 깨졌을 때 읽는 값. 가입을 더 막는 쪽이다. 기본 한도는 #13 과 같이 시드 값 5 다 */
export const BROKEN_SETTINGS: SignupSettings = { ...DEFAULT_SIGNUP_SETTINGS, signup_mode: "closed", daily_signup_cap: 0, signup_requires_approval: true, allowed_domains: [] };

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTING_SCHEMAS, key);

/** 정책 설정 여섯 키. 행이 없으면 시드 기본값, 값이 깨졌으면 경고와 함께 더 닫힌 값 */
export async function readSignupSettings(db: AnyDb, schema: Schema): Promise<SignupSettings> {
  const t = schema.appSettings;
  const rows: { key: string; value: string }[] = await db.select({ key: t.key, value: t.value }).from(t).where(inArray(t.key, SETTING_KEYS));
  const out: Record<string, unknown> = { ...DEFAULT_SIGNUP_SETTINGS };
  for (const r of rows) {
    if (!isSettingKey(r.key)) continue;
    let p: { success: boolean; data?: unknown } = { success: false };
    try {
      p = SETTING_SCHEMAS[r.key].safeParse(JSON.parse(r.value));
    } catch {
      // JSON 이 아니면 아래에서 깨진 값으로 본다
    }
    if (p.success) {
      out[r.key] = p.data;
    } else {
      out[r.key] = BROKEN_SETTINGS[r.key];
      console.warn(`[settings] app_settings.${r.key} 값이 깨져 ${JSON.stringify(BROKEN_SETTINGS[r.key])} 로 읽는다`);
    }
  }
  return out as SignupSettings;
}

/** 메일이 설정됐나 = app_settings.mail_settings 행이 있다 (Q15) */
export async function mailSettingsExist(db: AnyDb, schema: Schema): Promise<boolean> {
  const t = schema.appSettings;
  return (await db.select({ key: t.key }).from(t).where(eq(t.key, MAIL_SETTINGS_KEY)).limit(1)).length > 0;
}
