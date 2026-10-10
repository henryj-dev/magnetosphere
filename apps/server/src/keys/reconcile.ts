// 정합성 점검 reconcile (계획서 v5.7 5.7·5.8, K3.T3). jobs.ts 가 "*/5 * * * *" 로 등록한다 (임대·하트비트 아래).
//
// 한 번 실행
//   1. OmniRoute 키 목록(listKeys)을 한 번 읽는다. 못 읽으면 그대로 던진다 — 아무것도 바꾸지 않는다 (fail-closed).
//   2. 키마다 (회원 앱 매핑 api_keys.omniroute_key_id 로 찾는다. 삭제한 키의 행도 매핑이다)
//      - 매핑됐거나 이름이 m_ 인 키의 scopes 에 manage·admin 이 있으면: 끄고 alert.manage_scope_key (5.8).
//        매핑된 키는 꺼진 이유와 상관없이 disabled_reason admin 으로 적어 다음 점검·회원이 다시 켜지 않게 한다 (관리자가 보고 켠다).
//        매핑 없는 m_ 키라도 이 범위가 붙었으면 끈다 (계획서 5.8).
//        write 토큰이 회원 키에 manage 를 붙여 admin 토큰을 만드는 권한 상승(V10)을 잡는 장치는 이것 하나다.
//      - 매핑 없는 m_ 키: alert.unknown_m_key 만. 지우거나 끄지 않는다 (운영자가 만든 키·복구 중인 매핑일 수 있다, Q6).
//      - 이름이 m_ 가 아니고 매핑도 없는 키: 운영자 키다. 보지 않는다.
//      - 매핑된 키: 실제 isActive 를 목표(target.ts)와 비교해 어긋났거나, sync_state 가 synced 가 아니거나(failed 포함, Q3),
//        키 state 가 회원 상태와 맞지 않으면 applyKey (actual = 읽은 isActive). 회원 상태 변화(DB 에서 바꾼 정지·탈퇴)도 여기서
//        반영된다. 목표가 삭제됨인데 OmniRoute 에 남은 키는 끄고 key.delete 를 잡는다(이미 기다리는 작업이 없을 때).
//      - 매핑된 키가 disabled 인데 disabled_reason 이 없으면 alert.key_stuck (누가 왜 껐는지 모르는 키, 켜지 않는다).
//   2'. 그 전에 발급(K4) 도중 죽어 남은 자리 행과 그 m_ 키를 치운다 (sweepSlots, K4 보안 리뷰 M2).
//   3. 알림(keys/alerts.ts)은 찾은 자리에서 바로 쓴다. 같은 종류·같은 키를 하루(UTC) 한 번만 남긴다.
// 시간 예산 (K3 리뷰 #2): 키는 id 순으로 보고, 실행 시간이 budgetMs(임대의 2/3)를 넘으면 다음 키를 시작하지 않고 마지막으로 본 키 id 를
//   app_settings(CURSOR_KEY)에 적고 멈춘다. 다음 실행은 그 뒤부터 이어 가고, 끝까지 보면 위치를 지운다. 그래서 키가 많아도
//   뒤쪽 키가 영영 점검되지 않는 일이 없다. 시각은 키마다 clock() 으로 다시 읽는다.
// 큐가 스스로 끝까지 맞추지 않고 이 점검에 맡기는 두 경우(K1 메모: key.apply_state 의 다시 읽기 상한, 한 tick 안에서 늦게 적힌
// 실패의 다음 시도 전 어긋남)도 2의 비교로 최대 5분 안에 맞춰진다.
// 목록은 실행 처음에 한 번 읽은 것이라 그 뒤 요청이 바꾼 키와 다를 수 있다. 그래도 거는 값은 늘 applyKey 가 그 자리에서 다시 읽은
// 목표다 — 옛 목록 때문에 새 목표를 거스르지 않는다 (옛 목록은 "다시 걸어 볼 키"를 고르는 데만 쓴다).
// 임대를 잃으면(signal) 다음 키를 시작하지 않고 던진다. 쓰기는 모두 펜싱한다.
import { and, eq, like, lt, ne } from "drizzle-orm";
import { createClient, type KeyInfo } from "@magnetosphere/omniroute";
import { createCipher } from "@magnetosphere/runtime/crypto";
import { LeaseLostError, updatedRows, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle, Job, Runtime } from "@magnetosphere/runtime/types";
import { requireSecret } from "../config.ts";
import type { ClientFor } from "../limits/daily.ts";
import type { LimitsClient } from "../limits/rebalance.ts";
import { deleteSetting, guard, holds, readSetting, writeSetting } from "../limits/store.ts";
import { readOmniRouteToken } from "../setup/omniroute.ts";
import { alertOnce } from "./alerts.ts";
import { applyKey, PENDING_KEY_PREFIX } from "./apply.ts";
import { enqueue, KEY_DELETE_DELAY_MS } from "../queue/index.ts";
import { readTarget, type KeyTargetRow } from "./target.ts";

