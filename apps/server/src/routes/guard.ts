// 회원·관리자 API 공용 검사 (계획서 v5.7 4.5·4.6·7장, K4.T4).
//   - CSRF: /api/me·/api/me/*·/api/admin/*·/api/setup·/api/setup/* 의 GET·HEAD 아닌 요청은 정확한 Origin 을 요구한다. Origin 이 없어도 403.
//     세션 쿠키가 SameSite=Lax 라도 같은 사이트의 다른 하위 도메인 페이지는 쿠키를 실어 보낼 수 있다 (7장 "변경 API 는 CSRF 보호").
//   - 세션: Better Auth get-session 으로 회원 id·세션 id 만 얻고, 역할·상태·한도·MFA 충족은 DB 에서 읽는다 (세션 응답의 값을 믿지 않는다).
//     관리자는 MFA 를 마친 세션만 관리 API·회원 API 를 쓴다 (A1). 민감 작업은 작업에 묶인 step-up proof 를 작업 안에서 소비한다.
//   - 요청 수 제한: 키 발급·재발급은 회원당 1시간 10회, 클라이언트 IP 당 1시간 30회 (계획서 v5.6 Q4). 저장소는 rate_limit 테이블이라
//     여러 인스턴스가 함께 센다. IPv6 는 /64 로 묶는다. 키 변경(켜기·끄기·이름·재발급·삭제)은 회원당 분당 30회. 한 칸은 "처음 요청 시각부터 1시간" 고정 창이다. 칸 넣기·올리기가 DB 한 문장씩이라 동시에 와도 넘지 않는다.
import { and, eq, lt, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { judgeMfa, MFA_PROOF_HEADER, proofConsumeUpdate, proofTokenHash, readAuthContext, validToken, type AuthContextRow, type MfaJudgement, type MfaProofPurpose, type UnitStep } from "@magnetosphere/auth/mfa";
import type { DbHandle } from "@magnetosphere/runtime/types";
import type { Services } from "../app.ts";

/** 세션 회원의 DB 값 */
export interface Member {
  id: string;
  role: string;
  status: string;
  emailVerified: boolean;
  monthlyLimitUsd: number | null;
  maxKeys: number | null;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** 변경 요청의 Origin 검사. appOrigin 을 모르면(설정 누락) 모든 변경 요청을 막는다 (fail-closed) */
export function sameOrigin(services: () => Promise<Services>): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const want = (await services()).appOrigin;
    const got = c.req.header("origin");
    if (!want || !got || got !== want) return c.json({ error: "forbidden_origin" }, 403);
    return next();
  };
}

/** get-session 을 한 번 불러 회원 id 와 세션 id 를 함께 얻는다. 없으면 null */
async function probeSession(c: Context, s: Services): Promise<{ userId: string; sessionId: string | null } | null> {
  const probe = new Request(new URL("/api/auth/get-session", c.req.url), { headers: { cookie: c.req.header("cookie") ?? "" } });
  const res = await s.auth.handler(probe);
  const session = res.ok ? ((await res.json().catch(() => null)) as { user?: { id?: unknown }; session?: { id?: unknown } } | null) : null;
  const userId = session?.user?.id;
  if (typeof userId !== "string") return null;
  return { userId, sessionId: typeof session?.session?.id === "string" ? session.session.id : null };
}

const memberOf = (c: AuthContextRow): Member => ({
  id: c.user.id,
  role: c.user.role,
  status: c.user.status,
  emailVerified: c.user.emailVerified,
  monthlyLimitUsd: c.user.monthlyLimitUsd,
  maxKeys: c.user.maxKeys,
});

/** 세션 회원·세션·active factor 를 한 번에 읽는다. authoritative 인증 응답이 없거나 DB 에 회원이 없으면 401 */
async function readSessionContext(c: Context, s: Services): Promise<{ ctx: AuthContextRow; sessionId: string | null } | Response> {
  const probed = await probeSession(c, s);
  if (!probed) return c.json({ error: "unauthorized" }, 401);
  const ctx = await readAuthContext(s.db, probed);
  if (!ctx) return c.json({ error: "unauthorized" }, 401);
  return { ctx, sessionId: probed.sessionId };
}

/**
 * 관리자 역할 세션의 MFA 판정 응답. 충족이면 null. 정책 없음 503 mfa_policy_unavailable, 세션 무효 401,
 * 미등록 403 mfa_enrollment_required, 미충족(부분 세션·정책 버전 불일치·factor 교체) 403 mfa_required
 */
function mfaDenied(c: Context, s: Services, ctx: AuthContextRow): { judged: MfaJudgement; denied: Response | null } {
  const judged = judgeMfa(ctx, s.mfa?.policy ?? { state: "unavailable", reason: "missing", field: "MFA_TOTP_PERIOD_S" }, new Date());
  if (judged.state === "satisfied") return { judged, denied: null };
  if (judged.state === "policy_unavailable") return { judged, denied: c.json({ error: "mfa_policy_unavailable" }, 503) };
  if (judged.state === "invalid_session") return { judged, denied: c.json({ error: "unauthorized" }, 401) };
  return { judged, denied: c.json({ error: judged.state === "enrollment_required" ? "mfa_enrollment_required" : "mfa_required" }, 403) };
}

