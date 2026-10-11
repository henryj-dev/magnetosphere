// 회원 상태 전이 (3단계 실행판 M1.T2, 계획서 4.5, Q8·Q11·Q12). 순수 함수다. 회원 관리 API(M4)는 이 판정을 먼저 보고,
// 상태 쓰기는 "지금 상태가 판정 때와 같을 때만" 조건부 UPDATE 로 한다 (M4.T1).
//   허용하는 칸 일곱 (Q8):
//     pending   → approve → active
//     pending   → reject  → 행 삭제 (row_deleted). 키·사용 기록이 없어 같은 이메일로 다시 가입할 수 있게 한다
//     active    → suspend → suspended,   suspended → unsuspend → active
//     active·suspended → delete → deleted (되돌릴 수 없다. deleted 에서 나가는 전이는 없다, Q9)
//     active    → role    → active (역할만 바뀐다. member·admin 둘, Q11)
//   보호 (Q12): 최초 관리자(is_bootstrap_admin)는 강등·정지·삭제할 수 없다 (bootstrap_admin).
//     자기 자신은 강등·정지할 수 없다 (self). 다른 관리자 정지는 된다.
//     "마지막 활성 관리자" 판정은 동시 요청을 막아야 해서 DB 문장 안에서 한다 (M4.T1 guard-sql.ts). 이 함수는 보지 않는다.

export const MEMBER_STATUSES = ["pending", "active", "suspended", "deleted"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
export const MEMBER_ACTIONS = ["approve", "reject", "suspend", "unsuspend", "delete", "role"] as const;
export type MemberAction = (typeof MEMBER_ACTIONS)[number];
export const ROLES = ["member", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** 전이 뒤 상태. row_deleted 는 거절로 user 행을 지운다는 뜻이다 (Q8) */
export type TransitionTo = MemberStatus | "row_deleted";
export type TransitionCode = "invalid_transition" | "invalid_role" | "bootstrap_admin" | "self";
export type TransitionResult = { ok: true; to: TransitionTo } | { ok: false; code: TransitionCode };

export interface TransitionInput {
  from: MemberStatus;
  action: MemberAction;
  target: { id: string; role: string; isBootstrapAdmin: boolean };
  actor: { id: string };
  /** action role 의 새 역할 */
  role?: string;
}

/** 상태마다 허용하는 동작과 그 뒤 상태. 여기 없는 칸은 invalid_transition */
const TABLE: Record<MemberStatus, Partial<Record<MemberAction, TransitionTo>>> = {
  pending: { approve: "active", reject: "row_deleted" },
  active: { suspend: "suspended", delete: "deleted", role: "active" },
  suspended: { unsuspend: "active", delete: "deleted" },
  deleted: {},
};

const isRole = (v: unknown): v is Role => (ROLES as readonly unknown[]).includes(v);

export function transition({ from, action, target, actor, role }: TransitionInput): TransitionResult {
  const row = Object.hasOwn(TABLE, from) ? TABLE[from] : {};
  const to = Object.hasOwn(row, action) ? row[action] : undefined;
  if (to === undefined) return { ok: false, code: "invalid_transition" };
  if (action === "role" && !isRole(role)) return { ok: false, code: "invalid_role" };
  const demote = action === "role" && target.role === "admin" && role !== "admin";
  if (target.isBootstrapAdmin && (demote || action === "suspend" || action === "delete")) return { ok: false, code: "bootstrap_admin" };
  if (target.id === actor.id && (demote || action === "suspend")) return { ok: false, code: "self" };
  return { ok: true, to };
}
