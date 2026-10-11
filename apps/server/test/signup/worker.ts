// 가입 정책 시험(M2)의 D1 시험 Worker. 운영 Worker(src/workers.ts)처럼 요청마다 런타임·DB 연결·서비스를 새로 만들고 서버 앱 전체로 받는다.
// 진입 모듈이라 default 말고는 내보내지 않는다. 클라이언트 IP 는 시험 헤더 x-test-ip (없으면 요청마다 무작위), 메일은 isolate 안 outbox.
//   /api/*                          서버 앱 (app.ts 앞 판정 → Better Auth)
//   POST /__test/db { op, args }    packages/auth/test/signup-policy/rig.ts OPS[op]
//   GET  /__test/outbox             보낸 메일
//   POST /__test/api-signup { body, invite? }    auth.api.signUpEmail (invite 가 있으면 runAsInvite 안에서)
//   POST /__test/internal { fn, email }          internalAdapter.createUser·createOAuthUser
//   GET  /__test/paths              auth.api 경로 목록
//   ANY  /__test/bare/<경로>        서버 앞 판정 없이 운영 createAuth 의 handler 로 /api/auth/<경로> (TC-M2.T7.a)
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { authOptions, type MailMessage, type Mailer } from "@magnetosphere/auth";
import { runAsInvite, type InviteGrant } from "@magnetosphere/auth/invite-context";
import { createWorkersRuntime, type WorkersEnv } from "@magnetosphere/runtime/workers";
import { apiReply, OPS, type OpName } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { createApp } from "../../src/app.ts";
import { buildServices } from "../../src/config.ts";
import { signupAuthHooks } from "../../src/signup/gate.ts";