/**
 * 일반 회원 API. 인증이 반환한 회원도 현재 DB 상태가 active 가 아니면 접근을 막는다.
 * 관리자 역할은 MFA 를 마친 세션만 회원 API 를 쓴다 (부분 세션으로 회원 API 를 쓰지 못하게, A1 설계 4절 로그인 4번)
 */
export async function sessionMember(c: Context, s: Services): Promise<Member | Response> {
  const p = await sessionPrincipal(c, s);
  return p instanceof Response ? p : p.member;
}

/**
 * 회원 API 의 세션 주체. sessionMember 와 같은 판정에 세션 id 와 (관리자면) MFA 를 마친 관리자 세션을 함께 돌려준다.
 * get-session 확인은 한 번이다 (자기 탈퇴가 세션 id 를 다시 묻지 않게)
 */
export async function sessionPrincipal(c: Context, s: Services): Promise<{ member: Member; sessionId: string | null; admin: AdminSession | null } | Response> {
  const read = await readSessionContext(c, s);
  if (read instanceof Response) return read;
  const u = read.ctx.user;
  if (u.status !== "active") return c.json({ error: "member_inactive" }, 403);
  if (u.role !== "admin") return { member: memberOf(read.ctx), sessionId: read.sessionId, admin: null };
  const { judged, denied } = mfaDenied(c, s, read.ctx);
  if (denied || judged.state !== "satisfied" || !read.sessionId) return denied ?? c.json({ error: "unauthorized" }, 401);
  const admin = { ...memberOf(read.ctx), sessionId: read.sessionId, factorId: judged.factorId, authVersion: u.authVersion, isBootstrapAdmin: u.isBootstrapAdmin };
  return { member: memberOf(read.ctx), sessionId: read.sessionId, admin };
}

export async function readMember(h: DbHandle, userId: string): Promise<Member | null> {
  const u = h.schema.user;
  const [row] = await h.db
    .select({ id: u.id, role: u.role, status: u.status, emailVerified: u.emailVerified, monthlyLimitUsd: u.monthlyLimitUsd, maxKeys: u.maxKeys })
    .from(u)
    .where(eq(u.id, userId));
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    emailVerified: row.emailVerified === true || row.emailVerified === 1,
    monthlyLimitUsd: row.monthlyLimitUsd == null ? null : Number(row.monthlyLimitUsd),
    maxKeys: row.maxKeys == null ? null : Number(row.maxKeys),
  };
}

/** MFA 를 마친 관리자 세션. 민감 작업의 proof 소비에 쓰는 세션·factor·인증 버전을 함께 돌려준다 */
export interface AdminSession extends Member {
  sessionId: string;
  factorId: string;
  authVersion: number;
  isBootstrapAdmin: boolean;
}

/**
 * 관리자 세션. get-session 확인은 한 번이고, 세션·회원·active factor 를 한 SELECT 로 읽어 MFA 충족(verified_at·factor·policy_version·authVersion)을 판정한다.
 * 세션 없음 401, 관리자가 아니거나 활성 상태가 아니면 403 forbidden, 정책 없음 503 mfa_policy_unavailable, MFA 미충족 403 mfa_required·mfa_enrollment_required
 */
export async function sessionAdmin(c: Context, s: Services): Promise<AdminSession | Response> {
  // 일반 회원의 member_inactive 오류와 분리해 기존 관리자 API 의 forbidden 계약을 유지한다.
  const read = await readSessionContext(c, s);
  if (read instanceof Response) return read;
  const u = read.ctx.user;
  if (u.role !== "admin" || u.status !== "active") return c.json({ error: "forbidden" }, 403);
  const { judged, denied } = mfaDenied(c, s, read.ctx);
  if (denied || judged.state !== "satisfied" || !read.sessionId) return denied ?? c.json({ error: "unauthorized" }, 401);
  return { ...memberOf(read.ctx), sessionId: read.sessionId, factorId: judged.factorId, authVersion: u.authVersion, isBootstrapAdmin: u.isBootstrapAdmin };
}

/** 민감 작업이 자기 트랜잭션·batch 안에서 소비할 proof. step 은 runUnit·mutateMember 가 받는 단계다 */
export interface ProofClaim {
  purpose: MfaProofPurpose;
  target: string;
  /** 정확히 한 행이어야 하는 proof 소비 UPDATE (실행하지 않는다) */
  step: UnitStep;
}

/**
 * 민감 작업 관리자 세션 (역할 변경·관리자 초대·MFA 초기화·관리자 탈퇴). X-MFA-Proof 머리글의 proof 를 이 세션·회원·인증 버전·factor·purpose·target 에
 * 묶은 소비 단계를 만든다. 실제 소비는 작업의 원자 단위 안에서 한다 (0행이면 작업 전체를 되돌린다). 머리글이 없으면 403 mfa_proof_required
 */
