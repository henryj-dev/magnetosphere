// 키 발급 (계획서 v5.7 5.2, K4.T1). 회원 키 API(keys.ts)의 발급·재발급과 D1 동시 발급 시험 Worker 가 같이 쓴다.
//
// 확인 (OmniRoute 에 키를 만들기 전, 하나라도 걸리면 OmniRoute 에 쓰지 않는다)
//   - 회원 status active, 이메일 인증 → 아니면 403
//   - 키 수(활성 + 비활성, 삭제 제외. 재발급은 지울 옛 키를 뺀다) < user.max_keys ?? app_settings.default_max_keys → 아니면 409 max_keys
//   - 남은 한도 > 0 (월 한도 NULL 이면 통과) → 아니면 409 limit_exhausted. 저장값(usage_daily)만으로 0 이면 OmniRoute 를 부르지 않는다.
//     아니면 그 회원 키의 오늘 창 분석(읽기)을 한 번 부른다 (즉시 분배와 같은 계산, 5.3)
// 순서 (5.2 의 2~6번. 중간에 실패해도 한도 없는 키가 켜진 채 남지 않게)
//   0. 자리 잡기: api_keys 에 자리 행(omniroute_key_id = "pending-<id>", state disabled·disabled_reason member)을 넣는다.
//      최대 개수 검사와 넣기가 DB 에서 한 번에 판정된다 — SQLite·D1 은 조건부 INSERT 한 문장(D1 은 대화형 트랜잭션이 없다, 3.2),
//      MySQL·Postgres 는 회원 행을 FOR UPDATE 로 잠근 트랜잭션 안에서 세고 넣는다. 그래서 동시 발급이 최대 개수를 넘지 않고,
//      진 쪽은 OmniRoute 에 키를 만들지 않는다. 자리 행의 OmniRoute id 는 OmniRoute 키 목록에 없어 정합성 점검이 보지 않고,
//      member 로 꺼진 키라 분배·반영도 켜지 않는다.
//   1. createKey("m_<회원 id 앞 8자리>_<키 id 앞 8자리>") → 자리 행에 OmniRoute id 와 원문 끝 4자리 (원문은 저장하지 않는다)
//   2. setKeyActive(false)
//   3. 예산: 행을 disabled·limit 으로 바꾸고 즉시 분배 rebalanceMember. 분배는 limit 으로 꺼진 키에 예산을 먼저 건 뒤 켠다
//      (setBudget → setKeyActive(true), 월 한도가 없으면 예산 없이 켠다). 예산·켜기가 하나라도 실패하면 rebalanceMember 가 던진다
//      (K2 리뷰 M4). 그래서 예산이 성공한 뒤에만 켠다.
//   4. 분배 뒤 행이 active·synced 가 아니면(그사이 남은 한도 0 등) 실패로 본다.
//   5. 원문을 응답에 한 번 (keys.ts).
// 실패 (1 이후): deleteKey 로 되돌리고 행을 지운다 → 502 (남은 한도 0 이면 409). 되돌리기도 실패하면 키를 끄고(실패해도 진행)
//   key.rollback 작업을 넣고, 행은 state deleted 로 남긴다 — 정합성 점검이 목표 "삭제됨"으로 끄고 지운다 (원문이 회원에게 가기 전이라
//   5.2 의 60초 규칙이 필요 없다). 1(createKey) 이 실패하면 자리 행만 지운다.
import { and, count, eq, ne, sql } from "drizzle-orm";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { readTarget } from "../keys/target.ts";
import { computeBudgets } from "../limits/compute.ts";
import { costsOf, coveredUntil, storedSpent, type ClientFor } from "../limits/daily.ts";
import { rebalanceMember } from "../limits/member.ts";
import { monthStart } from "../limits/month.ts";
import type { LimitsClient } from "../limits/rebalance.ts";
import { readSetting } from "../limits/store.ts";
import { describeError, enqueue } from "../queue/index.ts";
import type { Member } from "./guard.ts";

/** 발급이 쓰는 어댑터 함수 */
export interface KeysClient extends LimitsClient {
  createKey(name: string): Promise<{ id: string; key: string; name: string }>;
  deleteKey(id: string): Promise<void>;
}

