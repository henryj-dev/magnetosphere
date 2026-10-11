// 메일 발송 설정 (계획서 4.7 5번, 4.8). 설치 화면에서 받은 설정을 app_settings 에 두고, 보낼 때마다 읽어 어댑터를 고른다.
// API 키는 APP_ENCRYPTION_KEY 로 암호화해 저장한다 (7장 "비밀 값"). 설정이 없으면 fallbackMailer (개발은 콘솔).
// 지금은 Resend 하나만 받는다. SMTP·Cloudflare 와 설정 화면은 계획서 9장 이후 단계에서 붙인다.
import { eq } from "drizzle-orm";
import type { Mailer } from "@magnetosphere/auth";
import { resendMailer } from "@magnetosphere/auth/mail";
import type { Cipher } from "@magnetosphere/runtime/crypto";
import type { DbHandle } from "@magnetosphere/runtime/types";

// 행이 있으면 "메일 설정됨"이다 (Q15). 가입 판정(packages/db/src/signup.ts)이 같은 키를 본다
import { MAIL_SETTINGS_KEY } from "@magnetosphere/db/src/settings.ts";

export { MAIL_SETTINGS_KEY };
/** API 키 암호문의 AAD. 다른 자리로 옮겨 붙인 암호문은 열리지 않는다 */
export const MAIL_API_KEY_AAD = "app_settings.mail_settings.apiKey";

/** 메일 설정 입력 (설치 화면·설정 API 가 같은 검사를 쓴다). 지금은 Resend 하나 */
export interface MailInput {
  provider: "resend";
  apiKey: string;
  from: string;
}

/** 설치(setup/index.ts)와 설정 API(signup/mail.ts)의 메일 설정 검사 */
export function validMailInput(m: unknown): m is MailInput {
  const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const x = m as Partial<MailInput> | null;
  return typeof x === "object" && x !== null && x.provider === "resend" && isText(x.apiKey) && isText(x.from);
}

/** 저장할 값. API 키는 APP_ENCRYPTION_KEY 로 암호화한다 (AAD MAIL_API_KEY_AAD) */
export async function storedMailSettings(m: MailInput, cipher: Cipher): Promise<StoredMailSettings> {
  return { provider: "resend", from: m.from.trim(), apiKey: await cipher.encrypt(m.apiKey.trim(), MAIL_API_KEY_AAD) };
}

interface StoredMailSettings {
  provider: "resend";
  from: string;
  /** cipher.encrypt 결과 ("v1:...") */
  apiKey: string;
}

export function settingsMailer(db: () => Promise<DbHandle>, cipher: () => Promise<Cipher>, fallback: Mailer): Mailer {
  return {
    async send(msg) {
      const h = await db();
      const t = h.schema.appSettings;
      const [row] = await h.db.select({ value: t.value }).from(t).where(eq(t.key, MAIL_SETTINGS_KEY));
      if (!row) return fallback.send(msg);
      const s = JSON.parse(row.value) as StoredMailSettings;
      const apiKey = await (await cipher()).decrypt(s.apiKey, MAIL_API_KEY_AAD);
      return resendMailer({ apiKey, from: s.from }).send(msg);
    },
  };
}