export async function sessionAdminWithProof(c: Context, s: Services, purpose: MfaProofPurpose, target: string): Promise<{ admin: AdminSession; proof: ProofClaim } | Response> {
  const admin = await sessionAdmin(c, s);
  if (admin instanceof Response) return admin;
  const proof = await proofClaim(c, s, admin, purpose, target);
  if (proof instanceof Response) return proof;
  return { admin, proof };
}

/** 이미 확인한 관리자 세션에 proof 소비 단계를 붙인다 (목적·대상을 본문을 읽은 뒤 정하는 작업용) */
export async function proofClaim(c: Context, s: Services, admin: AdminSession, purpose: MfaProofPurpose, target: string): Promise<ProofClaim | Response> {
  const token = c.req.header(MFA_PROOF_HEADER);
  if (!s.mfa || !validToken(token)) return c.json({ error: "mfa_proof_required" }, 403);
  const tokenHash = await proofTokenHash(s.mfa.key, token);
  const now = new Date();
  const h = s.db;
  return {
    purpose,
    target,
    step: {
      build: (db: any) => proofConsumeUpdate(h, db, { tokenHash, sessionId: admin.sessionId, userId: admin.id, authVersion: admin.authVersion, factorId: admin.factorId, purpose, target, now }),
      one: (x: any) => x.mfaProof.id,
    },
  };
}

/** 키 발급·재발급 요청 수 제한 (Q4) */
export const ISSUE_LIMITS = {
  member: { max: 10, windowMs: 60 * 60_000 },
  ip: { max: 30, windowMs: 60 * 60_000 },
} as const;

/** rate_limit 칸 하나에서 한 번을 쓴다. 창 안에서 max 번을 이미 썼으면 false */
export async function consume(h: DbHandle, key: string, max: number, windowMs: number, now: number): Promise<boolean> {
  const t = h.schema.rateLimit;
  await h.db.delete(t).where(and(eq(t.key, key), lt(t.lastRequest, now - windowMs)));
  const row = { id: crypto.randomUUID(), key, count: 1, lastRequest: now };
  const inserted =
    h.provider === "mysql"
      ? (await h.db.insert(t).ignore().values(row))[0].affectedRows === 1
      : (await h.db.insert(t).values(row).onConflictDoNothing().returning()).length === 1;
  if (inserted) return true;
  const bump = h.db.update(t).set({ count: sql`${t.count} + 1` }).where(and(eq(t.key, key), lt(t.count, max)));
  if (h.provider === "mysql") return (await bump)[0].affectedRows === 1;
  return (await bump.returning()).length === 1;
}

/**
 * IP 칸 이름. IPv6 는 /64 로 묶는다 — 한 회선이 보통 /64 하나를 받아 그 안의 주소를 마음대로 바꿀 수 있다 (K4 보안 리뷰 L4).
 * ::ffff:a.b.c.d 는 IPv4 a.b.c.d 와 같은 칸. 못 정한 IP(null)는 한 칸 "unknown"
 */
export function ipBucket(ip: string | null): string {
  if (!ip) return "unknown";
  let s = ip.trim().toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return s;
  // 끝의 a.b.c.d 를 16진수 두 묶음으로
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    s = s.slice(0, tail.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups = (rest === undefined ? h : [...h, ...Array(Math.max(8 - h.length - r.length, 0)).fill("0"), ...r]).map((g) => parseInt(g || "0", 16) || 0);
  // ::ffff:a.b.c.d (IPv4 사상 주소)
  if (groups.length === 8 && groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** 발급·재발급 한 번. 회원 칸을 먼저 쓰고, 넘지 않았을 때만 IP 칸을 쓴다. 둘 중 하나라도 넘으면 false */
export async function consumeIssue(h: DbHandle, userId: string, ip: string | null, now = Date.now()): Promise<boolean> {
  if (!(await consume(h, `key-issue|member|${userId}`, ISSUE_LIMITS.member.max, ISSUE_LIMITS.member.windowMs, now))) return false;
  return consume(h, `key-issue|ip|${ipBucket(ip)}`, ISSUE_LIMITS.ip.max, ISSUE_LIMITS.ip.windowMs, now);
}

/** 키 변경(켜기·끄기·이름·재발급·삭제) 요청 수 제한: 회원당 분당 30회 (K4 보안 리뷰 L3). 끄기·켜기·삭제는 OmniRoute 를 부른다 */
export const CHANGE_LIMITS = { member: { max: 30, windowMs: 60_000 } } as const;

/** 키 변경 한 번. 넘으면 false */
export async function consumeChange(h: DbHandle, userId: string, now = Date.now()): Promise<boolean> {
  return consume(h, `key-change|member|${userId}`, CHANGE_LIMITS.member.max, CHANGE_LIMITS.member.windowMs, now);
}
