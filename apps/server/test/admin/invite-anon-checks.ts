// TC-M6.T5.a 회원 삭제의 초대 정리 공용 장치 (M6 후속 U1). Node DB 넷(invite-anon.db.test.ts)과 실제 D1 시험 Worker(invite-anon-worker.ts)가 같이 쓴다.
// Worker 에서도 돌아야 하므로 vitest·node: 모듈을 가져오지 않는다. 단언은 각 시험 파일이 한다.
// 돌려주는 행에는 token_hash·세션 token 을 넣지 않는다 (실패 출력에 비밀값이 찍히지 않게).
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@magnetosphere/runtime/types";
import type { MemberMutation } from "../../src/admin/guard-sql.ts";

export const INVITE_ANON_NOW = new Date("2026-10-13T00:00:00.000Z");
const DAY = 86_400_000;

/** 초대 사례. 앞의 넷만 삭제로 바뀐다 */
export const INVITE_CASES = [
  "accepted", // 대상이 지금 이메일로 수락 → email 익명화, used_by 유지
  "acceptedOldEmail", // 대상이 예전 이메일로 수락 → email 익명화, used_by 유지
  "pending", // 대상 이메일의 미사용·미철회 초대 → revoked_at = now
  "expiredPending", // 만료했지만 미사용·미철회 → revoked_at = now
  "alreadyRevoked", // 이미 철회 → 그대로 (revoked_at 을 덮어쓰지 않는다)
  "caseVariant", // 대소문자만 다른 미사용 초대 → 그대로 (바이트 비교, MySQL 기본 정렬에 기대지 않는다)
  "otherAccepted", // 다른 회원이 수락 → 그대로
  "otherPending", // 다른 이메일의 미사용 초대 → 그대로
] as const;
export type InviteCase = (typeof INVITE_CASES)[number];

export interface InviteRow { email: string | null; usedBy: string | null; usedAt: number | null; revokedAt: number | null; expiresAt: number }
export interface InviteAnonFixture {
  actor: string;
  actorSession: string;
  target: string;
  targetEmail: string;
  targetSession: string;
  other: string;
  invites: Record<InviteCase, string>;
  seeded: Record<InviteCase, InviteRow>;
}
export interface MemberSide {
  target: { status: string; email: string; name: string };
  targetSessions: number;
  actorSessions: number;
  audits: { actorId: string | null; action: string; target: string | null }[];
}

const ms = (v: unknown): number | null => (v == null ? null : new Date(v as string | number | Date).getTime());

/** 관리자·대상·다른 회원과 초대 여덟 건을 넣는다. id 는 회마다 새로 만든다 */
export async function seedInviteAnon(h: DbHandle, now: Date = INVITE_ANON_NOW): Promise<InviteAnonFixture> {
  const id = () => crypto.randomUUID();
  const actor = id();
  const target = id();
  const other = id();
  const actorSession = id();
  const targetSession = id();
  const targetEmail = `target-${target}@example.com`;
  const otherEmail = `other-${other}@example.com`;
  const at = (offset: number) => new Date(now.getTime() + offset);
  await h.db.insert(h.schema.user).values([
    { id: actor, name: "actor", email: `actor-${actor}@example.com`, emailVerified: true, role: "admin", status: "active", isBootstrapAdmin: false, authVersion: 0, createdAt: now, updatedAt: now },
    { id: target, name: "target", email: targetEmail, emailVerified: true, role: "member", status: "active", isBootstrapAdmin: false, authVersion: 0, createdAt: now, updatedAt: now },
    { id: other, name: "other", email: otherEmail, emailVerified: true, role: "member", status: "active", isBootstrapAdmin: false, authVersion: 0, createdAt: now, updatedAt: now },
  ]);
  await h.db.insert(h.schema.session).values([
    { id: actorSession, expiresAt: at(3_600_000), token: id(), createdAt: now, updatedAt: now, userId: actor, authVersion: 0 },
    { id: targetSession, expiresAt: at(3_600_000), token: id(), createdAt: now, updatedAt: now, userId: target, authVersion: 0 },
  ]);
  const seeded: Record<InviteCase, InviteRow> = {
    accepted: { email: targetEmail, usedBy: target, usedAt: now.getTime() - 3 * DAY, revokedAt: null, expiresAt: now.getTime() - 2 * DAY },
    acceptedOldEmail: { email: `old-${target}@example.com`, usedBy: target, usedAt: now.getTime() - 9 * DAY, revokedAt: null, expiresAt: now.getTime() - 8 * DAY },
    pending: { email: targetEmail, usedBy: null, usedAt: null, revokedAt: null, expiresAt: now.getTime() + 2 * DAY },
    expiredPending: { email: targetEmail, usedBy: null, usedAt: null, revokedAt: null, expiresAt: now.getTime() - DAY },
    alreadyRevoked: { email: targetEmail, usedBy: null, usedAt: null, revokedAt: now.getTime() - DAY, expiresAt: now.getTime() + DAY },
    caseVariant: { email: targetEmail.toUpperCase(), usedBy: null, usedAt: null, revokedAt: null, expiresAt: now.getTime() + DAY },
    otherAccepted: { email: otherEmail, usedBy: other, usedAt: now.getTime() - DAY, revokedAt: null, expiresAt: now.getTime() },
    otherPending: { email: `pending-${other}@example.com`, usedBy: null, usedAt: null, revokedAt: null, expiresAt: now.getTime() + DAY },
  };
  const invites = Object.fromEntries(INVITE_CASES.map((c) => [c, id()])) as Record<InviteCase, string>;
  const date = (v: number | null) => (v === null ? null : new Date(v));
  await h.db.insert(h.schema.invites).values(INVITE_CASES.map((c) => ({
    id: invites[c], email: seeded[c].email, tokenHash: id(), role: "member", expiresAt: new Date(seeded[c].expiresAt),
    usedAt: date(seeded[c].usedAt), usedBy: seeded[c].usedBy, createdBy: actor, revokedAt: date(seeded[c].revokedAt),
  })));
  return { actor, actorSession, target, targetEmail, targetSession, other, invites, seeded };
}

