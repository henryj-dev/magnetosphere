// 자기 탈퇴 (3단계 실행판 M4.T4).
// DELETE /api/me { password }: exact root 와 같은 출처, 현재 active 세션, 분당 5회 비밀번호 proof.
// proof 는 트랜잭션 밖에서 auth 내부 selfDeleteCredentialProof 가 만들고, 그 결과의 credential·세션·버전을 primitive CAS 가 다시 확인한다.
// 비밀번호가 틀리면 403 이고 회원·세션·credential 은 바꾸지 않는다. OAuth 만 있는 회원은 현재 정책에서 같은 403 이다.
import { Hono, type Context } from "hono";
import type { SelfDeleteCredentialProof } from "@magnetosphere/auth";
import type { Services } from "../app.ts";
import { consume, sessionMember } from "../routes/guard.ts";
import { deleteMember, MemberConflictError } from "./delete.ts";
import { memberSelfProof, type MemberSelfProof } from "./guard-sql.ts";

export const SELF_DELETE_LIMIT = { max: 5, windowMs: 60_000 } as const;
const BODY_FIELDS = new Set(["password"]);

interface SelfDeleteAuth {
  selfDeleteCredentialProof(input: { userId: string; sessionId: string; password: string }): Promise<SelfDeleteCredentialProof | null>;
}

function observedProof(value: SelfDeleteCredentialProof | null): MemberSelfProof | null {
  if (!value || typeof value !== "object") return null;
  const { authVersion, accountId, passwordHash, observedSessionFingerprint, currentCredentialFingerprint } = value;
  if (!Number.isSafeInteger(authVersion) || typeof accountId !== "string" || typeof passwordHash !== "string" || typeof currentCredentialFingerprint !== "string" || currentCredentialFingerprint.length !== 64) return null;
  if (observedSessionFingerprint !== null && typeof observedSessionFingerprint !== "string") return null;
  return memberSelfProof(value);
}

function statusOf(code: string): 401 | 403 | 409 | 500 {
  if (code === "unauthorized") return 401;
  if (code === "bootstrap_admin" || code === "last_admin" || code === "stale_member" || code === "version_exhausted") return 409;
  if (code === "auth_unavailable") return 500;
  return 403;
}

async function currentSessionId(c: Context, s: Services): Promise<string | null> {
  const probe = new Request(new URL("/api/auth/get-session", c.req.url), { headers: { cookie: c.req.header("cookie") ?? "" } });
  const res = await s.auth.handler(probe);
  const body = res.ok ? ((await res.json().catch(() => null)) as { session?: { id?: unknown } } | null) : null;
  return typeof body?.session?.id === "string" ? body.session.id : null;
}

/** 공용 app.ts 의 exact /api/me 연결 전 시험용 독립 Hono. sameOrigin 은 호출 앱이 DELETE 에 직접 건다 */
export function selfDeleteRoutes(services: () => Promise<Services>) {
  const r = new Hono();
  r.delete("/", async (c) => {
    const s = await services();
    const member = await sessionMember(c, s);
    if (member instanceof Response) return member;
    if (member.status !== "active") return c.json({ error: "forbidden" }, 403);
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "invalid_body" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).every((key) => BODY_FIELDS.has(key))) return c.json({ error: "invalid_body" }, 400);
    const password = (body as { password?: unknown }).password;
    if (typeof password !== "string" || password.length < 1 || password.length > 128) return c.json({ error: "invalid_body" }, 400);
    const sessionId = await currentSessionId(c, s);
    if (!sessionId) return c.json({ error: "unauthorized" }, 401);
    const nowMs = Date.now();
    if (!(await consume(s.db, `self-delete|${member.id}`, SELF_DELETE_LIMIT.max, SELF_DELETE_LIMIT.windowMs, nowMs))) return c.json({ error: "rate_limited" }, 429);
    const prove = (s.auth as Services["auth"] & Partial<SelfDeleteAuth>).selfDeleteCredentialProof;
    if (!prove) return c.json({ error: "auth_unavailable" }, 500);
    let authProof: SelfDeleteCredentialProof | null;
    try {
      authProof = await prove.call(s.auth, { userId: member.id, sessionId, password });
    } catch {
      return c.json({ error: "auth_unavailable" }, 500);
    }
    const casProof: MemberSelfProof | null = observedProof(authProof);
    if (!casProof) return c.json({ error: "forbidden" }, 403);
    const now = new Date(nowMs);
    try {
      const result = await deleteMember(s, { actorId: member.id, actorSessionId: sessionId, targetId: member.id, selfProof: casProof, ip: (await s.clientIp?.(c.req.raw)) ?? null, now });
      return c.json({ deleted: result.deleted, sync: result.sync });
    } catch (e) {
      if (e instanceof MemberConflictError) return c.json({ error: e.code }, statusOf(e.code));
      return c.json({ error: "internal_error" }, 500);
    }
  });
  return r;
}