/** OmniRoute 호출 하나의 제한 시간 (어댑터 기본값과 같다) */
const CALL_TIMEOUT_MS = 15_000;
/** 회원 키에 붙으면 안 되는 범위 (5.8) */
const DANGEROUS_SCOPES = new Set(["manage", "admin"]);
/** 회원 앱이 만드는 OmniRoute 키 이름 접두사 (5.2: m_<회원 id 앞 8자리>_<키 id 앞 8자리>) */
const MEMBER_PREFIX = "m_";
/** 시간 예산에 걸려 멈춘 자리 (마지막으로 본 OmniRoute 키 id) */
export const CURSOR_KEY = "reconcile_cursor";
/** 발급 자리 행(K4)이 이보다 오래되면 발급이 죽은 것으로 보고 치운다. 발급 한 번은 OmniRoute 호출 몇 개라 길어야 1분 남짓이다 */
export const STALE_SLOT_MS = 10 * 60_000;
/** 한 실행의 시간 예산: 5분 작업 임대(295초)의 2/3 */
export const RECONCILE_BUDGET_MS = Math.floor(((5 * 60_000 - 5_000) * 2) / 3);

export interface ReconcileClient extends LimitsClient {
  listKeys(): Promise<KeyInfo[]>;
}

export interface ReconcileDeps {
  db: DbHandle;
  client: ClientFor<ReconcileClient>;
  now: Date;
  lease?: Lease;
  signal?: AbortSignal;
  /** 키마다 읽는 시계 (기본: now 고정). 실행기는 실제 시계를 넘긴다 */
  clock?: () => number;
  /** 이 시간이 지나면 다음 키를 시작하지 않는다 (기본 RECONCILE_BUDGET_MS) */
  budgetMs?: number;
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
  /** 시간 예산에 걸려 남은 키를 다음 실행으로 미뤘다 */
  stopped: boolean;
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

/**
 * manage·admin 범위가 붙은 매핑 키를 관리자가 끈 것으로 적는다. 꺼진 이유와 상관없이 덮어쓴다 (삭제한 키만 그대로).
 * member 로 남겨 두면 회원이 다시 켜 admin 급 키가 다음 점검까지 열린다 (K3 리뷰 #1)
 */
async function holdByAdmin(h: DbHandle, lease: Lease | undefined, keyId: string): Promise<void> {
  const k = h.schema.apiKeys;
  await updatedRows(h, h.db.update(k).set({ state: "disabled", disabledReason: "admin" }).where(guard(h, lease, and(eq(k.id, keyId), ne(k.state, "deleted")))), k.id);
}

export async function reconcile(d: ReconcileDeps): Promise<ReconcileResult> {
  const h = d.db;
  const clock = d.clock ?? (() => d.now.getTime());
  const budgetMs = d.budgetMs ?? RECONCILE_BUDGET_MS;
  const stopIfLost = () => {
    if (d.signal?.aborted) throw d.signal.reason ?? new Error("임대를 잃었다");
  };
  const startedAt = clock();
  const list = [...(await d.client().listKeys())].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const k = h.schema.apiKeys;
  const mapped = new Map<string, string>((await h.db.select({ id: k.id, ork: k.omnirouteKeyId }).from(k)).map((r: { id: string; ork: string }) => [r.ork, r.id]));
  const result: ReconcileResult = { keys: list.length, applied: 0, failed: 0, unknown: 0, manageScope: 0, alerts: 0, stopped: false };
  const swept = await sweepSlots(d, list, mapped);
  // 앞 실행이 멈춘 자리 뒤부터. 그 뒤에 키가 없으면(지워짐) 처음부터
  const cursor = await readSetting<string>(h, CURSOR_KEY);
  const from = cursor === undefined ? 0 : list.findIndex((x) => x.id > cursor);
  const order = from > 0 ? list.slice(from) : list;
  let lastSeen: string | undefined;
  for (const key of order) {
    stopIfLost();
    const at = clock();
    // 키 하나는 반드시 본다 (예산이 아무리 작아도 앞으로 나아간다)
    if (lastSeen !== undefined && at - startedAt >= budgetMs) {
      result.stopped = true;
      break;
    }
    lastSeen = key.id;
    const now = new Date(at);
    const alert = async (kind: Parameters<typeof alertOnce>[2], detail: Record<string, unknown>) => {
      if (await alertOnce(h, d.lease, kind, key.id, detail, now)) result.alerts++;
    };
    const apply = async (keyId: string) => {
      const r = await applyKey(h, keyId, { client: d.client, lease: d.lease, signal: d.signal, now, clock, actual: key.isActive });
      if (r.syncState === "synced") result.applied++;
      else if (r.syncState === "pending") result.failed++;
    };
    if (swept.has(key.id)) continue;
    const keyId = mapped.get(key.id);
    const named = key.name.startsWith(MEMBER_PREFIX);
    if (!keyId && !named) continue;
    try {
      const scopes = key.scopes.filter((s) => DANGEROUS_SCOPES.has(s));
      if (scopes.length > 0) {
        result.manageScope++;
        // 알림을 먼저 쓴다. 끈 뒤 실행이 끊겨도 알림은 남는다
        await alert("manage_scope_key", { name: key.name, scopes, mapped: keyId !== undefined, wasActive: key.isActive });
        if (keyId) {
          await holdByAdmin(h, d.lease, keyId);
          await apply(keyId);
        } else {
          result.unknown++;
          await alert("unknown_m_key", { name: key.name, isActive: key.isActive });
          if (key.isActive) {
            stopIfLost();
            await d.client().setKeyActive(key.id, false);
          }
        }
        continue;
      }
      if (!keyId) {
        result.unknown++;
        await alert("unknown_m_key", { name: key.name, isActive: key.isActive });
        continue;
      }
      const cur = await readTarget(h, keyId);
      if (!cur) continue;
      if (cur.keyState === "disabled" && cur.disabledReason === null) await alert("key_stuck", { keyId, isActive: key.isActive });
      if (drifted(cur, key.isActive)) await apply(keyId);
    } catch (e) {
      if (d.signal?.aborted) throw d.signal.reason ?? e;
      if (e instanceof LeaseLostError) throw e;
      // 이 키만 실패로 세고 다음 키로 간다. OmniRoute 실패는 applyKey 가 큐에 넣었고, 그 밖은 다음 점검이 다시 본다
      result.failed++;
    }
  }
  if (result.stopped && lastSeen !== undefined) await writeSetting(h, CURSOR_KEY, lastSeen, new Date(clock()), d.lease);
  else if (cursor !== undefined) await deleteSetting(h, CURSOR_KEY, d.lease);
  return result;
}

/**
 * 발급(K4 routes/issue.ts) 도중 죽어 남은 자리 행 정리 (K4 보안 리뷰 M2). STALE_SLOT_MS 보다 오래된 pending- 행마다
 *   - 이름이 m_<회원 id 8>_<자리 행 id 8> 인 매핑 없는 OmniRoute 키(createKey 직후 죽은 경우)를 끄고 key.delete 를 끈 뒤 2분으로 잡는다 (V18).
 *     이 키는 회원 앱이 만든 것이 이름과 자리 행으로 확인되므로 "운영자 키일 수 있다"(Q6)는 예외에 들지 않는다 (계획서 5.7).
 *   - 그다음 자리 행을 지운다 (최대 개수 한 칸을 돌려준다). 끄기·작업 넣기가 실패하면 행을 남겨 다음 점검이 다시 본다.
 * 치운 OmniRoute 키 id 를 돌려준다 (본 점검이 unknown_m_key 로 다시 알리지 않게)
 */
async function sweepSlots(d: ReconcileDeps, list: readonly KeyInfo[], mapped: ReadonlyMap<string, string>): Promise<Set<string>> {
  const h = d.db;
  const k = h.schema.apiKeys;
  const swept = new Set<string>();
  const stale: { id: string; userId: string }[] = await h.db
    .select({ id: k.id, userId: k.userId })
    .from(k)
    .where(and(like(k.omnirouteKeyId, `${PENDING_KEY_PREFIX}%`), lt(k.createdAt, new Date(d.now.getTime() - STALE_SLOT_MS))));
  for (const row of stale) {
    if (d.signal?.aborted) throw d.signal.reason ?? new Error("임대를 잃었다");
    const name = `${MEMBER_PREFIX}${row.userId.slice(0, 8)}_${row.id.slice(0, 8)}`;
    try {
      for (const key of list.filter((x) => x.name === name && !mapped.has(x.id))) {
        if (key.isActive) await d.client().setKeyActive(key.id, false);
        if (d.lease && !(await holds(h, d.lease))) throw new LeaseLostError(d.lease);
        await enqueue(h, "key.delete", { keyId: row.id, omnirouteKeyId: key.id }, { runAt: new Date(d.now.getTime() + KEY_DELETE_DELAY_MS), now: d.now });
        swept.add(key.id);
      }
      await h.db.delete(k).where(guard(h, d.lease, and(eq(k.id, row.id), like(k.omnirouteKeyId, `${PENDING_KEY_PREFIX}%`))));
    } catch (e) {
      if (d.signal?.aborted || e instanceof LeaseLostError) throw e;
      // 다음 점검이 다시 본다
    }
  }
  return swept;
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
