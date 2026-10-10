// OmniRoute 작업 큐 omniroute_jobs (계획서 5.7 반영, 5.9, K1.T3).
// 요청 안에서 바로 한 OmniRoute 반영이 실패하면 여기에 넣고, 1분 실행기(jobs.ts 의 omniroute_jobs)가 재시도한다.
//
// 재시도 (계획서 v5.6 Q2·Q3·Q6)
//   - 실패할 때마다 attempts + 1, 다음 시도는 실패 시각 + RETRY_DELAYS_MS[attempts − 1] (1분·2분·10분·30분).
//     실행기 최소 주기가 1분이라 1분보다 짧은 간격은 지킬 수 없다.
//   - 4번째 재시도(다섯 번째 시도)도 실패하면 failed_at = 지금, 대상 키 sync_state = failed, audit_log alert.job_failed 1행.
//     next_run_at 은 그대로 둔다. failed_at 이 있는 작업은 runDue 가 다시 집지 않는다 (정합성 점검이 키를 다시 맞춘다, 5.7).
//   - failed_at 에서 30분이 지나면 "오래 실패"다 (isLongFailed, 관리 화면은 7단계).
// 키별 순서 (K1 리뷰 #1, TC-K1.T3.f)
//   - key.apply_state 는 값을 싣지 않는다 (payload { keyId }). 실행할 때 api_keys·회원 상태로 목표를 다시 계산해 건다 (target.ts).
//     그래서 오래된 재시도가 더 새 반영을 덮지 않는다.
//   - 같은 키의 미완료 key.apply_state 가 있으면 새로 넣지 않고 그 id 를 돌려준다 (합치기). 동시에 넣어 둘이 생겨도
//     둘 다 실행 시점의 목표를 걸므로 결과는 같다.
//   - 같은 키에 미완료 key.delete 가 있으면 key.apply_state 는 켜지 않는다 (delete 가 이긴다).
// 차지 (TC-K1.T3.c)
//   - 실행기 둘이 동시에 돌아도 작업마다 핸들러는 한 번이다. 작업 하나를 "attempts 가 내가 읽은 값일 때만" 바꾸는 UPDATE 로
//     차지한다 (attempts + 1, next_run_at = 지금 + CLAIM_MS). 0행이면 다른 실행기가 먼저 차지한 것이다.
//   - 차지한 채 프로세스가 죽으면 CLAIM_MS 뒤에 다시 집힌다. 그 시도도 attempts 에 센다.
//   - 임대(lease)를 주면 모든 쓰기에 fenced() 를 붙인다. 임대를 잃은 실행기의 쓰기는 0행이다 (K1.T2).
// last_error 에는 OmniRoute 오류 코드·상태만 남긴다. OmniRouteError.message 는 응답 본문 300자를 담아 관리 토큰·원문 키가
// 섞일 수 있다 (TC-K1.T3.e).
import { and, asc, eq, isNull, lte, type SQL } from "drizzle-orm";
import { OmniRouteError, OmniRouteFormatError } from "@magnetosphere/omniroute";
import { fenced, updatedRows, type Lease } from "@magnetosphere/runtime/lease";
import type { DbHandle } from "@magnetosphere/runtime/types";

/** 재시도 간격 (ms). 계획서 v5.6 Q2 */
export const RETRY_DELAYS_MS = [60_000, 120_000, 600_000, 1_800_000] as const;
/** failed_at 에서 이만큼 지나면 오래 실패 (계획서 v5.6 Q3) */
export const LONG_FAILED_MS = 30 * 60_000;
/** 차지한 작업을 다른 실행기가 다시 집기까지. 핸들러 하나가 이보다 오래 걸리지 않는다 (OmniRoute 호출 제한 15초) */
export const CLAIM_MS = 5 * 60_000;
/**
 * key.delete 는 키를 끈 시각 + 2분 뒤에 잡는다. OmniRoute 는 끈 뒤 60초가 지나야 지울 수 있고(V18, 계획서 v5.6 5.2),
 * 실행기가 1분마다 돌므로 2분이면 60초가 지난 뒤 첫 실행에서 집힌다.
 */
