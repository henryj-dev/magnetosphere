// 서버 구성. 비밀 값은 런타임 어댑터의 secret() 으로 읽는다 (Node 는 환경 변수, Workers 는 env 바인딩).
import { createAuth, type Mailer } from "@magnetosphere/auth";
import { selfDeleteCredentialProofOf } from "@magnetosphere/auth/internal";
import { createClient } from "@magnetosphere/omniroute";
import { consoleMailer, MailError, type SendEmailBinding } from "@magnetosphere/auth/mail";
import { loadMfaPolicy, MFA_ISSUER, MFA_POLICY_ENV, mfaHmacKey, type MfaRuntime } from "@magnetosphere/auth/mfa";
import { createCipher } from "@magnetosphere/runtime/crypto";
import type { Runtime } from "@magnetosphere/runtime/types";
import type { Services } from "./app.ts";
import { auditStatement } from "./audit/index.ts";
import { ipBucket } from "./routes/guard.ts";
import { assertSetupTokenStrength } from "./setup/index.ts";
import { signupAuthHooks } from "./signup/gate.ts";
import { settingsMailer, type SmtpFactory } from "./setup/mail.ts";
import { readOmniRouteToken } from "./setup/omniroute.ts";

export function requireSecret(rt: Runtime, name: string): string {
  const v = rt.secret(name);
  if (!v) throw new Error(`${name} 이 없다`);
  return v;
}

/**
 * 메일 설정이 없을 때의 어댑터. 개발에서는 콘솔에 찍고, 운영에서는 보내지 못했다고 예외를 던진다
 * (예외는 onMailError 로 간다). 메일 설정은 선택이다 (계획서 4.7 5번).
 */
export function fallbackMailer(): Mailer {
  try {
    return consoleMailer();
  } catch {
    return {
      async send() {
        throw new MailError("none", null, "메일 발송이 설정되지 않았다");
      },
    };
  }
}

export interface ServiceOptions {
  /** 메일 설정이 없을 때 쓸 어댑터 (기본 fallbackMailer) */
  fallbackMailer?: Mailer;
  /** 응답 뒤에도 살려 둘 작업 (Workers 는 ctx.waitUntil) */
  waitUntil: (p: Promise<unknown>) => void;
  /** 메일 설정과 관계없이 늘 이 어댑터로 보낸다 (시험이 보낸 메일을 센다). 운영은 비운다 */
  mailer?: Mailer;
  /** Node 진입점만 주입한다. 없으면 SMTP 설정 저장을 거부한다 */
  smtp?: SmtpFactory;
  /** Workers 진입점이 send_email 바인딩 env.EMAIL 을 넘긴다. 없으면 Cloudflare 메일 설정 저장을 거부한다 (선택 기능이라 시작은 막지 않는다) */
  cloudflareEmail?: SendEmailBinding;
}

/**
 * 관리자 MFA 런타임 (A1). 정책 수치는 배포 설정(env·wrangler vars)의 필수값이고 코드에 기본값이 없다.
 * 하나라도 없거나 범위 밖이면 정책은 unavailable 이고 시작은 막지 않는다: 관리자 가드가 503 mfa_policy_unavailable,
 * 최초 설치가 503 mfa_policy_required 로 닫힌다 (fail-closed). 사유는 설정 이름만 로그에 남긴다 (값은 남기지 않는다).
 */
export async function buildMfaRuntime(rt: Runtime, db: Services["db"], cipher: Services["cipher"], secret: string): Promise<MfaRuntime> {
  const env = Object.fromEntries(Object.values(MFA_POLICY_ENV).map((name) => [name, rt.secret(name)]));
  const policy = await loadMfaPolicy(env);
  if (policy.state !== "ready") console.warn(`[mfa] 관리자 MFA 정책을 쓸 수 없다 (${policy.field}: ${policy.reason}). 관리자 기능과 최초 설치가 닫힌다`);
  return { policy, cipher, key: await mfaHmacKey(secret), issuer: MFA_ISSUER, ipBucket, audit: (tx, e) => auditStatement(db, e, tx) };
}

export async function buildServices(rt: Runtime, opts: ServiceOptions): Promise<Services> {
  const db = await rt.db();
  // 키가 없거나 32바이트가 아니면 여기서 시작을 거부한다 (TC-S4.T2.c)
  const cipher = await createCipher(requireSecret(rt, "APP_ENCRYPTION_KEY"));
  const baseURL = requireSecret(rt, "BETTER_AUTH_URL");
  const secret = requireSecret(rt, "BETTER_AUTH_SECRET");
  const mfa = await buildMfaRuntime(rt, db, cipher, secret);
  const mailer = opts.mailer ?? settingsMailer(async () => db, async () => cipher, opts.fallbackMailer ?? fallbackMailer(), opts.smtp, opts.cloudflareEmail);
  const auth = createAuth({
    database: db,
    baseURL,
    secret,
    trustedOrigins: [new URL(baseURL).origin],
    mailer,
    clientIp: rt.clientIp,
    waitUntil: opts.waitUntil,
    // 공급자 오류 원문에는 인증 정보·주소가 섞일 수 있다. 로그에 인자나 원문을 넣지 않는다.
    onMailError: () => console.error("[mail] 메일을 보내지 못했다"),
    // 가입 판정 입력은 요청 하나에서 한 번만 읽고, 가입 뒤 감사 기록 member.signup 을 남긴다 (signup/gate.ts)
    ...signupAuthHooks(db),
    mfa,
  });
  // OmniRoute 연결은 선택이다. 없으면 설치 때 토큰 붙여 넣기로 간다 (setup/omniroute.ts)
  const omniroute = { baseUrl: rt.secret("OMNIROUTE_URL") || null, initialPassword: rt.secret("OMNIROUTE_INITIAL_PASSWORD") || null };
  // 약한 SETUP_TOKEN 은 시작을 거부한다 (Node 는 시작 때, Workers 는 처음 요청 때 500 + 로그)
  const setupToken = rt.secret("SETUP_TOKEN") || null;
  assertSetupTokenStrength(setupToken);
  // 회원 키 API 의 OmniRoute 어댑터. 요청마다 저장된 관리 토큰을 읽는다 (붙여 넣기로 바뀐 토큰을 바로 쓴다)
  const keysClient = async () => {
    const baseUrl = omniroute.baseUrl;
    const token = baseUrl ? await readOmniRouteToken(db, cipher) : null;
    if (!baseUrl || !token) return null;
    return (o?: { timeoutMs?: number }) => createClient({ baseUrl, credential: { token }, timeoutMs: o?.timeoutMs });
  };
  return { db, auth: { ...auth, selfDeleteCredentialProof: selfDeleteCredentialProofOf(auth) }, cipher, mfa, omniroute, setupToken, clientIp: rt.clientIp, appOrigin: new URL(baseURL).origin, keysClient, mailer, mailCapabilities: { smtp: !!opts.smtp, cloudflare: !!opts.cloudflareEmail } };
}
