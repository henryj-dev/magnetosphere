// 키 목표 상태 (계획서 v5.7 5.7, K3.T1). 반영(apply.ts)·작업 큐(queue/handlers.ts)·정합성 점검(reconcile.ts)이 모두 이 함수로
// "OmniRoute 에서 이 키가 켜져 있어야 하는가"를 정한다.
//
//   목표 = 삭제됨  (키 state = deleted 또는 회원 status = deleted)
//        | 꺼짐    (회원 status ≠ active 또는 disabled_reason ∈ {member, admin} 또는 남은 한도 = 0)
//        | 켜짐    (그 밖)
//
// disabled_reason 넷 (5.7)
//   - member 회원이 끔, admin 관리자가 끔: 그 사람이 다시 켜기 전까지 꺼짐이다. 정지 해제·한도 회복으로 켜지지 않는다.
//   - user_status 회원 상태 때문, limit 남은 한도 0 때문: 그 원인이 사라지면 켜짐이다 (Q1).
//   - 그 밖의 값(NULL 포함)으로 state disabled 인 키는 꺼짐으로 본다. 모르는 이유로 꺼진 키를 켜지 않는다 (fail-closed).
// 남은 한도 remaining: null 은 무제한(또는 0 이 아님을 안다). 0 이면 꺼짐.
//   DB 에서 읽을 때(readTarget)는 남은 한도를 다시 계산하지 않는다. 1분 분배(limits/rebalance.ts)가 남은 한도 0 인 회원의 키를
//   disabled_reason limit 으로 적어 두므로, limit 으로 꺼진 키는 0, 나머지는 null 로 넣는다. 그래서 limit 키를 다시 켜는 것은
//   남은 한도를 실제로 계산하는 분배뿐이고, 반영·큐·점검은 limit 키를 켜지 않는다 (예산을 먼저 거는 쪽이 분배다, 5.3).
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbHandle } from "@magnetosphere/runtime/types";

export type KeyTarget = "on" | "off" | "deleted";

export const DISABLED_REASONS = ["member", "admin", "user_status", "limit"] as const;
export type DisabledReason = (typeof DISABLED_REASONS)[number];

export interface TargetInput {
  /** api_keys.state: active | disabled | deleted */
  keyState: string;
  /** api_keys.disabled_reason */
  disabledReason: string | null;
  /** user.status: pending | active | suspended | deleted */
  userStatus: string;
  /** 회원 남은 한도 (USD). null 은 무제한 */
  remaining: number | null;
}

/** 원인이 사라지면 다시 켜지는 꺼짐 이유 */
const RECOVERABLE = new Set<string>(["user_status", "limit"]);

export function targetState(i: TargetInput): KeyTarget {
  if (i.keyState === "deleted" || i.userStatus === "deleted") return "deleted";
  if (i.userStatus !== "active") return "off";
  if (i.remaining !== null && !(i.remaining > 0)) return "off";
  if (i.keyState === "active") return i.disabledReason === "member" || i.disabledReason === "admin" ? "off" : "on";
  if (i.keyState === "disabled") return i.disabledReason !== null && RECOVERABLE.has(i.disabledReason) ? "on" : "off";
  // 모르는 state 는 켜지 않는다
  return "off";
}

/** DB 에 적힌 값만으로 넣는 남은 한도: limit 으로 꺼진 키는 0, 나머지는 null (위 머리 주석) */
export const storedRemaining = (keyState: string, disabledReason: string | null): number | null => (keyState === "disabled" && disabledReason === "limit" ? 0 : null);

export interface KeyTargetRow {
  keyId: string;
  userId: string;
  omnirouteKeyId: string;
  keyState: string;
  disabledReason: string | null;
  syncState: string;
  userStatus: string;
  monthlyLimitUsd: number | null;
  budgetUsd: number | null;
  budgetMonth: string | null;
  budgetAt: Date | null;
  /** 같은 키에 아직 안 끝난 key.delete 가 있다 (delete 가 이긴다: 켜지 않는다) */
  deletePending: boolean;
  target: KeyTarget;
}

/** api_keys.id 하나의 지금 값과 목표. 키 행이 없으면 null */
export async function readTarget(h: DbHandle, keyId: string): Promise<KeyTargetRow | null> {
  const k = h.schema.apiKeys;
  const u = h.schema.user;
  const j = h.schema.omnirouteJobs;
  const [row] = await h.db
    .select({
      keyId: k.id,
      userId: k.userId,
      omnirouteKeyId: k.omnirouteKeyId,
      keyState: k.state,
      disabledReason: k.disabledReason,
      syncState: k.syncState,
      userStatus: u.status,
      monthlyLimitUsd: u.monthlyLimitUsd,
      budgetUsd: k.budgetUsd,
      budgetMonth: k.budgetMonth,
      budgetAt: k.budgetAt,
    })
    .from(k)
    .innerJoin(u, eq(u.id, k.userId))
    .where(eq(k.id, keyId));
  if (!row) return null;
  const del = await h.db
    .select({ one: sql`1` })
    .from(j)
    .where(and(eq(j.keyId, keyId), eq(j.action, "key.delete"), isNull(j.doneAt), isNull(j.failedAt)))
    .limit(1);
  const disabledReason = row.disabledReason ?? null;
  return {
    keyId: row.keyId,
    userId: row.userId,
    omnirouteKeyId: row.omnirouteKeyId,
    keyState: row.keyState,
    disabledReason,
    syncState: row.syncState,
    userStatus: row.userStatus,
    monthlyLimitUsd: row.monthlyLimitUsd == null ? null : Number(row.monthlyLimitUsd),
    budgetUsd: row.budgetUsd == null ? null : Number(row.budgetUsd),
    budgetMonth: row.budgetMonth ?? null,
    budgetAt: row.budgetAt ?? null,
    deletePending: del.length > 0,
    target: targetState({ keyState: row.keyState, disabledReason, userStatus: row.userStatus, remaining: storedRemaining(row.keyState, disabledReason) }),
  };
}