/** 설정에 기본값이 없을 때의 최대 키 개수 (시드 default_max_keys 와 같다) */
export const FALLBACK_MAX_KEYS = 2;
/** 예산·켜기 분배를 다시 해 보는 횟수 (같은 회원의 동시 발급이 겹칠 때) */
export const ISSUE_ROUNDS = 5;
/** 자리 행의 OmniRoute id 접두사. 어댑터 id 규칙(영숫자·_·-)을 지킨다 */
export const PENDING_PREFIX = "pending-";

/** 확인에 걸렸거나 OmniRoute 가 실패했다 */
export class IssueError extends Error {
  readonly status: 403 | 409 | 502;
  readonly code: string;
  constructor(status: 403 | 409 | 502, code: string, message = code) {
    super(message);
    this.name = "IssueError";
    this.status = status;
    this.code = code;
  }
}

/** OmniRoute 키 이름. 이메일·이름 같은 개인정보를 넣지 않는다 (5.2, 7장) */
export const keyName = (userId: string, keyId: string) => `m_${userId.slice(0, 8)}_${keyId.slice(0, 8)}`;

/** 회원의 최대 키 개수 */
export async function maxKeysOf(h: DbHandle, m: Pick<Member, "maxKeys">): Promise<number> {
  if (m.maxKeys !== null) return m.maxKeys;
  const v = await readSetting<unknown>(h, "default_max_keys");
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : FALLBACK_MAX_KEYS;
}

/** 삭제하지 않은 키 수 (exclude 는 세지 않는다) */
export async function liveKeyCount(h: DbHandle, userId: string, exclude?: string): Promise<number> {
  const k = h.schema.apiKeys;
  const [r] = await h.db
    .select({ n: count() })
    .from(k)
    .where(and(eq(k.userId, userId), ne(k.state, "deleted"), exclude ? ne(k.id, exclude) : undefined));
  return Number(r.n);
}

/**
 * 회원의 남은 한도 (USD). 월 한도 NULL 이면 null.
 * 저장값(이번 달 1일 ~ 확정한 날)만으로 한도에 닿으면 OmniRoute 를 부르지 않고 0. 아니면 그 회원 키(삭제 포함)의 오늘 창 분석 한 번
 */
export async function remainingOf(h: DbHandle, m: Pick<Member, "id" | "monthlyLimitUsd">, client: ClientFor<KeysClient>, now: Date): Promise<number | null> {
  if (m.monthlyLimitUsd === null) return null;
  const k = h.schema.apiKeys;
  const rows: { id: string; ork: string; state: string }[] = await h.db.select({ id: k.id, ork: k.omnirouteKeyId, state: k.state }).from(k).where(eq(k.userId, m.id));
  const keys = rows.filter((r) => !r.ork.startsWith(PENDING_PREFIX));
  const ids = keys.map((r) => r.ork);
  const from = await coveredUntil(h, now);
  const stored = await storedSpent(h, ids, monthStart(now), from);
  const plan = (spent: ReadonlyMap<string, number>) =>
    computeBudgets({ limitUsd: m.monthlyLimitUsd, keys: keys.map((r) => ({ id: r.id, state: r.state, spentUsd: spent.get(r.ork) ?? 0 })) });
  if (ids.length === 0 || plan(stored).exhausted) return plan(stored).remaining;
  const today = costsOf(await client().getAnalytics({ apiKeyIds: ids, startDate: from, endDate: now }), new Set(ids));
  return plan(new Map(ids.map((id) => [id, (stored.get(id) ?? 0) + (today.get(id) ?? 0)]))).remaining;
}

interface SlotRow {
  id: string;
  userId: string;
  label: string | null;
  createdAt: Date;
}

