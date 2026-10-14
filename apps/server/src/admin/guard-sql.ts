// M4 Red 뼈대: 형태만 둔다. 구현은 다음 커밋이다.
import type { SQL } from "drizzle-orm";
import type { SelfDeleteCredentialProof } from "@magnetosphere/auth";
import type { DbHandle } from "@magnetosphere/runtime/types";
import type { AuditEntry } from "../audit/index.ts";
import type { MemberAction, MemberStatus, Role, TransitionTo } from "../members/transition.ts";

export const AUTH_VERSION_MAX = 2_147_483_647;
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

export interface MemberSelfProof {
  authVersion: number;
  accountId: string;
  passwordHash: string;
  observedSessionFingerprint: string | null;
}

export function memberSelfProof(_proof: SelfDeleteCredentialProof): MemberSelfProof {
  throw new Error("M4 미구현");
}

export interface MemberMutation {
  action: MemberAction;
  actorId: string;
  actorSessionId: string;
  targetId: string;
  role?: Role;
  selfProof?: MemberSelfProof;
  audit: AuditEntry;
  now: Date;
}

export interface MemberMutationResult {
  to: TransitionTo;
  from: MemberSnapshot;
  authVersion: number | null;
}

export async function ensureMemberMutex(_h: DbHandle): Promise<void> {
  throw new Error("M4 미구현");
}

export function guardedAuditStatement(_h: DbHandle, _e: AuditEntry): any {
  throw new Error("M4 미구현");
}

export async function mutateMember(_h: DbHandle, _input: MemberMutation): Promise<MemberMutationResult> {
  throw new Error("M4 미구현");
}

export async function memberCleanupStatements(_h: DbHandle, _db: any, _userId: string, _previousEmail: string | null, _action: MemberAction = "reject"): Promise<void> {
  throw new Error("M4 미구현");
}

export function memberCasCondition(_h: DbHandle, _input: MemberMutation, _before: MemberSnapshot, _actor: MemberSnapshot, _activeAdmins: number, _to: TransitionTo): SQL | undefined {
  throw new Error("M4 미구현");
}
