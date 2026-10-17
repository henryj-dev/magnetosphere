// 회원 관리 원자 쓰기 (3단계 실행판 M4.T1·T2·T4). 상태·역할 변경과 삭제·자기 탈퇴 모두 이 함수 하나를 지난다.
// 삭제는 user 를 익명화하고 account·session·소유 verification 을 같은 원자 단위에서 정리한다.
// 같은 원자 단위에서 그 회원이 수락한 초대의 email 도 익명값으로 바꾸고, 삭제 전 이메일로 남은 미사용·미철회 초대는 철회한다 (M6 후속 U1).
//
// 직렬화
//   - Node pg·MySQL·MariaDB: 초대 뮤텍스와 다른 job_leases 고정 행(member_management_mutex)을 트랜잭션 밖에서 먼저 만든다.
//     트랜잭션 안 INSERT 는 MySQL 이 공유 잠금을 배타 잠금으로 올리며 교착할 수 있다.
//   - READ COMMITTED 를 명시하고, 트랜잭션의 첫 행 잠금으로 그 뮤텍스를 FOR UPDATE 한다. pg 는 그 앞에 lock_timeout 5s.
//   - 그 다음 actor·target user 행을 id 오름차순으로 FOR UPDATE 한다. credential writer 는 user → account → session 만 잠그고
//     이 뮤텍스를 잡지 않으므로, 회원 관리가 user 보다 뮤텍스를 먼저 잠가도 역순 교착이 생기지 않는다.
//   - SQLite 는 프로세스 안 쓰기 차례와 DB 쓰기 잠금 하나로, D1 은 batch 가 한 번에 실행되어 이미 직렬이다.
//
// 권한·CAS
//   - 잠근 뒤 현재 actor 세션 존재, actor role/status/authVersion, 현재 활성 관리자 수를 다시 읽는다.
//   - 요청자가 잠금 동안 권한을 잃으면 stale actor 401/403이다. 문서의 409 로 바꾸지 않는다.
//   - last_admin 409 는 여전히 권한 있는 actor 가 마지막 활성 관리자를 제거할 때만 쓴다.
//   - role/status/bootstrap/authVersion 을 CAS 조건에 넣고 authVersion 은 1 증가한다. 상한이면 순환하지 않고 실패한다.
//   - 데이터 변경·버전 증가·세션 삭제·감사는 한 원자 단위다. CAS 0행이면 감사도 세션 삭제도 없다.
//
// D1
//   - actor/target/관리자 수 조건을 user UPDATE/DELETE 하나에 묶는다.
//   - 바로 다음 문장은 항상 평가되는 audit INSERT 이고, action 에 CASE WHEN changes() = 1 THEN 검증 action ELSE NULL END 를 넣는다.
//   - 0행이면 NOT NULL 제약으로 batch 전체가 롤백된다. 거절로 target 이 사라져도 guard 는 user 존재에 기대지 않는다.
//   - 순서는 CAS → 즉시 감사 guard → account/verification/초대/session 정리다. 그 사이에 다른 쓰기를 넣지 않는다.
import { and, asc, count, eq, getTableName, gt, inArray, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import type { SelfDeleteCredentialProof } from "@magnetosphere/auth";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { auditRow, type AuditEntry } from "../audit/index.ts";
import { transition, type MemberAction, type MemberStatus, type Role, type TransitionTo } from "../members/transition.ts";
import { revokeSessionsStatement } from "../sessions/revoke.ts";

/** 회원별 인증 버전 상한. 0005 의 integer 칼럼과 맞추며, 이 값에서는 +1 이 순환하지 않게 실패한다 */
export const AUTH_VERSION_MAX = 2_147_483_647;

/**
 * 회원 관리 전용 뮤텍스. 초대 뮤텍스와 공유하지 않는다. locked_until 은 2999년이라 주기 작업 임대가 가져가지 못한다.
 * fence 는 인증 버전으로 재사용하지 않고 0으로 고정한다.
 */
export const MEMBER_MUTEX = { name: "member_management_mutex", holder: "member-management", lockedUntil: new Date("2999-12-31T00:00:00.000Z") } as const;

export const MEMBER_TX = { isolationLevel: "read committed" } as const;
export const MEMBER_PG_LOCK_TIMEOUT = "5s";

export type MemberConflict = "unauthorized" | "forbidden" | "not_found" | "invalid_transition" | "invalid_role" | "bootstrap_admin" | "self" | "last_admin" | "stale_member" | "version_exhausted";

export class MemberConflictError extends Error {
  readonly code: MemberConflict;
  constructor(code: MemberConflict) {
    super(code);
    this.name = "MemberConflictError";
    this.code = code;
  }
}

export interface MemberSnapshot {
  id: string;
  role: string;
  status: MemberStatus;
  isBootstrapAdmin: boolean;
  authVersion: number;
  email: string | null;
}

/** self-delete 가 트랜잭션 밖에서 받은 credential proof. 원문 비밀번호와 현재 HMAC 은 여기 남지 않는다 */
export interface MemberSelfProof {
  authVersion: number;
  accountId: string;
  passwordHash: string;
  /** DB 에 저장된 session fingerprint. NULL 을 currentCredentialFingerprint 로 바꾸지 않는다 */
  observedSessionFingerprint: string | null;
}

/** auth proof 를 삭제 CAS 입력으로 좁힌다. 현재 HMAC 은 세션 조건에 들어가지 않는다 */
export function memberSelfProof(proof: SelfDeleteCredentialProof): MemberSelfProof {
  return { authVersion: proof.authVersion, accountId: proof.accountId, passwordHash: proof.passwordHash, observedSessionFingerprint: proof.observedSessionFingerprint };
}

export interface MemberMutation {
  action: MemberAction;
  actorId: string;
  /** 라우트가 관찰한 현재 세션 id. 잠금 중 그 세션이 사라졌으면 stale actor 다 */
  actorSessionId: string;
  targetId: string;
  role?: Role;
  /** actor·target 이 같고 action 이 delete 일 때만 쓴다. 일반 회원은 이 proof 와 현재 세션 CAS 로 권한을 확인한다 */
  selfProof?: MemberSelfProof;
  audit: AuditEntry;
  now: Date;
}

export interface MemberMutationResult {
  to: TransitionTo;
  from: MemberSnapshot;
  authVersion: number | null;
}

const STATUSES: readonly MemberStatus[] = ["pending", "active", "suspended", "deleted"];
const isStatus = (v: unknown): v is MemberStatus => STATUSES.includes(v as MemberStatus);

/** 생성 칼럼이 있으면 그대로 쓰고, 없으면 dialect 가 인용하는 한정 식별자를 쓴다. 생성 스키마 자체는 바꾸지 않는다 */
function authVersion(table: any) {
  return table.authVersion ?? sql`${sql.identifier(getTableName(table))}.${sql.identifier("auth_version")}`;
}

/** DB 가 준 버전이 0..상한 안 정수가 아니면 손상된 행이다. 상한 도달(version_exhausted)과 구분해 stale_member 로 거절한다 (M6 후속 L4) */
function versionOf(row: { authVersion?: unknown }): number {
  const value = Number(row.authVersion ?? 0);
  if (!Number.isSafeInteger(value) || value < 0 || value > AUTH_VERSION_MAX) throw new MemberConflictError("stale_member");
  return value;
}

function snapshot(row: any): MemberSnapshot {
  if (!isStatus(row.status)) throw new MemberConflictError("stale_member");
  return { id: row.id, role: row.role, status: row.status, isBootstrapAdmin: row.isBootstrapAdmin === true || row.isBootstrapAdmin === 1, authVersion: versionOf(row), email: row.email ?? null };
}

/** 뮤텍스 행을 트랜잭션 밖에 만든다. 이미 있으면 아무것도 하지 않는다 */
export async function ensureMemberMutex(h: DbHandle): Promise<void> {
  const t = h.schema.jobLeases;
  const row = { name: MEMBER_MUTEX.name, holder: MEMBER_MUTEX.holder, lockedUntil: MEMBER_MUTEX.lockedUntil, fence: 0 };
  if (h.provider === "mysql") await h.db.insert(t).ignore().values(row);
  else await h.db.insert(t).values(row).onConflictDoNothing();
}

async function lockMemberMutex(h: DbHandle, tx: any): Promise<void> {
  const t = h.schema.jobLeases;
  if (h.provider === "pg") await tx.execute(sql.raw(`set local lock_timeout = '${MEMBER_PG_LOCK_TIMEOUT}'`));
  const got = await tx.select({ name: t.name }).from(t).where(eq(t.name, MEMBER_MUTEX.name)).for("update");
  if (got.length !== 1) throw new Error("회원 관리 뮤텍스 행이 없다");
}

/** actor·target 을 id 순서로 잠그고 잠근 값을 읽는다. SQLite 는 잠금 절 없이 같은 순서로 읽는다 */
async function lockUsers(h: DbHandle, tx: any, ids: readonly string[]): Promise<Map<string, MemberSnapshot>> {
  const u = h.schema.user;
  const ordered = [...new Set(ids)].sort();
  const query = tx
    .select({ id: u.id, role: u.role, status: u.status, isBootstrapAdmin: u.isBootstrapAdmin, authVersion: authVersion(u), email: u.email })
    .from(u)
    .where(inArray(u.id, ordered))
    .orderBy(asc(u.id));
  const rows = h.provider === "sqlite" || h.kind === "d1" ? await query : await query.for("update");
  return new Map(rows.map((row: any) => [row.id, snapshot(row)]));
}

/**
 * 현재 활성 관리자 수. MySQL 은 잠글 표 자신을 서브쿼리에서 다시 읽지 못하므로(1093), 기본 키를 잠가 고른 뒤 그 개수를 센다.
 * 갭 잠금 대신 이미 잠근 PK 행만 센다.
 */
async function countActiveAdmins(h: DbHandle, tx: any): Promise<number> {
  const u = h.schema.user;
  const cond = and(eq(u.role, "admin"), eq(u.status, "active"));
  if (h.provider === "mysql") {
    const ids = (await tx.select({ id: u.id }).from(u).where(cond).for("update")).map((row: { id: string }) => row.id);
    return ids.length;
  }
  const [row] = await tx.select({ n: count() }).from(u).where(cond);
  return Number(row?.n ?? 0);
}

function selfProofOf(input: MemberMutation): MemberSelfProof | undefined {
  const proof = input.selfProof;
  if (!proof) return undefined;
  if (input.action !== "delete" || input.actorId !== input.targetId) throw new MemberConflictError("forbidden");
  if (!Number.isSafeInteger(proof.authVersion) || proof.authVersion < 0 || proof.authVersion > AUTH_VERSION_MAX) throw new MemberConflictError("stale_member");
  if (!proof.accountId || !proof.passwordHash) throw new MemberConflictError("forbidden");
  return proof;
}

async function requireActor(h: DbHandle, tx: any, input: MemberMutation, actor: MemberSnapshot | undefined): Promise<void> {
  const proof = selfProofOf(input);
  if (!proof && (!actor || actor.role !== "admin" || actor.status !== "active")) throw new MemberConflictError(actor ? "forbidden" : "unauthorized");
  if (proof && (!actor || actor.status !== "active" || actor.authVersion !== proof.authVersion)) throw new MemberConflictError(actor ? "stale_member" : "unauthorized");
  const s = h.schema.session;
  const [session] = await tx
    .select({ id: s.id, authVersion: authVersion(s), credentialFingerprint: s.credentialFingerprint })
    .from(s)
    .where(and(eq(s.id, input.actorSessionId), eq(s.userId, actor!.id), gt(s.expiresAt, input.now)));
  if (!session) throw new MemberConflictError("unauthorized");
  if (versionOf(session) !== actor!.authVersion) throw new MemberConflictError("forbidden");
  if (proof && (session.credentialFingerprint ?? null) !== proof.observedSessionFingerprint) throw new MemberConflictError("stale_member");
}

function removesActiveAdmin(before: MemberSnapshot, action: MemberAction, role: Role | undefined, to: TransitionTo): boolean {
  return before.role === "admin" && before.status === "active" && (action === "suspend" || action === "delete" || to === "row_deleted" || (action === "role" && role !== "admin"));
}

function sameObserved(u: any, row: MemberSnapshot): SQL | undefined {
  return and(eq(u.id, row.id), eq(u.role, row.role), eq(u.status, row.status), eq(u.isBootstrapAdmin, row.isBootstrapAdmin), sql`${authVersion(u)} = ${row.authVersion}`, sql`${authVersion(u)} < ${AUTH_VERSION_MAX}`);
}

async function changed(h: DbHandle, statement: any, key: any): Promise<number> {
  if (h.provider === "mysql") return (await statement)[0].affectedRows;
  return (await statement.returning({ k: key })).length;
}

/**
 * 회원 소유 verification 만 지운다. 다른 회원 토큰은 value 가 우연히 같아도 지우지 않는다.
 * reset 은 identifier 가 reset-password:<token> 이고 value 가 user id 다.
 * 메일 인증 JWT 는 소유 키가 없어 삭제 전 이메일과 정확히 같은 identifier 만 지운다.
 */
function ownedVerification(v: any, userId: string, previousEmail: string | null): SQL | undefined {
  const owned = or(and(eq(v.value, userId), like(v.identifier, "reset-password:%")), and(eq(v.identifier, userId), like(v.value, "signup-dispute:%")));
  return previousEmail === null ? owned : or(owned, eq(v.identifier, previousEmail));
}

/** 삭제한 회원의 익명 이메일. user 와 그 회원이 수락한 초대에 같은 값을 쓴다 (0006 소급도 같은 꼴) */
const anonymousEmail = (userId: string) => `deleted-${userId}@invalid`;

/**
 * 삭제 때 바꿀 초대 조건 둘. used_by 는 남기고 email 만 지운다.
 *   - accepted: 그 회원이 수락한 초대(used_by = id). email 을 익명값으로 바꾼다.
 *   - pending: 삭제 전 이메일로 보낸 미사용·미철회 초대. 관리자 취소와 같이 revoked_at 만 채운다 (만료 여부와 관계없이).
 * 초대 이메일은 normalizeInviteEmail(trim·소문자·NFC)로 저장되므로 원래 값과 그 정규화 값을 함께 본다.
 * MySQL 의 email 기본 정렬은 대소문자를 무시하므로 초대 재발급과 같이 바이트로 비교한다.
 */
function inviteCleanup(h: DbHandle, userId: string, previousEmail: string | null) {
  const t = h.schema.invites;
  const accepted = and(eq(t.usedBy, userId), isNotNull(t.email));
  const emails = previousEmail === null ? [] : [...new Set([previousEmail, previousEmail.trim().toLowerCase().normalize("NFC")])];
  const sameEmail = or(...emails.map((e) => (h.provider === "mysql" ? sql`${t.email} = cast(${e} as binary)` : eq(t.email, e))));
  const pending = emails.length === 0 ? undefined : and(sameEmail, isNull(t.usedAt), isNull(t.revokedAt));
  return { accepted, pending };
}

/** D1 batch 용 초대 UPDATE 문장. 실행하지 않는다 */
function inviteCleanupStatements(h: DbHandle, db: any, userId: string, previousEmail: string | null, now: Date): any[] {
  const t = h.schema.invites;
  const c = inviteCleanup(h, userId, previousEmail);
  return [...(c.pending ? [db.update(t).set({ revokedAt: now }).where(c.pending)] : []), db.update(t).set({ email: anonymousEmail(userId) }).where(c.accepted)];
}

/**
 * Node 트랜잭션 안 초대 정리. MySQL 은 초대 취소(admin.ts revokeWhere)와 같이 잠그지 않는 읽기로 id 를 고르고
 * id 마다 같은 조건으로 UPDATE 한다. email·used_by 에는 인덱스가 없어 조건 UPDATE 가 표 전체를 잠그지 않게 한다.
 */
async function cleanupInvites(h: DbHandle, db: any, userId: string, previousEmail: string | null, now: Date): Promise<void> {
  if (h.provider !== "mysql") {
    for (const statement of inviteCleanupStatements(h, db, userId, previousEmail, now)) await statement;
    return;
  }
  const t = h.schema.invites;
  const c = inviteCleanup(h, userId, previousEmail);
  const writes: [SQL | undefined, Record<string, unknown>][] = [[c.pending, { revokedAt: now }], [c.accepted, { email: anonymousEmail(userId) }]];
  for (const [cond, set] of writes) {
    if (!cond) continue;
    const ids: string[] = (await db.select({ id: t.id }).from(t).where(cond)).map((r: { id: string }) => r.id);
    for (const id of ids) await db.update(t).set(set).where(and(eq(t.id, id), cond));
  }
}

async function cleanupOwned(h: DbHandle, db: any, userId: string, previousEmail: string | null, action: MemberAction = "reject", now: Date = new Date()): Promise<void> {
  const a = h.schema.account;
  const v = h.schema.verification;
  if (action === "reject" || action === "delete") await db.delete(a).where(eq(a.userId, userId));
  await db.delete(v).where(ownedVerification(v, userId, previousEmail));
  if (action === "delete") await cleanupInvites(h, db, userId, previousEmail, now);
  await revokeSessionsStatement(h, db, userId);
}

/**
 * D1 의 항상 평가되는 감사 guard. 앞선 CAS 가 1행일 때만 검증된 action 을 넣고, 아니면 NULL 로 NOT NULL 제약이 batch 를 되돌린다.
 * id 는 미리 만든 값이라 changes() 와 무관하게 평가되고, 이미 auditRow 를 통과한 값만 SQL 매개변수로 들어간다.
 */
export function guardedAuditStatement(h: DbHandle, e: AuditEntry) {
  const a = h.schema.auditLog;
  const row = auditRow(e);
  return h.db.insert(a).values({ ...row, action: sql`CASE WHEN changes() = 1 THEN ${row.action} ELSE NULL END` });
}

function credentialGuard(h: DbHandle, input: MemberMutation, targetId: string): SQL | undefined {
  const proof = selfProofOf(input);
  if (!proof) return undefined;
  const a = h.schema.account;
  const sameHash = h.provider === "mysql" ? sql`binary ${a.password} = binary ${proof.passwordHash}` : eq(a.password, proof.passwordHash);
  return sql`exists (select 1 from ${a} where ${and(eq(a.id, proof.accountId), eq(a.userId, targetId), eq(a.providerId, "credential"), eq(a.accountId, targetId), sameHash)})`;
}

function mutationStatements(h: DbHandle, db: any, input: MemberMutation, before: MemberSnapshot, actor: MemberSnapshot, activeAdmins: number, to: TransitionTo) {
  const u = h.schema.user;
  const proof = selfProofOf(input);
  const removesLast = removesActiveAdmin(before, input.action, input.role, to) && activeAdmins <= 1;
  // Node 는 mutex → user 잠금 뒤 countActiveAdmins 결과로 mutateLocked 에서 판정한다.
  // MySQL/MariaDB CAS 에 같은 표의 병합 가능한 count subquery 를 넣어 1093 을 만들지 않는다.
  // PG 도 mutex/READ COMMITTED, SQLite 는 직렬 쓰기 transaction 이 그 판정을 CAS 까지 보호한다.
  // D1 의 사전 읽기는 잠금이 아니므로 실제 단일 CAS 안의 현재 count guard 를 반드시 유지한다.
  const adminGuard = h.kind === "d1" && removesActiveAdmin(before, input.action, input.role, to)
    ? sql`(select count(*) from ${u} where ${and(eq(u.role, "admin"), eq(u.status, "active"))}) > 1`
    : undefined;
  // 별도 조회여야 actor != target 에서 대상 id 조건과 충돌하지 않는다. LIMIT 은 MySQL 의 derived-table 병합(1093)을 막는다.
  // 자기 작업에서도 이 조건을 생략하지 않는다. 관찰한 대상 role/status 만으로 현재 관리자 권한을 대신하지 않는다.
  // 일반 회원 자기 탈퇴는 admin role 을 요구하지 않고, proof 의 현재 버전·credential·세션 지문을 조건으로 한다.
  const actorMatch = proof
    ? and(eq(u.id, actor.id), eq(u.status, "active"), sql`${authVersion(u)} = ${proof.authVersion}`)
    : and(eq(u.id, actor.id), eq(u.role, "admin"), eq(u.status, "active"), sql`${authVersion(u)} = ${actor.authVersion}`);
  const actorGuard = sql`exists (select 1 from (select ${u.id} from ${u} where ${actorMatch} limit 1) as member_actor)`;
  const sessionFingerprint = proof ? (proof.observedSessionFingerprint === null ? isNull(h.schema.session.credentialFingerprint) : eq(h.schema.session.credentialFingerprint, proof.observedSessionFingerprint)) : undefined;
  const sessionGuard = sql`exists (select 1 from ${h.schema.session} where ${and(eq(h.schema.session.id, input.actorSessionId), eq(h.schema.session.userId, actor.id), gt(h.schema.session.expiresAt, input.now), sql`${authVersion(h.schema.session)} = ${actor.authVersion}`, sessionFingerprint)})`;
  const cond = and(sameObserved(u, before), actorGuard, sessionGuard, credentialGuard(h, input, before.id), adminGuard);
  if (to === "row_deleted") return { removesLast, cas: db.delete(u).where(cond), cleanup: true };
  const nextVersion = before.authVersion + 1;
  const set = input.action === "delete"
    ? { status: "deleted", deletedAt: input.now, email: anonymousEmail(before.id), name: "", image: null, authVersion: nextVersion, updatedAt: input.now }
    : { status: to, role: input.action === "role" ? input.role : before.role, authVersion: nextVersion, updatedAt: input.now };
  return { removesLast, cas: db.update(u).set(set).where(cond), cleanup: input.action === "delete", nextVersion };
}

async function rejectIfStale(h: DbHandle, input: MemberMutation, before: MemberSnapshot, code: MemberConflict, db: any = h.db): Promise<never> {
  const u = h.schema.user;
  const [actor] = await db.select({ id: u.id, role: u.role, status: u.status, isBootstrapAdmin: u.isBootstrapAdmin, authVersion: authVersion(u), email: u.email }).from(u).where(eq(u.id, input.actorId));
  await requireActor(h, db, input, actor ? snapshot(actor) : undefined);
  const [current] = await db.select({ id: u.id, role: u.role, status: u.status, isBootstrapAdmin: u.isBootstrapAdmin, authVersion: authVersion(u) }).from(u).where(eq(u.id, before.id));
  if (!current || current.role !== before.role || current.status !== before.status || Boolean(current.isBootstrapAdmin) !== before.isBootstrapAdmin) throw new MemberConflictError("stale_member");
  if (versionOf(current) >= AUTH_VERSION_MAX) throw new MemberConflictError("version_exhausted");
  if (versionOf(current) !== before.authVersion) throw new MemberConflictError("stale_member");
  if (code === "last_admin" || code === "version_exhausted") throw new MemberConflictError(code);
  if (before.role === "admin" && before.status === "active" && (input.action === "suspend" || input.action === "delete" || (input.action === "role" && input.role !== "admin")) && await countActiveAdmins(h, db) <= 1) throw new MemberConflictError("last_admin");
  throw new MemberConflictError("stale_member");
}

async function mutateLocked(h: DbHandle, tx: any, input: MemberMutation): Promise<MemberMutationResult> {
  const locked = await lockUsers(h, tx, [input.actorId, input.targetId]);
  const actor = locked.get(input.actorId);
  const before = locked.get(input.targetId);
  await requireActor(h, tx, input, actor);
  if (!before || !actor) throw new MemberConflictError("not_found");
  const judged = transition({ from: before.status, action: input.action, target: before, actor: { id: actor.id }, role: input.role });
  if (!judged.ok) throw new MemberConflictError(judged.code);
  if (before.authVersion >= AUTH_VERSION_MAX) throw new MemberConflictError("version_exhausted");
  const activeAdmins = await countActiveAdmins(h, tx);
  if (removesActiveAdmin(before, input.action, input.role, judged.to) && activeAdmins <= 1) throw new MemberConflictError("last_admin");
  const plan = mutationStatements(h, tx, input, before, actor, activeAdmins, judged.to);
  if ((await changed(h, plan.cas, h.schema.user.id)) !== 1) return rejectIfStale(h, input, before, plan.removesLast ? "last_admin" : "stale_member", tx);
  const { auditStatement } = await import("../audit/index.ts");
  await auditStatement(h, input.audit, tx);
  if (plan.cleanup) await cleanupOwned(h, tx, before.id, before.email, input.action, input.now);
  else await revokeSessionsStatement(h, tx, before.id);
  return { to: judged.to, from: before, authVersion: plan.cleanup ? null : (plan.nextVersion ?? null) };
}

/**
 * 회원 관리 쓰기 하나. T1 의 모든 writer 와 후속 삭제·자기 탈퇴가 이 primitive 에 참여한다.
 * D1 은 단일 조건부 문장과 즉시 감사 guard 를 쓰고, Node 는 뮤텍스 트랜잭션을 쓴다.
 * 알려진 충돌은 현재 상태를 다시 읽어 stale/last_admin 만 구분한다. 원인 SQL 은 외부로 전달하지 않는다.
 */
export async function mutateMember(h: DbHandle, input: MemberMutation): Promise<MemberMutationResult> {
  // Drizzle 는 생성 스키마에 없는 set 필드를 버릴 수 있다. version 증가 없는 상태 쓰기를 허용하지 않는다.
  if (!h.schema.user.authVersion || !h.schema.session.authVersion) throw new Error("회원 관리 authVersion 생성 스키마가 준비되지 않았다");
  if (h.kind === "d1") {
    const locked = await lockUsers(h, h.db, [input.actorId, input.targetId]);
    const actor = locked.get(input.actorId);
    const before = locked.get(input.targetId);
    await requireActor(h, h.db, input, actor);
    if (!before || !actor) throw new MemberConflictError("not_found");
    const judged = transition({ from: before.status, action: input.action, target: before, actor: { id: actor.id }, role: input.role });
    if (!judged.ok) throw new MemberConflictError(judged.code);
    if (before.authVersion >= AUTH_VERSION_MAX) throw new MemberConflictError("version_exhausted");
    const activeAdmins = await countActiveAdmins(h, h.db);
    if (removesActiveAdmin(before, input.action, input.role, judged.to) && activeAdmins <= 1) throw new MemberConflictError("last_admin");
    const plan = mutationStatements(h, h.db, input, before, actor, activeAdmins, judged.to);
    const statements = [plan.cas, guardedAuditStatement(h, input.audit)];
    if (plan.cleanup && (input.action === "reject" || input.action === "delete")) statements.push(h.db.delete(h.schema.account).where(eq(h.schema.account.userId, before.id)));
    if (plan.cleanup) statements.push(h.db.delete(h.schema.verification).where(ownedVerification(h.schema.verification, before.id, before.email)));
    // 초대 정리도 같은 batch 다. 감사 guard 뒤에 두므로 CAS 0행이면 이 UPDATE 들도 함께 되돌려진다
    if (plan.cleanup && input.action === "delete") statements.push(...inviteCleanupStatements(h, h.db, before.id, before.email, input.now));
    statements.push(revokeSessionsStatement(h, h.db, before.id));
    try {
      await h.db.batch(statements);
    } catch (e) {
      const messages: string[] = [];
      for (let cause: any = e, depth = 0; cause && depth < 8; cause = cause.cause, depth++) messages.push(String(cause.message ?? ""));
      if (/NOT NULL constraint failed: audit_log\.action/.test(messages.join(" "))) return rejectIfStale(h, input, before, plan.removesLast ? "last_admin" : "stale_member");
      throw new MemberConflictError("stale_member");
    }
    return { to: judged.to, from: before, authVersion: plan.cleanup ? null : (plan.nextVersion ?? null) };
  }
  const locking = h.provider !== "sqlite";
  if (locking) await ensureMemberMutex(h);
  const body = async (tx: any) => {
    if (locking) await lockMemberMutex(h, tx);
    return mutateLocked(h, tx, input);
  };
  return locking ? h.db.transaction(body, MEMBER_TX) : h.db.transaction(body);
}

/** 후속 삭제 구현이 계정·검증·(삭제면) 초대·세션 정리 순서만 재사용할 수 있게 연다. user 익명화 쓰기는 여기 없다 */
export const memberCleanupStatements = cleanupOwned;

/** 자기 자신 조건과 빈 세션 조건이 SQL 에서 빠지지 않는지 시험이 확인하는 내부 조건 */
export function memberCasCondition(h: DbHandle, input: MemberMutation, before: MemberSnapshot, actor: MemberSnapshot, activeAdmins: number, to: TransitionTo): SQL | undefined {
  return mutationStatements(h, h.db, input, before, actor, activeAdmins, to).cas.config.where;
}
