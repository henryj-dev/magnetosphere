// 최초 설치 API.
//   GET  /api/setup  → { needed } 관리자가 없으면 true. setupTokenFromSecret(Workers)이면 SETUP_TOKEN 시크릿의 해시를 둔다
//                      (출력하지 않는다). 시크릿이 없으면 관리자가 생기기 전까지 GET·POST 모두 503 setup_token_required
//   POST /api/setup  → 201 { ok, omniroute: "connected" | "manual_required" } | 400 입력 오류 | 401 토큰 틀림 | 409 이미 설치됨
//                      | 429 시도 횟수 초과 (클라이언트 IP 마다 10분에 10회)
//                      관리자를 만든 뒤 OmniRoute 토큰을 자동으로 만든다. 실패해도 201 이고 omniroute 가 manual_required 다
// OmniRoute 토큰 (관리자 세션만, 계획서 4.7 3번 "토큰 붙여 넣기")
//   GET  /api/setup/omniroute → { omniroute } 저장된 토큰이 있으면 connected
//   PUT  /api/setup/omniroute { token } → 200 { omniroute: "connected" } | 400 invalid_token·scope_not_write | 502 omniroute_unreachable
//   세션 없음 401, 관리자 아님 403, JSON 이 아닌 본문 415 (교차 출처 form 전송을 받지 않는다)
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { Services } from "../app.ts";
import { adminExists, consumeSetupAttempt, ensureSetupToken, runSetup } from "./index.ts";
import { bootstrapOmniRoute, omniRouteStatus, saveManualToken } from "./omniroute.ts";

/** 요청의 Better Auth 세션 사용자가 관리자면 그 id. 세션이 없으면 401, 관리자가 아니면 403 응답 */
async function requireAdmin(c: Context, s: Services): Promise<string | Response> {
  const probe = new Request(new URL("/api/auth/get-session", c.req.url), { headers: { cookie: c.req.header("cookie") ?? "" } });
  const res = await s.auth.handler(probe);
  const session = res.ok ? ((await res.json().catch(() => null)) as { user?: { id?: unknown } } | null) : null;
  const userId = session?.user?.id;
  if (typeof userId !== "string") return c.json({ error: "unauthorized" }, 401);
  // 역할은 세션 응답이 아니라 DB 에서 읽는다
  const u = s.db.schema.user;
  const [row] = await s.db.db.select({ role: u.role }).from(u).where(eq(u.id, userId));
  if (row?.role !== "admin") return c.json({ error: "forbidden" }, 403);
  return userId;
}

/** Workers 인데 SETUP_TOKEN 이 없고 아직 관리자가 없으면 503 응답 (S6 보안 리뷰 M2). 인증 없는 요청이라 로그는 남기지 않는다 */
async function secretMissing(c: Context, s: Services, opts: { setupTokenFromSecret: boolean; log: (line: string) => void }): Promise<Response | null> {
  if (!opts.setupTokenFromSecret || s.setupToken || (await adminExists(s.db))) return null;
  return c.json({ error: "setup_token_required" }, 503);
}

export function setupRoutes(services: () => Promise<Services>, opts: { setupTokenFromSecret: boolean; log: (line: string) => void }) {
  const r = new Hono();
  r.get("/", async (c) => {
    const s = await services();
    const missing = await secretMissing(c, s, opts);
    if (missing) return missing;
    if (opts.setupTokenFromSecret) await ensureSetupToken(s.db, { rotate: false, log: opts.log, fixedToken: s.setupToken });
    return c.json({ needed: !(await adminExists(s.db)) });
  });
  r.post("/", async (c) => {
    const s = await services();
    const missing = await secretMissing(c, s, opts);
    if (missing) return missing;
    // 설치 토큰 무차별 대입을 막는다: IP 마다 10분에 10회 (S6 보안 리뷰 M1)
    if (!(await consumeSetupAttempt(s.db, (await s.clientIp?.(c.req.raw)) ?? null))) return c.json({ error: "too_many_requests" }, 429);
    // Workers 는 GET 없이 바로 POST 가 와도 시크릿의 해시를 먼저 둔다
    if (opts.setupTokenFromSecret) await ensureSetupToken(s.db, { rotate: false, log: opts.log, fixedToken: s.setupToken });
    const body = await c.req.json().catch(() => ({}));
    const bootstrap = async (userId: string) => {
      const b = await bootstrapOmniRoute(s.db, s.cipher, s.omniroute, userId);
      if (b.status !== "connected") opts.log(`[setup] OmniRoute 접근 토큰을 자동으로 만들지 못했다 (${b.reason}). 관리자로 로그인해 토큰을 붙여 넣는다.`);
      return b.status;
    };
    const result = await runSetup(s.db, body && typeof body === "object" ? body : {}, async () => s.cipher, bootstrap);
    return result.ok ? c.json({ ok: true, omniroute: result.omniroute }, 201) : c.json({ error: result.error }, result.status);
  });
  r.get("/omniroute", async (c) => {
    const s = await services();
    const admin = await requireAdmin(c, s);
    if (admin instanceof Response) return admin;
    return c.json({ omniroute: await omniRouteStatus(s.db) });
  });
  r.put("/omniroute", async (c) => {
    const s = await services();
    const admin = await requireAdmin(c, s);
    if (admin instanceof Response) return admin;
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "unsupported_media_type" }, 415);
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const saved = await saveManualToken(s.db, s.cipher, s.omniroute, body?.token, admin);
    if (saved.ok) return c.json({ omniroute: "connected" });
    return c.json({ error: saved.error }, saved.error === "omniroute_unreachable" ? 502 : 400);
  });
  return r;
}