/** 관리자 삭제 입력. 라우트(admin/delete.ts)와 같은 감사 action 이다 */
export function inviteAnonDelete(f: InviteAnonFixture, now: Date = INVITE_ANON_NOW): MemberMutation {
  return {
    action: "delete", actorId: f.actor, actorSessionId: f.actorSession, targetId: f.target, now,
    audit: { actorId: f.actor, action: "member.delete", target: f.target, detail: { anonymized: true }, ip: null, now },
  };
}

/** 사례별 초대 행. token_hash 는 넣지 않는다 */
export async function inviteAnonRows(h: DbHandle, f: InviteAnonFixture): Promise<Record<InviteCase, InviteRow>> {
  const t = h.schema.invites;
  const rows = await h.db.select({ id: t.id, email: t.email, usedBy: t.usedBy, usedAt: t.usedAt, revokedAt: t.revokedAt, expiresAt: t.expiresAt })
    .from(t).where(inArray(t.id, Object.values(f.invites))).orderBy(asc(t.id));
  const byId = new Map(rows.map((r: any) => [r.id, { email: r.email, usedBy: r.usedBy, usedAt: ms(r.usedAt), revokedAt: ms(r.revokedAt), expiresAt: ms(r.expiresAt)! }]));
  return Object.fromEntries(INVITE_CASES.map((c) => [c, byId.get(f.invites[c]) ?? null])) as Record<InviteCase, InviteRow>;
}

/** 삭제 뒤 기대 초대 행. 수락 두 건은 email 만, 미사용 두 건은 revoked_at 만 바뀐다 */
export function inviteAnonExpected(f: InviteAnonFixture, now: Date = INVITE_ANON_NOW): Record<InviteCase, InviteRow> {
  const anonymous = `deleted-${f.target}@invalid`;
  return {
    ...f.seeded,
    accepted: { ...f.seeded.accepted, email: anonymous },
    acceptedOldEmail: { ...f.seeded.acceptedOldEmail, email: anonymous },
    pending: { ...f.seeded.pending, revokedAt: now.getTime() },
    expiredPending: { ...f.seeded.expiredPending, revokedAt: now.getTime() },
  };
}

/** 대상 회원·세션·감사 상태. 세션 token 은 넣지 않는다 */
export async function inviteAnonMember(h: DbHandle, f: InviteAnonFixture): Promise<MemberSide> {
  const u = h.schema.user;
  const s = h.schema.session;
  const a = h.schema.auditLog;
  const [target] = await h.db.select({ status: u.status, email: u.email, name: u.name }).from(u).where(eq(u.id, f.target));
  const targetSessions = (await h.db.select({ id: s.id }).from(s).where(eq(s.userId, f.target))).length;
  const actorSessions = (await h.db.select({ id: s.id }).from(s).where(and(eq(s.userId, f.actor), eq(s.id, f.actorSession)))).length;
  const audits = await h.db.select({ actorId: a.actorId, action: a.action, target: a.target }).from(a).where(eq(a.target, f.target)).orderBy(asc(a.id));
  return { target, targetSessions, actorSessions, audits };
}

/** 삭제 전 회원 상태 */
export function inviteAnonMemberBefore(f: InviteAnonFixture): MemberSide {
  return { target: { status: "active", email: f.targetEmail, name: "target" }, targetSessions: 1, actorSessions: 1, audits: [] };
}

/** 삭제 뒤 회원 상태. user 와 수락 초대가 같은 익명값을 쓴다 */
export function inviteAnonMemberAfter(f: InviteAnonFixture): MemberSide {
  return {
    target: { status: "deleted", email: `deleted-${f.target}@invalid`, name: "" },
    targetSessions: 0,
    actorSessions: 1,
    audits: [{ actorId: f.actor, action: "member.delete", target: f.target }],
  };
}
