// 메일 발송 설정 (계획서 4.7 5번, 4.8). 설치 화면에서 받은 설정을 app_settings 에 두고, 보낼 때마다 읽어 어댑터를 고른다.
// API 키는 APP_ENCRYPTION_KEY 로 암호화해 저장한다 (7장 "비밀 값"). 설정이 없으면 fallbackMailer (개발은 콘솔).
// 지금은 Resend 하나만 받는다. SMTP·Cloudflare 와 설정 화면은 계획서 9장 이후 단계에서 붙인다.
import { eq } from "drizzle-orm";
import type { Mailer } from "@magnetosphere/auth";
import { resendMailer } from "@magnetosphere/auth/mail";
import type { Cipher } from "@magnetosphere/runtime/crypto";
import type { DbHandle } from "@magnetosphere/runtime/types";

export const MAIL_SETTINGS_KEY = "mail_settings";
/** API 키 암호문의 AAD. 다른 자리로 옮겨 붙인 암호문은 열리지 않는다 */
export const MAIL_API_KEY_AAD = "app_settings.mail_settings.apiKey";

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
