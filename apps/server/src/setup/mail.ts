// 메일 발송 설정. 설치·관리자 API 가 같은 검사와 암호화 AAD 를 쓴다. 행이 없을 때만 fallbackMailer 를 쓴다 (Q15).
// SMTP 구현은 Node 진입점에서 주입한다. 이 모듈과 Workers 의 의존 경로에는 nodemailer 를 넣지 않는다.
// Cloudflare Email Service 는 Workers 진입점이 send_email 바인딩(env.EMAIL)을 넘길 때만 쓴다. 저장할 비밀 값이 없다.
import { eq } from "drizzle-orm";
import type { Mailer } from "@magnetosphere/auth";
import { cloudflareBindingMailer, MailError, resendMailer, type SendEmailBinding } from "@magnetosphere/auth/mail";
import type { Cipher } from "@magnetosphere/runtime/crypto";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { MAIL_SETTINGS_KEY } from "@magnetosphere/db/src/settings.ts";

export { MAIL_SETTINGS_KEY };
/** 비밀 값마다 AAD 를 달리해 API 키와 SMTP 비밀번호 암호문을 서로 바꿔 붙이지 못하게 한다 */
export const MAIL_API_KEY_AAD = "app_settings.mail_settings.apiKey";
export const SMTP_PASSWORD_AAD = "app_settings.mail_settings.password";

interface ResendInput {
  provider: "resend";
  apiKey: string;
  from: string;
}
interface SmtpInput {
  provider: "smtp";
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
  user?: string;
  password?: string;
  from: string;
}
interface CloudflareInput {
  provider: "cloudflare";
  from: string;
}
export type MailInput = ResendInput | SmtpInput | CloudflareInput;
export interface MailCapabilities { smtp: boolean; cloudflare: boolean }

/** 이 런타임이 보낼 수 없는 provider 면 오류 코드. 권한·토큰 검사 뒤, 입력 검사 전에 부른다 */
export function unsupportedMail(m: unknown, caps?: MailCapabilities): "smtp_unsupported" | "cloudflare_unsupported" | null {
  const provider = typeof m === "object" && m !== null ? (m as { provider?: unknown }).provider : undefined;
  if (provider === "smtp" && !caps?.smtp) return "smtp_unsupported";
  if (provider === "cloudflare" && !caps?.cloudflare) return "cloudflare_unsupported";
  return null;
}
/** Node 전용 모듈을 공유 코드에서 import 하지 않기 위한 주입 계약. pass 는 smtpMailer 의 필드명이다 */
export type SmtpFactory = (opts: {
  host: string; port: number; secure: boolean; requireTLS: boolean; user?: string; pass?: string; from: string;
}) => Mailer;

