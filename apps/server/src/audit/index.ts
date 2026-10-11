// 감사 기록 쓰기 하나 (3단계 실행판 M1.T3, 계획서 5.9, Q17). 3단계 코드(가입·초대·회원 관리·설정)는 이것만 쓴다.
//   - action 은 허용 목록(3단계 열둘)과 2단계가 이미 쓰는 이름만 받는다. 철자가 틀린 action 은 7단계 감사 화면의 거르기에서 빠진다.
//   - detail 은 JSON 객체다. 키 이름이 개인정보·비밀 값(email·name·password·token·*_hash 등)이면 어느 깊이든 던진다.
//     탈퇴로 지운 개인정보(Q9)가 감사 기록에 남지 않게 한다. target 은 회원·초대 id 다.
//   - writeAudit 은 바로 쓰고, auditStatement 는 실행하지 않은 INSERT 문을 돌려준다. 트랜잭션(tx) 안이나 D1 batch 에 넣어
//     상태 쓰기와 감사 기록을 한 번에 남길 때 쓴다. 검사는 문을 만들 때 한다 (잘못된 기록이면 batch 를 보내기 전에 던진다).
// 2단계 자리(admin-limits.ts·limits/*·keys/alerts.ts·queue/index.ts)는 봉인한 시험이 걸려 있어 옮기지 않는다 (실행판 백로그).
import type { DbHandle } from "@magnetosphere/runtime/types";

/** 3단계가 남기는 action (Q17) */
export const AUDIT_ACTIONS = [
  "member.signup",
  "member.approve",
  "member.reject",
  "member.suspend",
  "member.unsuspend",
  "member.role",
  "member.delete",
  "invite.create",
  "invite.revoke",
  "invite.accept",
  "settings.update",
  "alert.signup_cap",
] as const;

/** 2단계 코드가 이미 남기는 action. 같은 표에 섞여 있어 이 함수로 써도 받는다 */
export const PHASE2_AUDIT_ACTIONS = [
  "limits.update",
  "alert.usage_drift",
  "alert.rebalance_stalled",
  "alert.rebalance_failed",
  "alert.job_failed",
  "alert.unknown_m_key",
  "alert.manage_scope_key",
  "alert.key_missing",
  "alert.key_stuck",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number] | (typeof PHASE2_AUDIT_ACTIONS)[number];
const ACTIONS: ReadonlySet<string> = new Set([...AUDIT_ACTIONS, ...PHASE2_AUDIT_ACTIONS]);

export interface AuditEntry {
  /** 한 사람(관리자·회원) id. 시스템이 남기면 null */
  actorId: string | null;
  action: AuditAction;
  /** 회원·초대 id 등. 이메일을 넣지 않는다 */
  target: string | null;
  detail?: Record<string, unknown> | null;
  ip: string | null;
  now: Date;
}

export type AuditErrorCode = "unknown_action" | "invalid_detail" | "forbidden_detail_key";

export class AuditError extends Error {
  readonly code: AuditErrorCode;
  constructor(code: AuditErrorCode, message: string) {
    super(message);
    this.name = "AuditError";
    this.code = code;
  }
}

/** 개인정보·비밀 값 키. 대소문자·_·- 를 지우고 비교한다 (email·e_mail·newEmail, token·sessionToken, token_hash·tokenHash …) */
function forbiddenKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, "");
  return k === "name" || /(email|password|token|hash|secret|apikey)$/.test(k);
}

function checkDetail(v: unknown, path: string): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => checkDetail(x, `${path}[${i}]`));
    return;
  }
  if (v === null || typeof v !== "object") return;
  for (const [k, x] of Object.entries(v)) {
    if (forbiddenKey(k)) throw new AuditError("forbidden_detail_key", `감사 기록 detail 에 넣을 수 없는 키: ${path}.${k}`);
    checkDetail(x, `${path}.${k}`);
  }
}

/** 검사한 audit_log 행 */
function auditRow(e: AuditEntry) {
  if (!ACTIONS.has(e.action)) throw new AuditError("unknown_action", `모르는 감사 action: ${JSON.stringify(e.action)}`);
  const detail = e.detail ?? null;
  if (detail !== null && (typeof detail !== "object" || Array.isArray(detail))) throw new AuditError("invalid_detail", "감사 기록 detail 은 JSON 객체다");
  checkDetail(detail, "detail");
  return {
    id: crypto.randomUUID(),
    actorId: e.actorId,
    action: e.action,
    target: e.target,
    detail: detail === null ? null : JSON.stringify(detail),
    // audit_log.ip 는 varchar(64)
    ip: e.ip === null ? null : e.ip.slice(0, 64),
    createdAt: e.now,
  };
}

/** 실행하지 않은 INSERT 문. db 는 트랜잭션(tx)이나 D1 batch 에 넣을 연결 (기본 h.db) */
export function auditStatement(h: DbHandle, e: AuditEntry, db: any = h.db) {
  return db.insert(h.schema.auditLog).values(auditRow(e));
}

export async function writeAudit(h: DbHandle, e: AuditEntry): Promise<void> {
  await auditStatement(h, e);
}
