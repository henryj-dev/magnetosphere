// 관리자 세션의 MFA 충족 판정과 세션 승격 문장 (A1 설계 2·4·6절).
// 충족 조건: mfa_verified_at 이 있다 ∧ mfa_factor_id 가 지금 active factor 다 ∧ mfa_policy_version 이 지금 정책 해시다 ∧
//           세션이 만료 전이고 세션 auth_version 이 회원 auth_version 과 같다. 정책이 unavailable 이면 누구도 충족하지 않는다 (fail-closed).
// Better Auth 의 hooks.before 부분 세션 제한(plugin.ts)과 서버 관리자 가드(apps/server routes/guard.ts)가 같은 판정 함수를 쓴다.
// 세션·회원·active factor 는 한 번의 SELECT 로 함께 읽는다 (사이에 factor 가 바뀌어 두 값이 어긋나지 않게).
import { and, eq, gt, lt, ne, sql } from "drizzle-orm";
import { AUTH_VERSION_MAX } from "@magnetosphere/db/src/schema/common.ts";
import type { MfaPolicyState } from "./policy.ts";
import type { MfaDatabase, MfaMethod, SecretCipher } from "./store.ts";

/** 감사 기록 action (서버 audit 허용 목록과 같은 이름) */
export type MfaAuditAction = "mfa.enroll" | "mfa.recovery_use" | "mfa.recovery_regenerate" | "mfa.reset" | "mfa.grant_issue";

export interface MfaAuditEntry {
  actorId: string | null;
  action: MfaAuditAction;
  target: string | null;
  /** 비밀값(seed·코드·토큰)은 넣지 않는다. 서버 감사 검사가 금지 키를 다시 막는다 */
  detail: Record<string, unknown> | null;
  ip: string | null;
  now: Date;
}

/**
 * 관리자 MFA 런타임 구성. 서버(config.ts)가 배포 설정에서 만든다.
 * policy 가 unavailable 이면 관리자 권한은 늘 거부된다. cipher 는 APP_ENCRYPTION_KEY 로 만든 것, key 는 HMAC 서버 키(32바이트 이상).
 */
export interface MfaRuntime {
  policy: MfaPolicyState;
  cipher: SecretCipher;
  key: string;
  /** otpauth URI 의 발급자 이름 (':' 없음) */
  issuer: string;
  /** 감사 INSERT 문장(실행하지 않는다). 원자 단위 안에 들어간다. 없으면 감사를 남기지 않는다 */
  audit?: (db: any, e: MfaAuditEntry) => any;
  /** 실패 지연 칸의 IP 묶음 (서버 ipBucket: IPv6 는 /64). 없으면 IP 문자열 그대로 */
  ipBucket?: (ip: string | null) => string;
}

export interface AuthContextRow {
  user: { id: string; role: string; status: string; emailVerified: boolean; authVersion: number; deletedAt: Date | null; isBootstrapAdmin: boolean; email: string | null; monthlyLimitUsd: number | null; maxKeys: number | null };
  /** 받은 세션 id 의 행. 없거나 다른 회원 것이면 null */
  session: { id: string; createdAt: Date; expiresAt: Date; authVersion: number; mfaVerifiedAt: Date | null; mfaFactorId: string | null; mfaMethod: string | null; mfaPolicyVersion: string | null } | null;
  /** 지금 active factor id. 없으면 null */
  activeFactorId: string | null;
}

const asDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(v as string | number));
const asBool = (v: unknown) => v === true || v === 1;

/** 회원·(그 회원의) 세션·active factor 를 한 SELECT 로 읽는다. 회원이 없으면 null */
export async function readAuthContext(h: MfaDatabase, o: { userId: string; sessionId: string | null }): Promise<AuthContextRow | null> {
  const s = h.schema as any;
  const u = s.user;
  const se = s.session;
  const f = s.mfaFactor;
  const [row] = await h.db
    .select({
      id: u.id, role: u.role, status: u.status, emailVerified: u.emailVerified, authVersion: u.authVersion, deletedAt: u.deletedAt, isBootstrapAdmin: u.isBootstrapAdmin, email: u.email,
      monthlyLimitUsd: u.monthlyLimitUsd, maxKeys: u.maxKeys,
      sId: se.id, sCreatedAt: se.createdAt, sExpiresAt: se.expiresAt, sAuthVersion: se.authVersion,
      sMfaVerifiedAt: se.mfaVerifiedAt, sMfaFactorId: se.mfaFactorId, sMfaMethod: se.mfaMethod, sMfaPolicyVersion: se.mfaPolicyVersion,
      fId: f.id,
    })
    .from(u)
    .leftJoin(se, and(eq(se.id, o.sessionId ?? ""), eq(se.userId, u.id)))
    .leftJoin(f, eq(f.activeSlot, u.id))
    .where(eq(u.id, o.userId))
    .limit(1);
  if (!row) return null;
  return {
    user: {
      id: row.id, role: row.role, status: row.status, emailVerified: asBool(row.emailVerified), authVersion: Number(row.authVersion), deletedAt: asDate(row.deletedAt),
      isBootstrapAdmin: asBool(row.isBootstrapAdmin), email: row.email ?? null,
      monthlyLimitUsd: row.monthlyLimitUsd == null ? null : Number(row.monthlyLimitUsd), maxKeys: row.maxKeys == null ? null : Number(row.maxKeys),
    },
    session: row.sId
      ? {
          id: row.sId, createdAt: asDate(row.sCreatedAt)!, expiresAt: asDate(row.sExpiresAt)!, authVersion: Number(row.sAuthVersion),
          mfaVerifiedAt: asDate(row.sMfaVerifiedAt), mfaFactorId: row.sMfaFactorId ?? null, mfaMethod: row.sMfaMethod ?? null, mfaPolicyVersion: row.sMfaPolicyVersion ?? null,
        }
      : null,
    activeFactorId: row.fId ?? null,
  };
}