export const KEY_DELETE_DELAY_MS = 120_000;

export const ACTIONS = ["key.apply_state", "key.delete", "budget.set", "key.rollback"] as const;
export type JobAction = (typeof ACTIONS)[number];

/** 작업 대상. keyId 는 api_keys.id — 재시도를 다 써도 실패하면 이 키의 sync_state 를 failed 로 둔다 */
export interface JobPayload {
  keyId?: string;
  [field: string]: unknown;
}

export interface QueuedJob {
  id: string;
  action: JobAction;
  payload: JobPayload;
  /** 이번 시도를 포함한 시도 횟수 */
  attempts: number;
}

export type Handler = (payload: JobPayload, ctx: { job: QueuedJob; db: DbHandle; signal?: AbortSignal }) => Promise<void>;
export type Handlers = Record<JobAction, Handler>;

export interface EnqueueOptions {
  /** 처음 시도 시각 (기본 now). key.delete 는 꼭 준다 (끈 시각 + KEY_DELETE_DELAY_MS) */
  runAt?: Date;
  now?: Date;
}

/** 작업 하나를 넣는다. id 를 돌려준다 */
export async function enqueue(h: DbHandle, action: JobAction, payload: JobPayload, opts: EnqueueOptions = {}): Promise<string> {
  if (!ACTIONS.includes(action)) throw new TypeError(`모르는 작업: ${action}`);
  if (action === "key.delete" && !opts.runAt) throw new TypeError("key.delete 는 runAt(끈 시각 + KEY_DELETE_DELAY_MS)이 필요하다 (V18)");
  const keyId = typeof payload.keyId === "string" && payload.keyId !== "" ? payload.keyId : null;
  const t = h.schema.omnirouteJobs;
  if (action === "key.apply_state") {
    if (!keyId) throw new TypeError("key.apply_state 는 payload.keyId(api_keys.id)가 필요하다");
    // 값은 싣지 않는다. 넣는 쪽이 준 active 등은 버린다 (실행할 때 다시 계산한다)
    payload = { keyId };
    const [pending] = await h.db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.keyId, keyId), eq(t.action, action), isNull(t.doneAt), isNull(t.failedAt)))
      .limit(1);
    if (pending) return pending.id;
  }
  const id = crypto.randomUUID();
  await h.db.insert(t).values({ id, action, payload: JSON.stringify(payload), keyId, attempts: 0, nextRunAt: opts.runAt ?? opts.now ?? new Date() });
  return id;
}

/** 실패 기록. 비밀 값(관리 토큰 oma_live_…, 제공자 키 sk-…)을 지운 짧은 문자열 */
export function describeError(e: unknown): string {
  let s: string;
  if (e instanceof OmniRouteError) s = `OmniRoute ${e.status}${e.code ? ` ${e.code}` : ""}`;
  else if (e instanceof OmniRouteFormatError) s = "OmniRouteFormatError";
  else if (e instanceof Error) s = e.name;
  else s = "unknown";
  // 오류 코드도 응답 본문에서 온다. 비밀 값 모양은 남기지 않는다
  return redact(s).slice(0, 200);
}

const SECRET = /(oma_live_|sk-)[A-Za-z0-9_\-.]*/gi;
const redact = (s: string) => s.replace(SECRET, "[비밀 값 지움]");

export function isLongFailed(job: { failedAt: Date | null }, now: Date): boolean {
  return job.failedAt !== null && now.getTime() - job.failedAt.getTime() > LONG_FAILED_MS;
}

export interface RunDueOptions {
  /** 이 실행기의 임대. 주면 모든 쓰기를 펜싱한다 */
  lease?: Lease;
  /** 끊기면 다음 작업을 집지 않는다. 핸들러에도 넘긴다 */
  signal?: AbortSignal;
}

export interface RunDueResult {
  done: number;
  retried: number;
  failed: number;
}

