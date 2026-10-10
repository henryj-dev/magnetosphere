// 정합성 점검 reconcile (계획서 v5.7 5.7·5.8, K3.T3). jobs.ts 가 "*/5 * * * *" 로 등록한다 (임대·하트비트 아래).
//
// 한 번 실행
//   1. OmniRoute 키 목록(listKeys)을 한 번 읽는다. 못 읽으면 그대로 던진다 — 아무것도 바꾸지 않는다 (fail-closed).
//   2. 키마다 (회원 앱 매핑 api_keys.omniroute_key_id 로 찾는다. 삭제한 키의 행도 매핑이다)
//      - 매핑됐거나 이름이 m_ 인 키의 scopes 에 manage·admin 이 있으면: 끄고 alert.manage_scope_key (5.8).
//        매핑된 키는 disabled_reason admin 으로 적어 다음 점검이 다시 켜지 않게 한다 (관리자가 보고 켠다).
//        write 토큰이 회원 키에 manage 를 붙여 admin 토큰을 만드는 권한 상승(V10)을 잡는 장치는 이것 하나다.
//      - 매핑 없는 m_ 키: alert.unknown_m_key 만. 지우거나 끄지 않는다 (운영자가 만든 키·복구 중인 매핑일 수 있다, Q6).
//      - 이름이 m_ 가 아니고 매핑도 없는 키: 운영자 키다. 보지 않는다.
//      - 매핑된 키: 실제 isActive 를 목표(target.ts)와 비교해 어긋났거나, sync_state 가 synced 가 아니거나(failed 포함, Q3),
//        키 state 가 회원 상태와 맞지 않으면 applyKey (actual = 읽은 isActive). 회원 상태 변화(DB 에서 바꾼 정지·탈퇴)도 여기서
//        반영된다. 목표가 삭제됨인데 OmniRoute 에 남은 키는 끄고 key.delete 를 잡는다(이미 기다리는 작업이 없을 때).
//   3. 알림은 같은 종류·같은 키를 하루(UTC) 한 번만 남긴다 (5분마다 같은 알림이 쌓이지 않게).
// 큐가 스스로 끝까지 맞추지 않고 이 점검에 맡기는 두 경우(K1 메모: key.apply_state 의 다시 읽기 상한, 한 tick 안에서 늦게 적힌
// 실패의 다음 시도 전 어긋남)도 2의 비교로 최대 5분 안에 맞춰진다.
// 목록은 실행 처음에 한 번 읽은 것이라 그 뒤 요청이 바꾼 키와 다를 수 있다. 그래도 거는 값은 늘 applyKey 가 그 자리에서 다시 읽은
// 목표다 — 옛 목록 때문에 새 목표를 거스르지 않는다 (옛 목록은 "다시 걸어 볼 키"를 고르는 데만 쓴다).
// 임대를 잃으면(signal) 다음 키를 시작하지 않고 던진다. 쓰기는 모두 펜싱한다.
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { createClient, type KeyInfo } from "@magnetosphere/omniroute";
import { createCipher } from "@magnetosphere/runtime/crypto";
import { LeaseLostError, updatedRows, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle, Job, Runtime } from "@magnetosphere/runtime/types";
import { requireSecret } from "../config.ts";
import type { ClientFor } from "../limits/daily.ts";
import { dayKey } from "../limits/month.ts";
import type { LimitsClient } from "../limits/rebalance.ts";
import { guard, holds, readSetting, writeSetting } from "../limits/store.ts";
import { readOmniRouteToken } from "../setup/omniroute.ts";
import { applyKey } from "./apply.ts";
import { readTarget, type KeyTargetRow } from "./target.ts";

/** OmniRoute 호출 하나의 제한 시간 (어댑터 기본값과 같다) */
const CALL_TIMEOUT_MS = 15_000;
/** 회원 키에 붙으면 안 되는 범위 (5.8) */
const DANGEROUS_SCOPES = new Set(["manage", "admin"]);
/** 회원 앱이 만드는 OmniRoute 키 이름 접두사 (5.2: m_<회원 id 앞 8자리>_<키 id 앞 8자리>) */
const MEMBER_PREFIX = "m_";
/** 오늘 남긴 점검 알림 { day, keys: ["종류|OmniRoute 키 id"] } */
export const ALERTED_KEY = "reconcile_alerted";

