// 회원 목록·상태 API (3단계 실행판 M4.T1).
//   GET   /api/admin/users                         → 200 { users, nextCursor }  허용 목록 DTO, 50개, 고정 정렬
//   POST  /api/admin/users/:id/approve             → 200 { user, sync }
//   POST  /api/admin/users/:id/reject              → 200 { deleted: true }
//   POST  /api/admin/users/:id/suspend             → 200 { user, sync }
//   POST  /api/admin/users/:id/unsuspend           → 200 { user, sync }
//   PATCH /api/admin/users/:id/role { role }       → 200 { user }
//   DELETE /api/admin/users/:id                    → 200 { deleted: true, sync }
//   POST  /api/admin/users/:id/mfa-reset           → 200 { mfaGrant: { grant, expiresAt } }  관리자 MFA 초기화 (A1, X-MFA-Proof mfa.reset)
// 관리자 MFA (A1)
//   - 역할 변경은 X-MFA-Proof(role.change, 대상 id)를 회원 관리 원자 단위 안에서 소비한다. 없으면 403 mfa_proof_required, 맞지 않으면 403 mfa_proof_invalid.
//   - 승격(role → admin)은 같은 단위에서 대상 버전 +1·세션 철회·promotion grant 발급을 한다. grant 토큰은 응답 mfaGrant 로 행위자에게 한 번만 보인다.
//     대상은 그 grant 없이 MFA 를 등록하지 못한다. 강등은 같은 단위에서 대상 factor 를 폐기한다.
//   - 초기화는 자기 자신 409 self, 최초 관리자 409 bootstrap_admin. factor 폐기·대상 세션 철회·버전 +1·reset grant 발급이 한 단위다.
// 공통
//   - 활성 관리자·현재 세션은 DB 에서 다시 확인한다 (sessionAdmin). 변경 요청의 같은 출처 검사는 app.ts 가 /api/admin/* 에 건다.
//   - 변경 여섯 경로는 관리자당 분당 30회. 기존 한도 PATCH(/api/admin/users/:id)는 여기 두지 않고 기존 라우트를 유지한다.
//   - 상태 판정은 transition(Q8·Q11·Q12), DB 변경은 guard-sql 의 회원관리 뮤텍스·CAS·감사·세션 폐기를 그대로 쓴다.
//   - 정지·해제·승격·강등·승인은 DB 커밋 뒤에만 기존 K3 applyKey 를 부른다. 외부 호출은 트랜잭션 밖에 있고,
//     성공은 sync:synced, 실패는 기존 재시도 큐와 sync:pending 이다. 키 행이 없으면 외부 호출은 없다.
import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { DbHandle } from "@magnetosphere/runtime/types";
import type { Services } from "../app.ts";
import { applyKey } from "../keys/apply.ts";
import type { MemberAction, MemberStatus, Role } from "../members/transition.ts";
import { enqueue, RETRY_DELAYS_MS } from "../queue/index.ts";
import { grantInsert } from "@magnetosphere/auth/mfa";
import { consume, proofClaim, sessionAdmin, type AdminSession } from "../routes/guard.ts";
import { deleteMember } from "./delete.ts";
import { MemberConflictError, mutateMember, resetAdminMfa } from "./guard-sql.ts";

export const MEMBER_LIST_LIMIT = 50;
export const MEMBER_ADMIN_LIMIT = { max: 30, windowMs: 60_000 } as const;
const LIST_FIELDS = new Set(["status", "cursor"]);
const ROLE_FIELDS = new Set(["role"]);
const ACTIONS = new Set<MemberAction>(["approve", "reject", "suspend", "unsuspend"]);

interface ListedUser {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
  emailVerified: boolean;
  isBootstrapAdmin: boolean;
  createdAt: string;
}

