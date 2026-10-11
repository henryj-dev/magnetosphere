// TC-SEC.2.a 의 D1 시험 Worker. 진입점 workers.ts 와 같이 요청마다 connectWorkers → createAuth 를 만든다. 진입 모듈이라 default 말고는 내보내지 않는다.
//   - 메일: isolate 하나에 하나 있는 outbox (보낸 메일을 모은다).
//   - 회원: 가입 경로를 거치지 않고 user·account(credential) 행을 바로 넣는다 (인증 끝난 회원).
//   POST /__test/user {email, password} → { id }
//   GET  /__test/outbox                 → { mails: [{ to, subject, text }] }
//   GET  /__test/verifications          → { reset } 남은 비밀번호 재설정 토큰 행 수
import { createAuth, type MailMessage } from "@magnetosphere/auth";
import { connectWorkers, type WorkersEnv } from "@magnetosphere/runtime/workers";
import { hashPassword } from "better-auth/crypto";
import { like } from "drizzle-orm";

interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

const outbox: MailMessage[] = [];

export default {
  async fetch(req: Request, env: WorkersEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const db = await connectWorkers(env);
    if (url.pathname === "/__test/user" && req.method === "POST") {
      const b = (await req.json()) as { email: string; password: string };
      const id = crypto.randomUUID();
      const now = new Date();
      await db.db.insert(db.schema.user).values({ id, name: "d1", email: b.email, emailVerified: true, createdAt: now, updatedAt: now });
      await db.db.insert(db.schema.account).values({ id: crypto.randomUUID(), userId: id, accountId: id, providerId: "credential", password: await hashPassword(b.password), createdAt: now, updatedAt: now });
      return Response.json({ id });
    }
    if (url.pathname === "/__test/outbox") return Response.json({ mails: outbox });
    if (url.pathname === "/__test/verifications") {
      const rows = await db.db.select().from(db.schema.verification).where(like(db.schema.verification.identifier, "reset-password:%"));
      return Response.json({ reset: rows.length });
    }
    const baseURL = String(env.BETTER_AUTH_URL);
    const auth = createAuth({
      database: db,
      baseURL,
      secret: "mg-test-secret-mg-test-secret-mg-test-secret",
      trustedOrigins: [baseURL],
      mailer: { send: async (m) => void outbox.push(m) },
      clientIp: () => "203.0.113.9",
      waitUntil: (p) => ctx.waitUntil(p),
      onMailError: (e) => console.error("[mail]", e),
    });
    return auth.handler(req);
  },
};