export interface ReconcileClient extends LimitsClient {
  listKeys(): Promise<KeyInfo[]>;
}

export interface ReconcileDeps {
  db: DbHandle;
  client: ClientFor<ReconcileClient>;
  now: Date;
  lease?: Lease;
  signal?: AbortSignal;
  /** 끈 시각을 재는 시계 (기본: now 고정). 실행기는 실제 시계를 넘긴다 */
  clock?: () => number;
}

export interface ReconcileResult {
  /** OmniRoute 키 수 */
  keys: number;
  /** applyKey 로 목표를 다시 건 키 수 (synced) */
  applied: number;
  /** 다시 걸다 실패한 키 수 (applyKey 가 큐에 넣었거나 DB 오류) */
  failed: number;
  /** 매핑 없는 m_ 키 수 */
  unknown: number;
  /** manage·admin 범위가 붙은 키 수 */
  manageScope: number;
  /** 새로 남긴 알림 수 (하루 한 번 거른 뒤) */
  alerts: number;
}

interface Alert {
  kind: "unknown_m_key" | "manage_scope_key";
  /** OmniRoute 키 id */
  target: string;
  detail: Record<string, unknown>;
}

/** 키 state 가 회원 상태와 맞지 않는다 (applyKey 가 맞춘다) */
const unnormalized = (c: KeyTargetRow) =>
  (c.userStatus === "deleted" && c.keyState !== "deleted") ||
  (c.userStatus !== "active" && c.userStatus !== "deleted" && c.keyState === "active" && c.disabledReason === null) ||
  (c.userStatus === "active" && c.keyState === "disabled" && c.disabledReason === "user_status");

/** 다시 걸어야 하는가 */
function drifted(c: KeyTargetRow, isActive: boolean): boolean {
  if (c.target === "deleted") return isActive || !c.deletePending || c.keyState !== "deleted";
  const want = c.target === "on" && !c.deletePending;
  return want !== isActive || c.syncState !== "synced" || unnormalized(c);
}

/** manage·admin 범위가 붙은 매핑 키를 관리자가 끈 것으로 적는다. 회원·관리자가 이미 끈 키·삭제한 키는 그대로 */
async function holdByAdmin(h: DbHandle, lease: Lease | undefined, keyId: string): Promise<void> {
  const k = h.schema.apiKeys;
  const mayTurnOn = and(ne(k.state, "deleted"), or(isNull(k.disabledReason), inArray(k.disabledReason, ["user_status", "limit"])));
  await updatedRows(h, h.db.update(k).set({ state: "disabled", disabledReason: "admin" }).where(guard(h, lease, and(eq(k.id, keyId), mayTurnOn))), k.id);
}