export type MfaJudgement =
  | { state: "satisfied"; method: MfaMethod; verifiedAt: Date; factorId: string; policyVersion: string }
  | { state: "policy_unavailable" }
  /** 세션 행이 없거나 만료됐거나 인증 버전이 다르다. 세션 자체가 무효다 */
  | { state: "invalid_session" }
  | { state: "enrollment_required" }
  | { state: "challenge_required" };

/** 관리자 세션의 MFA 판정. 역할·상태는 호출자가 본다 */
export function judgeMfa(c: AuthContextRow, policy: MfaPolicyState, now: Date): MfaJudgement {
  const s = c.session;
  if (!s || s.expiresAt.getTime() <= now.getTime() || s.authVersion !== c.user.authVersion) return { state: "invalid_session" };
  if (policy.state !== "ready") return { state: "policy_unavailable" };
  const satisfied =
    s.mfaVerifiedAt !== null &&
    s.mfaVerifiedAt.getTime() <= now.getTime() &&
    c.activeFactorId !== null &&
    s.mfaFactorId === c.activeFactorId &&
    s.mfaPolicyVersion === policy.version &&
    (s.mfaMethod === "totp" || s.mfaMethod === "recovery");
  if (satisfied) return { state: "satisfied", method: s.mfaMethod as MfaMethod, verifiedAt: s.mfaVerifiedAt!, factorId: c.activeFactorId!, policyVersion: policy.version };
  return c.activeFactorId === null ? { state: "enrollment_required" } : { state: "challenge_required" };
}

/** 관리자 판정 대상 회원인가: 역할 admin. 상태·인증은 각 가드가 따로 본다 */
export const isAdminRole = (c: AuthContextRow) => c.user.role === "admin";

// ---------- 원자 단위에 넣는 문장 (실행하지 않는다) ----------

/**
 * 세션을 MFA 충족으로 승격한다. 세션 id·회원·인증 버전이 그대로이고 만료 전일 때만 한 행이다.
 * nextAuthVersion 을 주면 세션 버전도 함께 바꾼다 (등록 확인: 회원 버전 +1 뒤 현재 세션을 새 버전에 다시 묶는다).
 */
export function sessionMfaUpdate(
  h: MfaDatabase,
  db: any,
  o: { sessionId: string; userId: string; authVersion: number; nextAuthVersion?: number; factorId: string; method: MfaMethod; policyVersion: string; now: Date },
) {
  const se = (h.schema as any).session;
  return db
    .update(se)
    .set({ mfaVerifiedAt: o.now, mfaFactorId: o.factorId, mfaMethod: o.method, mfaPolicyVersion: o.policyVersion, authVersion: o.nextAuthVersion ?? o.authVersion, updatedAt: o.now })
    .where(and(eq(se.id, o.sessionId), eq(se.userId, o.userId), eq(se.authVersion, o.authVersion), gt(se.expiresAt, o.now)));
}

/** 활성 관리자의 인증 버전 +1 (등록 확인). 버전이 그대로이고 상한 아래일 때만 한 행이다 */
export function adminVersionBump(h: MfaDatabase, db: any, o: { userId: string; authVersion: number; now: Date }) {
  const u = (h.schema as any).user;
  return db
    .update(u)
    .set({ authVersion: sql`${u.authVersion} + 1`, updatedAt: o.now })
    .where(and(eq(u.id, o.userId), eq(u.authVersion, o.authVersion), lt(u.authVersion, AUTH_VERSION_MAX), eq(u.role, "admin"), eq(u.status, "active"), sql`${u.deletedAt} is null`));
}

/** 회원의 다른 세션을 모두 지운다 */
export function otherSessionsDelete(h: MfaDatabase, db: any, o: { userId: string; keepSessionId: string }) {
  const se = (h.schema as any).session;
  return db.delete(se).where(and(eq(se.userId, o.userId), ne(se.id, o.keepSessionId)));
}

/**
 * 회원의 MFA 행을 모두 지운다 (탈퇴 익명화·거절 삭제). 세션을 지우는 문장보다 앞에 둔다 (proof 가 세션을 참조한다).
 * FK cascade 에 기대지 않는다: foreign_keys 가 꺼진 SQLite 연결에서도 남지 않게 한다.
 */
export function mfaRowsDelete(h: MfaDatabase, db: any, userId: string): any[] {
  const s = h.schema as any;
  return [
    db.delete(s.mfaProof).where(eq(s.mfaProof.userId, userId)),
    db.delete(s.mfaRecoveryCode).where(eq(s.mfaRecoveryCode.userId, userId)),
    db.delete(s.mfaEnrollmentGrant).where(eq(s.mfaEnrollmentGrant.userId, userId)),
    db.delete(s.mfaFactor).where(eq(s.mfaFactor.userId, userId)),
  ];
}

/**
 * HMAC 서버 키(grant·proof·복구 코드 해시)를 BETTER_AUTH_SECRET 에서 이름 붙여 갈라 낸다.
 * 세션 서명 등 Better Auth 의 다른 쓰임과 같은 키를 그대로 쓰지 않는다. 결과는 64자 hex (32바이트 이상 조건을 만족한다)
 */
export async function mfaHmacKey(secret: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("magnetosphere:mfa-hmac-key:v1")));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** otpauth URI 의 발급자 이름 */
export const MFA_ISSUER = "Magnetosphere";
