// M4.T3 세션 상태·버전의 D1 시험 Worker. 운영 Worker(src/workers.ts)처럼 요청마다 런타임·DB 연결·서비스를 새로 만들고 서버 앱 전체로 받는다.
// 진입 모듈이라 default 말고는 내보내지 않는다. 클라이언트 IP 는 시험 헤더 x-test-ip (없으면 요청마다 무작위), 메일은 isolate 안 outbox.
// 시험 관리 경로는 이 임시 Worker 에만 있다. 응답에는 토큰·해시·지문을 싣지 않는다.
//   GET  /healthz                         준비 확인 (startWranglerDev)
//   /api/*                                운영 서버 앱 (app.ts 앞 판정 → createAuth 의 감싼 handler)
//   POST /__test/user { email, password, status }    인증 끝난 비밀번호 회원 → { id }
//   POST /__test/transition { id, set }   관리 전이와 같은 꼴: 상태·역할 변경 + authVersion+1 + 세션 삭제를 batch 하나로
//   POST /__test/user-set { id, set }     세션을 지우지 않고 user 칸만 바꾼다 (guard 자체 검사용)
//   POST /__test/state { id, password? }  { status, role, authVersion, sessions, password: 일치 여부 }
//   POST /__test/cleanup { ids }          fixture 행 삭제 뒤 남은 행 수와 남아 있던 barrier 수
//   POST /__test/barrier?id=              경계 하나를 미리 만든다
//   GET  /__test/barrier?id=              { reached, verified }   DELETE 는 해제
//   POST /__test/race { id, email, password, boundary }   운영과 같은 authOptions 의 원본 handler 로 로그인하고 경계에서 멈춘다
import { and, eq, inArray, sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { authOptions, CLIENT_IP_HEADER, type MailMessage, type Mailer } from "@magnetosphere/auth";
import { createWorkersRuntime, type WorkersEnv } from "@magnetosphere/runtime/workers";
import { OPS } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { createApp } from "../../src/app.ts";
import { buildServices } from "../../src/config.ts";
import { signupAuthHooks } from "../../src/signup/gate.ts";

type Boundary = "verify" | "before-insert" | "after-insert" | "final-response";
interface Point { reached: number; verified: boolean | null; released: boolean }

const BARRIER_MS = 15_000;
const STATUSES = ["pending", "active", "suspended"];
const ROLES = ["member", "admin"];
const outbox: MailMessage[] = [];
const mailer: Mailer = { send: async (m) => void outbox.push(m) };
const barriers = new Map<string, Point>();
const randomIp = () => `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

function point(id: string): Point {
  const created: Point = { reached: 0, verified: null, released: false };
  barriers.set(id, created);
  return created;
}

// 다른 요청이 풀 때까지 살아 있는 타이머로 플래그를 본다. 다른 요청 문맥에서 만든 Promise 를 풀면 workerd 가 이어 실행하지 않는다
// (같은 isolate 의 Map 값은 공유된다). 순수 미해결 Promise 는 hung 요청으로 취소되므로 쓰지 않는다. 15초 뒤에는 실패로 끝낸다.
async function pause(p: Point) {
  p.reached++;
  const deadline = Date.now() + BARRIER_MS;
  while (!p.released) {
    if (Date.now() > deadline) throw new Error("D1 barrier 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 시험이 바꿀 수 있는 user 칸만 받는다. 빈 set, 그 밖의 칸이나 값은 400 */
function userSet(set: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const entries = Object.entries(set ?? {});
  if (!entries.length) return null;
  for (const [key, value] of entries) {
    if (key === "status" && STATUSES.includes(value as string)) out.status = value;
    else if (key === "role" && ROLES.includes(value as string)) out.role = value;
    else if (key === "authVersion" && typeof value === "number") out.authVersion = value;
    else return null;
  }
  return out;
}

export default {
  async fetch(req: Request, env: WorkersEnv, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const runtime = { ...createWorkersRuntime(env), clientIp: (r: Request) => r.headers.get("x-test-ip") ?? randomIp() };
    const pending: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => void pending.push(p);
    // 응답과 떼어 둔 작업이 끝난 뒤 응답한다. 시험이 응답 직후 DB 를 읽는다
    const settled = async (res: Response) => {
      while (pending.length) await Promise.all(pending.splice(0));
      return res;
    };
    try {
      const services = await buildServices(runtime, { waitUntil, mailer });
      const h = services.db;
      const s = h.schema as any;
      if (url.pathname === "/__test/user" && req.method === "POST") {
        const b = (await req.json()) as { email: string; password: string; status: "pending" | "active" | "suspended" };
        if (!STATUSES.includes(b.status)) return Response.json({ error: "bad_status" }, { status: 400 });
        return Response.json({ id: await OPS.addPasswordUser(h.db, h.schema, b.email, b.password, "member", b.status) });
      }
      if ((url.pathname === "/__test/transition" || url.pathname === "/__test/user-set") && req.method === "POST") {
        const b = (await req.json()) as { id: string; set: Record<string, unknown> };
        const set = userSet(b.set);
        if (!set || typeof b.id !== "string") return Response.json({ error: "bad_set" }, { status: 400 });
        if (url.pathname === "/__test/user-set") await h.db.update(s.user).set(set).where(eq(s.user.id, b.id));
        // D1 은 대화형 트랜잭션이 없다. 운영 전이처럼 버전 증가와 세션 삭제를 batch 하나로 묶는다
        else await (h.db as any).batch([
          h.db.update(s.user).set({ ...set, authVersion: sql`${s.user.authVersion} + 1` }).where(eq(s.user.id, b.id)),
          h.db.delete(s.session).where(eq(s.session.userId, b.id)),
        ]);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/__test/state" && req.method === "POST") {
        const b = (await req.json()) as { id: string; password?: string };
        const [user] = await h.db.select().from(s.user).where(eq(s.user.id, b.id));
        const sessions = await h.db.select({ id: s.session.id }).from(s.session).where(eq(s.session.userId, b.id));
        const [account] = await h.db.select().from(s.account).where(and(eq(s.account.userId, b.id), eq(s.account.providerId, "credential")));
        const password = typeof b.password === "string" && account?.password ? await verifyPassword({ hash: account.password, password: b.password }) : null;
        return Response.json({ status: user?.status ?? null, role: user?.role ?? null, authVersion: user?.authVersion ?? null, sessions: sessions.length, password });
      }
      if (url.pathname === "/__test/cleanup" && req.method === "POST") {
        const b = (await req.json()) as { ids: string[] };
        const left = barriers.size;
        barriers.clear();
        if (b.ids.length) await (h.db as any).batch([
          h.db.delete(s.session).where(inArray(s.session.userId, b.ids)),
          h.db.delete(s.account).where(inArray(s.account.userId, b.ids)),
          h.db.delete(s.user).where(inArray(s.user.id, b.ids)),
        ]);
        const count = async (table: any, column: any) => b.ids.length ? (await h.db.select({ id: table.id }).from(table).where(inArray(column, b.ids))).length : 0;
        return Response.json({ users: await count(s.user, s.user.id), accounts: await count(s.account, s.account.userId), sessions: await count(s.session, s.session.userId), barriers: left });
      }
      if (url.pathname === "/__test/barrier") {
        const id = url.searchParams.get("id") ?? "";
        if (req.method === "POST") { point(id); return Response.json({ ok: true }); }
        const p = barriers.get(id);
        if (req.method === "DELETE" && p) p.released = true;
        return Response.json({ reached: p?.reached ?? 0, verified: p?.verified ?? null, exists: !!p });
      }
      if (url.pathname === "/__test/race" && req.method === "POST") {
        const b = (await req.json()) as { id: string; email: string; password: string; boundary: Boundary };
        const p = barriers.get(b.id);
        if (!p) return Response.json({ error: "no_barrier" }, { status: 400 });
        const baseURL = String(env.BETTER_AUTH_URL);
        // 운영 buildServices 의 createAuth 와 같은 구성. 원본 handler 라 withClientIp·서버 앞 판정은 거치지 않는다
        const options = authOptions({ database: h, baseURL, secret: String(env.BETTER_AUTH_SECRET), trustedOrigins: [new URL(baseURL).origin], mailer, clientIp: runtime.clientIp, waitUntil, onMailError: () => {}, ...signupAuthHooks(h) });
        if (b.boundary === "verify") (options.emailAndPassword as any).password = { hash: hashPassword, verify: async (input: any) => { const valid = await verifyPassword(input); p.verified = valid; await pause(p); return valid; } };
        if (b.boundary === "before-insert") {
          const before = options.databaseHooks.session.create.before;
          options.databaseHooks.session.create.before = async (session: any, context: any) => { const checked = await before(session, context); await pause(p); return checked; };
        }
        if (b.boundary === "after-insert") {
          const after = options.databaseHooks.session.create.after;
          options.databaseHooks.session.create.after = async (session: any, context: any) => { await pause(p); await after(session, context); };
        }
        if (b.boundary === "final-response") {
          const after = options.hooks.after;
          // middleware 속성을 보존해야 core 가 같은 after 훅으로 부른다
          options.hooks.after = Object.assign(async (context: any) => { await pause(p); return after(context); }, after);
        }
        const auth = betterAuth(options);
        // withClientIp 를 거치지 않으니 IP 를 직접 싣는다. 없으면 경계 시험들이 /sign-in/* 제한 한 칸을 나눠 429 로 경계 전에 끝난다
        const headers = { origin: new URL(baseURL).origin, "content-type": "application/json", [CLIENT_IP_HEADER]: randomIp() };
        try {
          const res = await auth.handler(new Request(`${baseURL}/api/auth/sign-in/email`, { method: "POST", headers, body: JSON.stringify({ email: b.email, password: b.password }) }));
          const out = new Headers(res.headers);
          out.set("x-test-barrier-reached", String(p.reached));
          if (p.verified !== null) out.set("x-test-barrier-verified", String(p.verified));
          return settled(new Response(await res.text(), { status: res.status, headers: out }));
        } finally { barriers.delete(b.id); }
      }
      const app = createApp({ services: async () => services, assets: async (c) => c.text("spa"), setupTokenFromSecret: true, log: () => {} });
      return settled(await app.fetch(req));
    } finally {
      ctx.waitUntil(Promise.allSettled(pending).then(() => runtime.close()));
    }
  },
};