export async function reconcile(d: ReconcileDeps): Promise<ReconcileResult> {
  const h = d.db;
  const stopIfLost = () => {
    if (d.signal?.aborted) throw d.signal.reason ?? new Error("임대를 잃었다");
  };
  const list = await d.client().listKeys();
  const k = h.schema.apiKeys;
  const mapped = new Map<string, string>((await h.db.select({ id: k.id, ork: k.omnirouteKeyId }).from(k)).map((r: { id: string; ork: string }) => [r.ork, r.id]));
  const result: ReconcileResult = { keys: list.length, applied: 0, failed: 0, unknown: 0, manageScope: 0, alerts: 0 };
  const alerts: Alert[] = [];
  const apply = (keyId: string, actual: boolean) => applyKey(h, keyId, { client: d.client, lease: d.lease, signal: d.signal, now: d.now, clock: d.clock, actual });
  for (const key of list) {
    stopIfLost();
    const keyId = mapped.get(key.id);
    const named = key.name.startsWith(MEMBER_PREFIX);
    if (!keyId && !named) continue;
    try {
      const scopes = key.scopes.filter((s) => DANGEROUS_SCOPES.has(s));
      if (scopes.length > 0) {
        result.manageScope++;
        alerts.push({ kind: "manage_scope_key", target: key.id, detail: { name: key.name, scopes, mapped: keyId !== undefined, wasActive: key.isActive } });
        if (keyId) {
          await holdByAdmin(h, d.lease, keyId);
          const r = await apply(keyId, key.isActive);
          if (r.syncState === "synced") result.applied++;
          else result.failed++;
        } else {
          if (key.isActive) {
            stopIfLost();
            await d.client().setKeyActive(key.id, false);
          }
          result.unknown++;
          alerts.push({ kind: "unknown_m_key", target: key.id, detail: { name: key.name, isActive: key.isActive } });
        }
        continue;
      }
      if (!keyId) {
        result.unknown++;
        alerts.push({ kind: "unknown_m_key", target: key.id, detail: { name: key.name, isActive: key.isActive } });
        continue;
      }
      const cur = await readTarget(h, keyId);
      if (!cur || !drifted(cur, key.isActive)) continue;
      const r = await apply(keyId, key.isActive);
      if (r.syncState === "synced") result.applied++;
      else result.failed++;
    } catch (e) {
      if (d.signal?.aborted) throw d.signal.reason ?? e;
      if (e instanceof LeaseLostError) throw e;
      // 이 키만 실패로 세고 다음 키로 간다. OmniRoute 실패는 applyKey 가 큐에 넣었고, 그 밖은 다음 점검이 다시 본다
      result.failed++;
    }
  }
  result.alerts = await writeAlerts(h, d.lease, alerts, d.now);
  return result;
}

/** 관리자 알림 (audit_log alert.<종류>, Q6). 같은 종류·같은 키는 하루(UTC) 한 번. 새로 남긴 수 */
async function writeAlerts(h: DbHandle, lease: Lease | undefined, alerts: Alert[], now: Date): Promise<number> {
  if (alerts.length === 0) return 0;
  const day = dayKey(now);
  const seen = await readSetting<{ day: string; keys: string[] }>(h, ALERTED_KEY);
  const keys = new Set(seen?.day === day ? seen.keys : []);
  const fresh: Alert[] = [];
  for (const a of alerts) {
    const id = `${a.kind}|${a.target}`;
    if (keys.has(id)) continue;
    keys.add(id);
    fresh.push(a);
  }
  if (fresh.length === 0) return 0;
  if (lease && !(await holds(h, lease))) throw new LeaseLostError(lease);
  for (const a of fresh) {
    await h.db.insert(h.schema.auditLog).values({
      id: crypto.randomUUID(),
      actorId: null,
      action: `alert.${a.kind}`,
      target: a.target,
      detail: JSON.stringify(a.detail),
      ip: null,
      createdAt: now,
    });
  }
  await writeSetting(h, ALERTED_KEY, { day, keys: [...keys] }, now, lease);
  return fresh.length;
}

/** jobs.ts 의 reconcile 본문. OmniRoute 연결(주소 + 설치 때 저장한 관리 토큰)이 없으면 할 일이 없다 */
export function reconcileJob(rt: Runtime): Job {
  return async ({ db, lease, signal }) => {
    const baseUrl = rt.secret("OMNIROUTE_URL");
    if (!baseUrl) return;
    const token = await readOmniRouteToken(db, await createCipher(requireSecret(rt, "APP_ENCRYPTION_KEY")));
    if (!token) return;
    // 호출마다 임대 신호(임대를 잃으면 끊김)와 제한 시간 중 먼저 오는 쪽으로 끊는다
    const client: ClientFor<ReconcileClient> = (o) =>
      createClient({ baseUrl, credential: { token }, signal: AbortSignal.any([signal, AbortSignal.timeout(o?.timeoutMs ?? CALL_TIMEOUT_MS)]) });
    await reconcile({ db, client, now: new Date(), lease, signal, clock: Date.now });
  };
}