const outbox: MailMessage[] = [];
const mailer: Mailer = { send: async (m) => void outbox.push(m) };
const barriers = new Map<string, { reached: boolean; release: () => void; wait: Promise<void> }>();
const randomIp = () => `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  async fetch(req: Request, env: WorkersEnv, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const runtime = { ...createWorkersRuntime(env), clientIp: (r: Request) => r.headers.get("x-test-ip") ?? randomIp() };
    const pending: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => void pending.push(p);
    // 메일 전송(응답과 떼어 보낸 것)이 끝난 뒤 응답한다. 시험이 응답 직후 메일 상자를 읽는다
    const settled = async (res: Response) => {
      while (pending.length) await Promise.all(pending.splice(0));
      return res;
    };
    try {
      const services = await buildServices(runtime, { waitUntil, mailer });
      const h = services.db;
      const api = (services.auth as any).api;
      if (url.pathname === "/__test/db" && req.method === "POST") {
        const b = (await req.json()) as { op: OpName; args: unknown[] };
        return Response.json({ result: (await (OPS[b.op] as any)(h.db, h.schema, ...b.args)) ?? null });
      }
      if (url.pathname === "/__test/outbox") return settled(Response.json({ outbox }));
      if (url.pathname === "/__test/api-signup" && req.method === "POST") {
        const b = (await req.json()) as { body: Record<string, unknown>; invite?: InviteGrant };
        const run = () => api.signUpEmail({ body: b.body });
        return settled(Response.json(await apiReply(b.invite ? runAsInvite(b.invite, run) : run())));
      }
      if (url.pathname === "/__test/session-state" && req.method === "POST") {
        const b = await req.json() as { userId: string; state: "legacy" | "oauth" | "unverified" | "deleted" };
        const s = h.schema as any;
        await h.db.update(s.session).set({ credentialFingerprint: null }).where(eq(s.session.userId, b.userId));
        if (b.state === "oauth") await h.db.delete(s.account).where(eq(s.account.userId, b.userId));
        if (b.state === "unverified") await h.db.update(s.user).set({ emailVerified: false }).where(eq(s.user.id, b.userId));
        if (b.state === "deleted") await h.db.update(s.user).set({ deletedAt: new Date() }).where(eq(s.user.id, b.userId));
        return Response.json({ status: true });
      }
      if (url.pathname === "/__test/api" && req.method === "POST") {
        const b = await req.json() as { method: string; input: any };
        const input = { ...b.input, ...(b.input.headers ? { headers: new Headers(b.input.headers) } : {}) };
        return settled(Response.json(await apiReply(api[b.method](input))));
      }
      if (url.pathname === "/__test/barrier") {
        const id = url.searchParams.get("id")!;
        const point = barriers.get(id);
        if (req.method === "DELETE") point?.release();
        return Response.json({ reached: point?.reached ?? false });
      }
      if (url.pathname === "/__test/race" && req.method === "POST") {
        const b = await req.json() as { id: string; path: string; body: any; cookie?: string; stage: "password" | "insert" };
        let release!: () => void;
        const point = { reached: false, release: () => release(), wait: new Promise<void>((r) => { release = r; }) };
        barriers.set(b.id, point);
        const pause = async () => {
          point.reached = true;
          // 다른 요청이 barrier를 풀 때까지 살아 있는 타이머를 둔다. 순수 미해결 Promise는 workerd가 hung 요청으로 취소한다.
          let resumed = false;
          void point.wait.then(() => { resumed = true; });
          const deadline = Date.now() + 20_000;
          while (!resumed) {
            if (Date.now() > deadline) throw new Error("D1 barrier 대기 시간 초과");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        };
        const options = authOptions({ database: h, baseURL: String(env.BETTER_AUTH_URL), secret: String(env.BETTER_AUTH_SECRET), mailer, clientIp: runtime.clientIp, waitUntil, onMailError: () => {}, ...signupAuthHooks(h) });
        if (b.stage === "password") (options.emailAndPassword as any).password = { hash: hashPassword, verify: async (input: any) => { const valid = await verifyPassword(input); await pause(); return valid; } };
        else {
          const before = options.databaseHooks.session.create.before;
          options.databaseHooks.session.create.before = async (session: any, context: any) => { const checked = await before(session, context); await pause(); return checked; };
        }
        const auth = betterAuth(options);
        const headers = { origin: String(env.BETTER_AUTH_URL), "content-type": "application/json", ...(b.cookie ? { cookie: b.cookie } : {}) };
        try { return settled(await auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${b.path}`, { method: "POST", headers, body: JSON.stringify(b.body) }))); }
        finally { barriers.delete(b.id); }
      }
      if (url.pathname === "/__test/internal" && req.method === "POST") {
        const b = (await req.json()) as { fn: "createUser" | "createOAuthUser"; email: string };
        // 운영 구성과 같은 옵션(가입 훅 포함)으로 올린 Better Auth 의 internalAdapter
        const c = await betterAuth(
          authOptions({
            database: h,
            baseURL: String(env.BETTER_AUTH_URL),
            secret: String(env.BETTER_AUTH_SECRET),
            mailer,
            clientIp: runtime.clientIp,
            waitUntil,
            onMailError: () => {},
            ...signupAuthHooks(h),
          }),
        ).$context;
        const user = { email: b.email, name: "x", emailVerified: true };
        const p = b.fn === "createUser" ? c.internalAdapter.createUser(user, { method: "email-password" } as any) : c.internalAdapter.createOAuthUser(user, { providerId: "sso-idp", accountId: crypto.randomUUID() });
        return Response.json(await apiReply(p));
      }
      if (url.pathname === "/__test/paths") return Response.json({ paths: Object.entries(api).map(([k, ep]: [string, any]) => ep.path ?? `(server) ${k}`) });
      if (url.pathname.startsWith("/__test/bare/")) {
        const target = new URL(url.pathname.replace(/^\/__test\/bare/, "/api/auth") + url.search, url);
        return settled(await services.auth.handler(new Request(target, req)));
      }
      const app = createApp({ services: async () => services, assets: async (c) => c.text("spa"), setupTokenFromSecret: true, log: (l) => console.log(l) });
      return settled(await app.fetch(req));
    } finally {
      ctx.waitUntil(Promise.allSettled(pending).then(() => runtime.close()));
    }
  },
};
