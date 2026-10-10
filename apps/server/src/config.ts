// 서버 구성. 비밀 값은 런타임 어댑터의 secret() 으로 읽는다 (Node 는 환경 변수, Workers 는 env 바인딩).
import { createAuth, type Mailer } from "@magnetosphere/auth";
import { createClient } from "@magnetosphere/omniroute";
import { consoleMailer, MailError } from "@magnetosphere/auth/mail";
import { createCipher } from "@magnetosphere/runtime/crypto";
import type { Runtime } from "@magnetosphere/runtime/types";
import type { Services } from "./app.ts";
import { assertSetupTokenStrength } from "./setup/index.ts";
import { settingsMailer } from "./setup/mail.ts";
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
}

export async function buildServices(rt: Runtime, opts: ServiceOptions): Promise<Services> {
  const db = await rt.db();
  // 키가 없거나 32바이트가 아니면 여기서 시작을 거부한다 (TC-S4.T2.c)
  const cipher = await createCipher(requireSecret(rt, "APP_ENCRYPTION_KEY"));
  const baseURL = requireSecret(rt, "BETTER_AUTH_URL");
  const auth = createAuth({
    database: db,
    baseURL,
    secret: requireSecret(rt, "BETTER_AUTH_SECRET"),
    trustedOrigins: [new URL(baseURL).origin],
    mailer: settingsMailer(async () => db, async () => cipher, opts.fallbackMailer ?? fallbackMailer()),
    clientIp: rt.clientIp,
    waitUntil: opts.waitUntil,
    onMailError: (e, info) => console.error(`[mail] ${info.to} 에게 "${info.subject}" 를 보내지 못했다`, e),
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
  return { db, auth, cipher, omniroute, setupToken, clientIp: rt.clientIp, appOrigin: new URL(baseURL).origin, keysClient };
}