/** 자리 잡기 (위 0번). 최대 개수 안이면 행을 넣고 true */
export async function reserveSlot(h: DbHandle, row: SlotRow, max: number, exclude?: string): Promise<boolean> {
  const k = h.schema.apiKeys;
  const values = {
    id: row.id,
    userId: row.userId,
    omnirouteKeyId: PENDING_PREFIX + row.id,
    keyPreview: "",
    label: row.label,
    state: "disabled",
    disabledReason: "member",
    syncState: "pending",
    createdAt: row.createdAt,
  };
  if (h.provider === "sqlite") {
    // SQLite·D1: 세기와 넣기가 한 문장이다. 쓰기는 한 번에 하나라 동시에 와도 조건이 넣기 직전 값으로 판정된다
    const rows = await h.db.all(sql`
      INSERT INTO api_keys (id, user_id, omniroute_key_id, key_preview, label, state, disabled_reason, sync_state, created_at)
      SELECT ${values.id}, ${values.userId}, ${values.omnirouteKeyId}, ${values.keyPreview}, ${values.label}, ${values.state}, ${values.disabledReason}, ${values.syncState}, ${row.createdAt.getTime()}
      WHERE (SELECT count(*) FROM api_keys WHERE user_id = ${row.userId} AND state <> 'deleted' AND id <> ${exclude ?? ""}) < ${max}
      RETURNING id`);
    return rows.length === 1;
  }
  // MySQL·Postgres: 회원 행 잠금으로 같은 회원의 발급을 한 줄로 세운다. 잠근 뒤의 세기는 앞 트랜잭션이 커밋한 행을 본다
  // (Postgres READ COMMITTED 는 문장마다 새 스냅숏, InnoDB 는 잠금 읽기 뒤 첫 일반 읽기에서 스냅숏을 만든다)
  const u = h.schema.user;
  return h.db.transaction(async (tx: any) => {
    const locked = await tx.select({ id: u.id }).from(u).where(eq(u.id, row.userId)).for("update");
    if (locked.length !== 1) return false;
    const [r] = await tx
      .select({ n: count() })
      .from(k)
      .where(and(eq(k.userId, row.userId), ne(k.state, "deleted"), exclude ? ne(k.id, exclude) : undefined));
    if (Number(r.n) >= max) return false;
    await tx.insert(k).values(values);
    return true;
  });
}

export interface IssueOptions {
  client: ClientFor<KeysClient>;
  now?: Date;
  label?: string | null;
  /** 재발급: 최대 개수에서 뺄 옛 키 (api_keys.id) */
  replacing?: string;
  /** 서버 로그 (원문 키는 넘기지 않는다) */
  log?: (line: string) => void;
}

export interface Issued {
  id: string;
  omnirouteKeyId: string;
  preview: string;
  label: string | null;
  createdAt: Date;
  /** 원문. 이 응답 한 번만 쓴다 */
  secret: string;
}

/** 발급 전 확인 (OmniRoute 에 쓰지 않는다). 걸리면 IssueError */
export async function checkIssue(h: DbHandle, m: Member, opts: Pick<IssueOptions, "client" | "now" | "replacing">): Promise<number> {
  if (m.status !== "active") throw new IssueError(403, "member_inactive");
  if (!m.emailVerified) throw new IssueError(403, "email_unverified");
  const max = await maxKeysOf(h, m);
  if ((await liveKeyCount(h, m.id, opts.replacing)) >= max) throw new IssueError(409, "max_keys");
  let remaining: number | null;
  try {
    remaining = await remainingOf(h, m, opts.client, opts.now ?? new Date());
  } catch (e) {
    // 분석을 읽지 못하면 남은 한도를 모른다. 발급하지 않는다 (fail-closed)
    console.error(`[keys] 발급 확인 실패: 남은 한도 (회원 ${m.id}) ${describeError(e)}`);
    throw new IssueError(502, "omniroute_failed");
  }
  if (remaining !== null && !(remaining > 0)) throw new IssueError(409, "limit_exhausted");
  return max;
}

