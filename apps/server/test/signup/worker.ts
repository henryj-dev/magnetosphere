// 가입 정책 시험(M2)의 D1 시험 Worker. 운영 Worker(src/workers.ts)처럼 요청마다 런타임·DB 연결·서비스를 새로 만들고 서버 앱 전체로 받는다.
// 진입 모듈이라 default 말고는 내보내지 않는다. 클라이언트 IP 는 시험 헤더 x-test-ip (없으면 요청마다 무작위), 메일은 isolate 안 outbox.
//   /api/*                          서버 앱 (app.ts 앞 판정 → Better Auth)
//   POST /__test/db { op, args }    packages/auth/test/signup-policy/rig.ts OPS[op]
//   GET  /__test/outbox             보낸 메일
//   POST /__test/api-signup { body, invite? }    auth.api.signUpEmail (invite 가 있으면 runAsInvite 안에서)
//   POST /__test/internal { fn, email }          internalAdapter.createUser·createOAuthUser
//   GET  /__test/paths              auth.api 경로 목록
//   ANY  /__test/bare/<경로>        서버 앞 판정 없이 운영 createAuth 의 handler 로 /api/auth/<경로> (TC-M2.T7.a)
import { betterAuth } from "better-auth";
import { authOptions, type MailMessage, type Mailer } from "@magnetosphere/auth";
import { runAsInvite, type InviteGrant } from "@magnetosphere/auth/invite-context";
import { createWorkersRuntime, type WorkersEnv } from "@magnetosphere/runtime/workers";
import { apiReply, OPS, type OpName } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { createApp } from "../../src/app.ts";
import { buildServices } from "../../src/config.ts";
import { signupAuthHooks } from "../../src/signup/gate.ts";

const outbox: MailMessage[] = [];
const mailer: Mailer = { send: async (m) => void outbox.push(m) };
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