/** 지금 돌 차례인 작업(done_at·failed_at NULL, next_run_at ≤ now)을 하나씩 차지해 돈다 */
export async function runDue(h: DbHandle, handlers: Handlers, now: Date, opts: RunDueOptions = {}): Promise<RunDueResult> {
  const t = h.schema.omnirouteJobs;
  const guard = (cond: SQL | undefined) => (opts.lease ? and(cond, fenced(h, opts.lease)) : cond);
  const result: RunDueResult = { done: 0, retried: 0, failed: 0 };
  const due = and(isNull(t.doneAt), isNull(t.failedAt), lte(t.nextRunAt, now));
  const missed = new Set<string>();
  for (;;) {
    if (opts.signal?.aborted) break;
    const [row] = await h.db.select().from(t).where(due).orderBy(asc(t.nextRunAt), asc(t.id)).limit(1);
    if (!row) break;
    const claimed = await updatedRows(
      h,
      h.db
        .update(t)
        .set({ attempts: row.attempts + 1, nextRunAt: new Date(now.getTime() + CLAIM_MS) })
        .where(guard(and(eq(t.id, row.id), eq(t.attempts, row.attempts), due))),
      t.id,
    );
    if (claimed !== 1) {
      // 다른 실행기가 먼저 차지했다 (그러면 다음 select 에 이 작업이 없다). 임대를 잃었거나 같은 작업을 또 못 집으면 멈춘다
      if (opts.lease && !(await stillMine(h, opts.lease))) break;
      if (missed.has(row.id)) break;
      missed.add(row.id);
      continue;
    }
    const job: QueuedJob = { id: row.id, action: row.action, payload: JSON.parse(row.payload), attempts: row.attempts + 1 };
    const mine = guard(and(eq(t.id, job.id), eq(t.attempts, job.attempts)));
    try {
      const handler = handlers[job.action];
      if (!handler) throw new TypeError(`모르는 작업: ${job.action}`);
      await handler(job.payload, { job, db: h, signal: opts.signal });
      await h.db.update(t).set({ doneAt: now, lastError: null }).where(mine);
      result.done++;
    } catch (e) {
      const lastError = describeError(e);
      if (job.attempts <= RETRY_DELAYS_MS.length) {
        await h.db
          .update(t)
          .set({ lastError, nextRunAt: new Date(now.getTime() + RETRY_DELAYS_MS[job.attempts - 1]) })
          .where(mine);
        result.retried++;
      } else {
        // 4번째 재시도도 실패. next_run_at 은 이번 시도 전 값으로 되돌린다 (차지할 때 바꾼 값)
        const n = await updatedRows(h, h.db.update(t).set({ lastError, failedAt: now, nextRunAt: row.nextRunAt }).where(mine), t.id);
        if (n === 1) await markFailed(h, job, lastError, now, opts.lease);
        result.failed++;
      }
    }
  }
  return result;
}

async function stillMine(h: DbHandle, lease: Lease): Promise<boolean> {
  const t = h.schema.jobLeases;
  const rows = await h.db.select({ fence: t.fence }).from(t).where(and(eq(t.name, lease.name), eq(t.holder, lease.holder), eq(t.fence, lease.fence)));
  return rows.length === 1;
}

/** 재시도를 다 쓴 작업: 대상 키를 failed 로 드러내고 관리자에게 알린다 (계획서 v5.6 Q3·Q6) */
async function markFailed(h: DbHandle, job: QueuedJob, lastError: string, now: Date, lease: Lease | undefined) {
  const s = h.schema;
  if (typeof job.payload.keyId === "string") {
    const where = and(eq(s.apiKeys.id, job.payload.keyId), lease ? fenced(h, lease) : undefined);
    await h.db.update(s.apiKeys).set({ syncState: "failed" }).where(where);
  }
  await h.db.insert(s.auditLog).values({
    id: crypto.randomUUID(),
    actorId: null,
    action: "alert.job_failed",
    target: job.id,
    detail: JSON.stringify({ action: job.action, attempts: job.attempts, keyId: job.payload.keyId ?? null, error: lastError }),
    createdAt: now,
  });
}
