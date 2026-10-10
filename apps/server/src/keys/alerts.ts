// 키 관리자 알림 (계획서 v5.7 5.7 Q6: audit_log action alert.<종류>). 반영·정합성 점검이 같이 쓴다.
// 같은 종류·같은 키(OmniRoute 키 id)는 하루(UTC) 한 번만 남긴다 — 5분 점검·1분 분배가 같은 알림을 쌓지 않게.
// 찾은 자리에서 바로 쓴다. 끝에 몰아 쓰면 그 전에 실행이 끊겼을 때 키는 꺼졌는데 알림이 없다 (K3 리뷰 #2).
// 두 실행이 같은 알림을 동시에 쓰면 드물게 두 행이 남는다. 알림이 빠지는 것보다 낫다.
import { LeaseLostError, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { dayKey } from "../limits/month.ts";
import { holds, readSetting, writeSetting } from "../limits/store.ts";

/** 오늘 남긴 키 알림 { day, keys: ["종류|OmniRoute 키 id"] } */
export const ALERTED_KEY = "key_alerts";

export type KeyAlertKind = "unknown_m_key" | "manage_scope_key" | "key_missing" | "key_stuck";

/** 오늘 처음이면 audit_log 에 한 행을 쓰고 true. 임대를 잃었으면 LeaseLostError */
export async function alertOnce(h: DbHandle, lease: Lease | undefined, kind: KeyAlertKind, target: string, detail: Record<string, unknown>, now: Date): Promise<boolean> {
  const day = dayKey(now);
  const id = `${kind}|${target}`;
  const seen = await readSetting<{ day: string; keys: string[] }>(h, ALERTED_KEY);
  const keys = seen?.day === day ? seen.keys : [];
  if (keys.includes(id)) return false;
  if (lease && !(await holds(h, lease))) throw new LeaseLostError(lease);
  await h.db.insert(h.schema.auditLog).values({
    id: crypto.randomUUID(),
    actorId: null,
    action: `alert.${kind}`,
    target,
    detail: JSON.stringify(detail),
    ip: null,
    createdAt: now,
  });
  await writeSetting(h, ALERTED_KEY, { day, keys: [...keys, id] }, now, lease);
  return true;
}