/** 목록 응답 허용 목록. 인증 버전·이미지·사용액 원문은 나가지 않는다 */
export function memberListView(row: any): ListedUser {
  return {
    id: row.id,
    name: row.name ?? null,
    email: row.email ?? null,
    role: row.role,
    status: row.status,
    emailVerified: row.emailVerified === true || row.emailVerified === 1,
    isBootstrapAdmin: row.isBootstrapAdmin === true || row.isBootstrapAdmin === 1,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function parseCursor(v: string): { createdAt: Date; id: string } | null {
  const cut = v.lastIndexOf("|");
  if (cut <= 0) return null;
  const createdAt = new Date(v.slice(0, cut));
  const id = v.slice(cut + 1);
  if (!Number.isFinite(createdAt.getTime()) || id.length < 1 || id.length > 36) return null;
  return { createdAt, id };
}

function parseList(url: URL): { status?: MemberStatus; cursor?: { createdAt: Date; id: string } } | { error: string } {
  if (![...url.searchParams.keys()].every((key) => LIST_FIELDS.has(key))) return { error: "invalid_query" };
  const status = url.searchParams.get("status");
  if (status !== null && !["pending", "active", "suspended", "deleted"].includes(status)) return { error: "invalid_status" };
  const raw = url.searchParams.get("cursor");
  if (raw !== null && raw.length > 80) return { error: "invalid_cursor" };
  const cursor = raw === null ? undefined : parseCursor(raw);
  if (raw !== null && !cursor) return { error: "invalid_cursor" };
  return { status: status as MemberStatus | undefined, cursor: cursor ?? undefined };
}

async function listMembers(h: DbHandle, query: { status?: MemberStatus; cursor?: { createdAt: Date; id: string } }) {
  const u = h.schema.user;
  const cursor: SQL | undefined = query.cursor ? or(gt(u.createdAt, query.cursor.createdAt), and(eq(u.createdAt, query.cursor.createdAt), gt(u.id, query.cursor.id))) : undefined;
  const rows = await h.db
    .select({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, emailVerified: u.emailVerified, isBootstrapAdmin: u.isBootstrapAdmin, createdAt: u.createdAt })
    .from(u)
    .where(and(query.status ? eq(u.status, query.status) : undefined, cursor))
    .orderBy(asc(u.createdAt), asc(u.id))
    .limit(MEMBER_LIST_LIMIT + 1);
  const page = rows.slice(0, MEMBER_LIST_LIMIT).map(memberListView);
  const last = page[page.length - 1];
  return { users: page, nextCursor: rows.length > MEMBER_LIST_LIMIT ? `${last.createdAt}|${last.id}` : null };
}

/** MFA 를 마친 관리자 세션. get-session 확인은 sessionAdmin 안의 한 번뿐이고 세션 id 도 거기서 받는다 */
async function admitted(c: Context, s: Services): Promise<{ member: AdminSession; sessionId: string } | Response> {
  const member = await sessionAdmin(c, s);
  if (member instanceof Response) return member;
  return { member, sessionId: member.sessionId };
}

function statusOf(code: string): 400 | 401 | 403 | 404 | 409 {
  if (code === "unauthorized") return 401;
  if (code === "forbidden" || code === "mfa_proof_invalid") return 403;
  if (code === "not_found") return 404;
  if (code === "invalid_role") return 400;
  return 409;
}

async function currentView(h: DbHandle, id: string): Promise<ListedUser | null> {
  const u = h.schema.user;
  const [row] = await h.db
    .select({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, emailVerified: u.emailVerified, isBootstrapAdmin: u.isBootstrapAdmin, createdAt: u.createdAt })
    .from(u)
    .where(eq(u.id, id));
  return row ? memberListView(row) : null;
}

export async function syncTargetKeys(s: Services, userId: string, now: Date): Promise<"synced" | "pending" | "none"> {
  const k = s.db.schema.apiKeys;
  const rows: { id: string }[] = await s.db.db.select({ id: k.id }).from(k).where(eq(k.userId, userId));
  if (rows.length === 0) return "none";
  let client: Awaited<ReturnType<NonNullable<Services["keysClient"]>>> | undefined;
  try {
    client = await s.keysClient?.();
  } catch {
    // 클라이언트 생성 실패도 커밋된 회원 상태를 되돌리지 않고 기존 큐에 맡긴다.
  }
  let pending = false;
  for (const row of rows) {
    if (client) {
      try {
        const result = await applyKey(s.db, row.id, { client, now });
        if (result.syncState !== "synced") pending = true;
        continue;
      } catch {
        // applyKey 자체의 저장 실패 등도 성공으로 응답하지 않는다.
      }
    }
    pending = true;
    await s.db.db.update(k).set({ syncState: "pending" }).where(eq(k.id, row.id));
    await enqueue(s.db, "key.apply_state", { keyId: row.id }, { runAt: new Date(now.getTime() + RETRY_DELAYS_MS[0]), now });
  }
  return pending ? "pending" : "synced";
}

/** 공용 app.ts 연결 전 시험이 전체 경로를 실을 독립 Hono. 운영 연결은 부모 후속 작업이다 */
export function memberAdminRoutes(services: () => Promise<Services>) {
  const r = new Hono();

  r.get("/users", async (c) => {
    const s = await services();
    const admin = await sessionAdmin(c, s);
    if (admin instanceof Response) return admin;
    const query = parseList(new URL(c.req.url));
    if ("error" in query) return c.json({ error: query.error }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(await listMembers(s.db, query));
  });

  const change = (action: MemberAction) => async (c: Context) => {
    const s = await services();
    const admin = await admitted(c, s);
    if (admin instanceof Response) return admin;
    if (!(await consume(s.db, `member-admin|${admin.member.id}`, MEMBER_ADMIN_LIMIT.max, MEMBER_ADMIN_LIMIT.windowMs, Date.now()))) return c.json({ error: "rate_limited" }, 429);
    const targetId = c.req.param("id");
    if (!targetId || targetId.length > 36) return c.json({ error: "not_found" }, 404);
    let role: Role | undefined;
    let mfa: Parameters<typeof mutateMember>[1]["mfa"];
    let mfaGrant: { token: string; expiresAt: Date } | null = null;
    if (action === "role") {
      if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "invalid_body" }, 400);
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).every((key) => ROLE_FIELDS.has(key))) return c.json({ error: "invalid_body" }, 400);
      role = (body as { role?: Role }).role;
      // 역할 변경은 민감 작업이다: 이 대상에 묶인 step-up proof 를 회원 관리 단위 안에서 소비한다 (A1)
      const claim = await proofClaim(c, s, admin.member, "role.change", targetId);
      if (claim instanceof Response) return claim;
      const rt = s.mfa!;
      const policy = rt.policy.state === "ready" ? rt.policy.policy : null;
      mfa = {
        proof: claim.step,
        promote: policy
          ? async (nextAuthVersion) => {
              const g = await grantInsert(s.db, rt.key, policy, { userId: targetId, purpose: "promotion", issuedBy: admin.member.id, authVersion: nextAuthVersion });
              mfaGrant = { token: g.token, expiresAt: g.expiresAt };
              return g;
            }
          : undefined,
      };
    }
    const now = new Date();
    const ip = (await s.clientIp?.(c.req.raw)) ?? null;
    try {
      if (action === "delete") {
        // 자기 계정은 관리자 API 로 지우지 않는다. 자기 탈퇴는 DELETE /api/me + 비밀번호 재확인뿐이다 (설계 탈퇴 절, M4 보안 리뷰 M1)
        if (targetId === admin.member.id) return c.json({ error: "self" }, 409);
        const deleted = await deleteMember(s, { actorId: admin.member.id, actorSessionId: admin.sessionId, targetId, ip, now });
        return c.json(deleted);
      }
      const result = await mutateMember(s.db, {
        action,
        actorId: admin.member.id,
        actorSessionId: admin.sessionId,
        targetId,
        role,
        now,
        mfa,
        audit: { actorId: admin.member.id, action: action === "role" ? "member.role" : (`member.${action}` as const), target: targetId, detail: action === "role" ? { role } : { from: "cas", to: action }, ip, now },
      });
      if (result.to === "row_deleted") return c.json({ deleted: true });
      const sync = await syncTargetKeys(s, targetId, now);
      const granted = mfaGrant as { token: string; expiresAt: Date } | null;
      if (!granted) return c.json({ user: await currentView(s.db, targetId), sync });
      // promotion grant 토큰은 이 응답에만 한 번 나간다
      c.header("Cache-Control", "no-store");
      return c.json({ user: await currentView(s.db, targetId), sync, mfaGrant: { grant: granted.token, expiresAt: granted.expiresAt.toISOString() } });
    } catch (e) {
      if (e instanceof MemberConflictError) return c.json({ error: e.code }, statusOf(e.code));
      throw e;
    }
  };

  r.post("/users/:id/mfa-reset", async (c) => {
    const s = await services();
    const admin = await admitted(c, s);
    if (admin instanceof Response) return admin;
    if (!(await consume(s.db, `member-admin|${admin.member.id}`, MEMBER_ADMIN_LIMIT.max, MEMBER_ADMIN_LIMIT.windowMs, Date.now()))) return c.json({ error: "rate_limited" }, 429);
    const targetId = c.req.param("id");
    if (!targetId || targetId.length > 36) return c.json({ error: "not_found" }, 404);
    const claim = await proofClaim(c, s, admin.member, "mfa.reset", targetId);
    if (claim instanceof Response) return claim;
    const rt = s.mfa!;
    if (rt.policy.state !== "ready") return c.json({ error: "mfa_policy_unavailable" }, 503);
    const policy = rt.policy.policy;
    const now = new Date();
    const ip = (await s.clientIp?.(c.req.raw)) ?? null;
    let issued: { token: string; expiresAt: Date } | null = null;
    try {
      await resetAdminMfa(s.db, {
        actorId: admin.member.id,
        actorSessionId: admin.sessionId,
        targetId,
        proof: claim.step,
        grant: async (nextAuthVersion) => {
          const g = await grantInsert(s.db, rt.key, policy, { userId: targetId, purpose: "reset", issuedBy: admin.member.id, authVersion: nextAuthVersion, now });
          issued = { token: g.token, expiresAt: g.expiresAt };
          return g;
        },
        audit: { actorId: admin.member.id, action: "mfa.reset", target: targetId, detail: { grant: "reset" }, ip, now },
        now,
      });
    } catch (e) {
      if (e instanceof MemberConflictError) return c.json({ error: e.code }, statusOf(e.code));
      throw e;
    }
    const grant = issued as { token: string; expiresAt: Date } | null;
    c.header("Cache-Control", "no-store");
    return c.json({ mfaGrant: grant ? { grant: grant.token, expiresAt: grant.expiresAt.toISOString() } : null });
  });

  for (const action of ACTIONS) r.post(`/users/:id/${action}`, change(action));
  r.delete("/users/:id", change("delete"));
  r.patch("/users/:id/role", change("role"));
  return r;
}
