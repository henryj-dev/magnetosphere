// TC 공용: DB 하나에 Better Auth 를 올리고, user 행을 읽고 고치는 도구.
import { eq } from "drizzle-orm";
import { createAuth, type AuthConfig, type MailMessage, type Mailer } from "../src/index.ts";
import { BASE } from "./client.ts";
import type { TestDb } from "./db.ts";

export const SECRET = "mg-test-secret-mg-test-secret-mg-test-secret";

/** 요청마다 다른 IP. 요청 수 제한을 보지 않는 TC 가 한도에 걸리지 않게 한다 */
export const randomIp = () => `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;

/** 보낸 메일을 모아 두는 어댑터 */
export function outboxMailer() {
  const outbox: MailMessage[] = [];
  return { outbox, mailer: { send: async (m: MailMessage) => void outbox.push(m) } satisfies Mailer };
}

/** 테스트 기본 설정. 메일은 outbox 에 모으고, 응답과 떼어 보낸 전송은 pending 에, 실패는 mailErrors 에 모은다 */
export function makeAuthConfig(h: TestDb) {
  const { outbox, mailer } = outboxMailer();
  const pending: Promise<unknown>[] = [];
  const mailErrors: unknown[] = [];
  const config: AuthConfig = {
    database: h,
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [BASE],
    mailer,
    clientIp: randomIp,
    waitUntil: (p) => void pending.push(p),
    onMailError: (e) => void mailErrors.push(e),
  };
  return Object.assign(config, { outbox, pending, mailErrors });
}

export function makeAuth(h: TestDb, extra: Partial<AuthConfig> = {}) {
  const { outbox, pending, mailErrors, ...config } = makeAuthConfig(h);
  const app = createAuth({ ...config, ...extra });
  // settle() 은 응답과 떼어 보낸 메일 전송이 끝날 때까지 기다린다
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return { ...app, outbox, mailErrors, settle };
}

/** 메일 본문에서 링크 하나를 꺼낸다 */
export const linkIn = (text: string) => text.match(/https?:\/\/\S+/)?.[0];

const user = (h: TestDb) => (h.schema as any).user;

export async function userRow(h: TestDb, email: string) {
  const [row] = await h.db.select().from(user(h)).where(eq(user(h).email, email.toLowerCase()));
  return row;
}

export async function markVerified(h: TestDb, email: string) {
  await h.db.update(user(h)).set({ emailVerified: true }).where(eq(user(h).email, email.toLowerCase()));
}

export const PRIVILEGE_DEFAULTS = { role: "member", status: "active", monthlyLimitUsd: null, maxKeys: null, isBootstrapAdmin: false };

/** user 행의 권한 칼럼 다섯. DB 마다 다른 표현(0/1, "12.000000")을 맞춘다 */
export function privileges(row: any) {
  return {
    role: row.role,
    status: row.status,
    monthlyLimitUsd: row.monthlyLimitUsd === null ? null : Number(row.monthlyLimitUsd),
    maxKeys: row.maxKeys,
    isBootstrapAdmin: Boolean(row.isBootstrapAdmin),
  };
}
