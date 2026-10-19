// 가입 정책 시험(M2)의 서버 Rig — Node 네 DB. 운영과 같은 서버 앱(createApp + buildServices)을 띄우지 않고 app.request 로 부른다.
//   - 런타임: DB 는 넘겨받은 DbHandle(connectNode), 클라이언트 IP 는 시험 헤더 x-test-ip (없으면 요청마다 무작위).
//   - 메일: 시험 메일러가 outbox 에 모은다. "메일 설정됨"은 app_settings.mail_settings 행이 있다는 뜻이다 (Q15, OPS.setMail).
// D1 판은 worker.ts 가 같은 Rig 를 시험 Worker 로 연다.
import type { MailMessage, Mailer } from "@magnetosphere/auth";
import { runAsInvite } from "@magnetosphere/auth/invite-context";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle, Runtime } from "@magnetosphere/runtime/types";
import { apiReply, OPS, reply } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { callRes, type CallOpts, type HttpRig } from "./checks.ts";
import { createApp, type Services } from "../../src/app.ts";
import { buildServices } from "../../src/config.ts";
import { TEST_MFA_POLICY_ENV } from "../../../../packages/auth/test/mfa-policy.ts";
import { TEST_ENCRYPTION_KEY, TEST_SECRET } from "../helpers.ts";

export const ORIGIN = "http://localhost:3000";
// 관리자 MFA 정책은 시험 전용 값이다 (A1, packages/auth/test/mfa-policy.ts)
const ENV: Record<string, string> = { BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: TEST_SECRET, APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, ...TEST_MFA_POLICY_ENV };

export const randomIp = () => `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;

export interface ServerRig extends HttpRig {
  h: DbHandle;
  services: Services;
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

/** 시험 런타임. 주기 작업은 돌리지 않는다 */
function testRuntime(h: DbHandle): Runtime {
  return {
    db: async () => h,
    schedule() {},
    rateLimitStore: () => ({ storage: "database" }),
    secret: (name) => ENV[name],
    clientIp: (req) => req.headers.get("x-test-ip") ?? randomIp(),
    close: async () => {},
  };
}

/** 서버 Rig. h 를 주면 그 연결을 쓰고(닫지 않는다), url 을 주면 새로 붙는다 */
export async function serverRig(label: string, o: { h?: DbHandle; url?: string }): Promise<ServerRig> {
  const h = o.h ?? (await connectNode(o.url!));
  const outbox: MailMessage[] = [];
  const pending: Promise<unknown>[] = [];
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  const mailer: Mailer = { send: async (m) => void outbox.push(m) };
  const services = await buildServices(testRuntime(h), { waitUntil: (p) => void pending.push(p), mailer });
  const app = createApp({ services: async () => services, assets: async (c) => c.text("spa"), setupTokenFromSecret: false, log: () => {} });
  const api = (services.auth as any).api;

  const raw = async (method: string, path: string, c: CallOpts = {}) => {
    const headers: Record<string, string> = { "x-test-ip": c.ip ?? randomIp(), ...(c.headers ?? {}) };
    if (c.origin !== null) headers.origin = c.origin ?? ORIGIN;
    if (c.cookie) headers.cookie = c.cookie;
    if (c.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(`${ORIGIN}${path}`, { method, headers, body: c.body === undefined ? undefined : JSON.stringify(c.body) });
    await settle();
    return res;
  };

  return {
    label,
    h,
    services,
    app,
    call: async (method, path, c) => callRes(await raw(method, path, c)),
    signUp: async (b, so = {}) => reply(await raw("POST", "/api/auth/sign-up/email", { body: b, ip: so.ip, headers: so.headers })),
    apiSignUp: async (b, invite) => {
      const r = await apiReply(invite ? runAsInvite(invite, () => api.signUpEmail({ body: b })) : api.signUpEmail({ body: b }));
      await settle();
      return r;
    },
    internalCreate: async () => {
      throw new Error("서버 Rig 는 internalAdapter 를 열지 않는다 (packages/auth Rig·D1 Rig 가 본다)");
    },
    request: async (method, path, b, headers) => reply(await raw(method, `/api/auth${path}`, { body: b, headers })),
    op: async (name, ...args) => (OPS[name] as any)(h.db, h.schema, ...args),
    outbox: async () => (await settle(), outbox),
    apiPaths: async () => Object.entries(api).map(([k, ep]: [string, any]) => ep.path ?? `(server) ${k}`),
    async close() {
      if (!o.h) await h.close();
    },
  };
}