export async function issueKey(h: DbHandle, m: Member, opts: IssueOptions): Promise<Issued> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((line: string) => console.error(line));
  const max = await checkIssue(h, m, opts);
  const k = h.schema.apiKeys;
  const id = crypto.randomUUID();
  const label = opts.label ?? null;
  if (!(await reserveSlot(h, { id, userId: m.id, label, createdAt: now }, max, opts.replacing))) throw new IssueError(409, "max_keys");
  const dropRow = () => h.db.delete(k).where(eq(k.id, id));

  let created: { id: string; key: string };
  try {
    created = await opts.client().createKey(keyName(m.id, id));
  } catch (e) {
    await dropRow();
    log(`[keys] 발급 실패: createKey (회원 ${m.id}) ${describeError(e)}`);
    throw new IssueError(502, "omniroute_failed");
  }
  const preview = created.key.slice(-4);
  let disabled = false;
  try {
    await h.db.update(k).set({ omnirouteKeyId: created.id, keyPreview: preview }).where(eq(k.id, id));
    await opts.client().setKeyActive(created.id, false);
    disabled = true;
    // 예산을 먼저 걸고 켜게 limit 으로 꺼진 키로 둔다. 분배가 예산 → 켜기를 한다 (위 3번)
    await h.db.update(k).set({ disabledReason: "limit", budgetAt: null, budgetUsd: null, budgetMonth: null }).where(eq(k.id, id));
    await budgetThenEnable(h, m.id, id, now, opts.client);
  } catch (e) {
    await rollback(h, opts.client, { id, omnirouteKeyId: created.id }, disabled, now, log);
    if (e instanceof IssueError) throw e;
    log(`[keys] 발급 실패: 끄기·예산·켜기 (회원 ${m.id}, OmniRoute 키 ${created.id}) ${describeError(e)}`);
    throw new IssueError(502, "omniroute_failed");
  }
  return { id, omnirouteKeyId: created.id, preview, label, createdAt: now, secret: created.key };
}

/**
 * 위 3·4번. 같은 회원의 발급이 동시에 돌면 다른 쪽 분배가 이 키의 예산 시각(budget_at)을 먼저 가져가 내 분배는 이 키를 건너뛴다(stale).
 * 그때는 그쪽이 켜기까지 하거나, 시각을 늦춰 다시 분배한다 (ISSUE_ROUNDS 번까지). 건너뛴 키 없이 끝났는데 limit 으로 꺼져 있으면
 * 남은 한도가 0 이다 (409). 예산·켜기 실패는 rebalanceMember 가 던진다
 */
async function budgetThenEnable(h: DbHandle, userId: string, keyId: string, now: Date, client: ClientFor<KeysClient>): Promise<void> {
  for (let round = 0; round < ISSUE_ROUNDS; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 20 * round));
    const at = round === 0 ? now : new Date(Math.max(Date.now(), now.getTime() + round));
    const counts = await rebalanceMember(h, userId, { now: at, client });
    const cur = await readTarget(h, keyId);
    if (!cur) throw new IssueError(502, "omniroute_failed", "발급 중인 키 행이 없어졌다");
    if (cur.keyState === "active" && cur.syncState === "synced") return;
    if (cur.keyState === "disabled" && cur.disabledReason === "limit" && counts.stale === 0) throw new IssueError(409, "limit_exhausted");
    if (cur.keyState !== "active" && !(cur.keyState === "disabled" && cur.disabledReason === "limit")) throw new IssueError(502, "omniroute_failed", `발급 중인 키가 ${cur.keyState}/${cur.disabledReason ?? "-"} 이 됐다`);
  }
  throw new IssueError(502, "omniroute_failed", "발급 중인 키를 켜지 못했다 (분배가 계속 겹쳤다)");
}

/**
 * 만든 키를 되돌린다. deleteKey 가 되면 행을 지운다. 안 되면 아직 끄지 못한 키를 끄고(실패해도 진행) key.rollback 을 넣고
 * 행을 state deleted 로 남긴다 (정합성 점검이 끄고 지운다)
 */
async function rollback(h: DbHandle, client: ClientFor<KeysClient>, key: { id: string; omnirouteKeyId: string }, disabled: boolean, now: Date, log: (line: string) => void) {
  const k = h.schema.apiKeys;
  try {
    await client().deleteKey(key.omnirouteKeyId);
    await h.db.delete(k).where(eq(k.id, key.id));
    return;
  } catch (e) {
    log(`[keys] 되돌리기 실패: deleteKey (OmniRoute 키 ${key.omnirouteKeyId}) ${describeError(e)}. key.rollback 에 넣는다`);
  }
  if (!disabled) await client().setKeyActive(key.omnirouteKeyId, false).catch(() => undefined);
  await h.db.update(k).set({ state: "deleted", deletedAt: now, disabledReason: "member", syncState: "pending" }).where(eq(k.id, key.id));
  await enqueue(h, "key.rollback", { keyId: key.id, omnirouteKeyId: key.omnirouteKeyId }, { now });
}