/** 기존 from 계약: 이메일 주소 하나만, 표시 이름·여러 주소·공백·제어 문자는 받지 않는다 (TC-M2.T5.f) */
const FROM_ADDRESS = /^[^\x00-\x20\x7f@<>()[\]\\,;:"]+@(?:[^\x00-\x20\x7f@<>()[\]\\,;:".]+\.)+[^\x00-\x20\x7f@<>()[\]\\,;:".]+$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** 설치와 설정 API 의 공통 입력 검사. SMTP 는 TLS 검증 우회 같은 숨은 옵션을 받지 않는다 */
export function validMailInput(m: unknown): m is MailInput {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return false;
  const x = m as Record<string, unknown>;
  if (typeof x.from !== "string" || x.from.trim().length > 254 || !FROM_ADDRESS.test(x.from.trim())) return false;
  if (x.provider === "resend") return typeof x.apiKey === "string" && x.apiKey.trim() !== "";
  // 보내는 쪽 인증은 바인딩이 한다. 비밀 값·표시 이름 같은 다른 키는 받지 않는다.
  if (x.provider === "cloudflare") return Object.keys(x).every((k) => k === "provider" || k === "from");
  if (x.provider !== "smtp" || Object.keys(x).some((k) => !["provider", "host", "port", "secure", "requireTLS", "user", "password", "from"].includes(k))) return false;
  // 관리자 설정이라 LAN·loopback 도 허용한다. URL·포트가 붙은 host·IPv6·제어 문자는 받지 않는다.
  if (typeof x.host !== "string" || CONTROL.test(x.host) || x.host.trim().length > 253 || !x.host.trim().split(".").every((s) => HOST_LABEL.test(s))) return false;
  if (/^[\d.]+$/.test(x.host.trim()) && (x.host.trim().split(".").length !== 4 || x.host.trim().split(".").some((s) => !/^(0|[1-9]\d{0,2})$/.test(s) || Number(s) > 255))) return false;
  if (typeof x.port !== "number" || !Number.isInteger(x.port) || x.port < 1 || x.port > 65535 || typeof x.secure !== "boolean") return false;
  if (x.requireTLS !== undefined && typeof x.requireTLS !== "boolean") return false;
  // secure=true 는 연결부터 TLS 다. 평문 허용은 secure=false + requireTLS=false 를 명시한 경우뿐이다.
  if (x.secure && x.requireTLS === false) return false;
  if (x.user === undefined) return x.password === undefined;
  return typeof x.user === "string" && x.user.trim().length > 0 && x.user.trim().length <= 254 && !CONTROL.test(x.user)
    && typeof x.password === "string" && x.password.length > 0 && x.password.length <= 512 && !CONTROL.test(x.password);
}

/** 비밀 값만 암호화한다. 비밀번호의 앞뒤 공백은 인증 정보이므로 그대로 둔다 */
export async function storedMailSettings(m: MailInput, cipher: Cipher): Promise<StoredMailSettings> {
  if (m.provider === "resend") return { provider: "resend", from: m.from.trim(), apiKey: await cipher.encrypt(m.apiKey.trim(), MAIL_API_KEY_AAD) };
  if (m.provider === "cloudflare") return { provider: "cloudflare", from: m.from.trim() };
  return {
    provider: "smtp", host: m.host.trim(), port: m.port, secure: m.secure, requireTLS: m.requireTLS ?? !m.secure, from: m.from.trim(),
    ...(m.user === undefined ? {} : { user: m.user.trim(), password: await cipher.encrypt(m.password!, SMTP_PASSWORD_AAD) }),
  };
}

type StoredMailSettings = ResendInput | CloudflareInput | (Omit<SmtpInput, "requireTLS"> & { requireTLS: boolean });

/** createCipher 의 저장 형식: "v1:" + base64. AAD 는 복호화가 확인한다 */
const CIPHERTEXT = /^v1:[A-Za-z0-9+/]+={0,2}$/;
const INVALID_STORED = "저장된 메일 설정이 올바르지 않다";

/** 저장 행 전용 검사. storedMailSettings 가 쓴 모양만 받는다. 비밀 값 자리는 암호문 형식만 보고 입력 검사를 재사용한다 */
function readStoredMail(value: string): StoredMailSettings | null {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const x = parsed as Record<string, unknown>;
  const sealed = (v: unknown) => typeof v === "string" && CIPHERTEXT.test(v);
  if (x.provider === "resend") {
    const only = Object.keys(x).every((k) => k === "provider" || k === "from" || k === "apiKey");
    return only && sealed(x.apiKey) && validMailInput({ ...x, apiKey: "sealed" }) ? (x as unknown as StoredMailSettings) : null;
  }
  if (x.provider === "cloudflare") return validMailInput(x) ? (x as unknown as StoredMailSettings) : null;
  if (x.provider !== "smtp" || typeof x.requireTLS !== "boolean") return null;
  if (x.password !== undefined && !sealed(x.password)) return null;
  // storedMailSettings 는 secure=true 에 requireTLS 가 없으면 false 를 쓴다 (연결부터 TLS 라 쓰이지 않는 값). 입력 검사에는 그 값을 빼고 넘긴다
  const tls = x.secure === true ? { requireTLS: undefined } : {};
  return validMailInput({ ...x, ...tls, ...(x.password === undefined ? {} : { password: "sealed" }) }) ? (x as unknown as StoredMailSettings) : null;
}

/** smtp·cloudflare 는 그 런타임이 주입한 것만 쓴다. 저장된 provider 를 이 런타임이 못 쓰면 fallback 으로 가지 않고 실패한다.
 *  손상된 행·풀리지 않는 암호문도 전송·fallback 없이 고정 문구 MailError 로 끝낸다 (원문·비밀 값을 오류에 싣지 않는다) */
export function settingsMailer(
  db: () => Promise<DbHandle>,
  cipher: () => Promise<Cipher>,
  fallback: Mailer,
  smtp?: SmtpFactory,
  cloudflare?: SendEmailBinding,
): Mailer {
  return {
    async send(msg) {
      const h = await db();
      const t = h.schema.appSettings;
      const [row] = await h.db.select({ value: t.value }).from(t).where(eq(t.key, MAIL_SETTINGS_KEY));
      if (!row) return fallback.send(msg);
      const s = readStoredMail(row.value);
      if (!s) throw new MailError("none", null, INVALID_STORED);
      const open = async (provider: string, token: string, aad: string) => {
        try { return await (await cipher()).decrypt(token, aad); } catch { throw new MailError(provider, null, INVALID_STORED); }
      };
      if (s.provider === "resend") {
        const apiKey = await open("resend", s.apiKey, MAIL_API_KEY_AAD);
        return resendMailer({ apiKey, from: s.from }).send(msg);
      }
      if (s.provider === "smtp") {
        if (!smtp) throw new MailError("smtp", null, "이 런타임은 SMTP 를 지원하지 않는다");
        const pass = s.password === undefined ? undefined : await open("smtp", s.password, SMTP_PASSWORD_AAD);
        return smtp({ host: s.host, port: s.port, secure: s.secure, requireTLS: s.requireTLS, from: s.from, user: s.user, pass }).send(msg);
      }
      if (s.provider === "cloudflare") {
        if (!cloudflare) throw new MailError("cloudflare", null, "이 런타임에는 Cloudflare 메일 바인딩이 없다");
        return cloudflareBindingMailer({ binding: cloudflare, from: { email: s.from } }).send(msg);
      }
      throw new MailError("none", null, "알 수 없는 메일 설정이다");
    },
  };
}
