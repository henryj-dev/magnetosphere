// 회원 키 API (계획서 v5.7 5.2·5.7, K4.T1·T7). 경로는 /api/me/keys 다 — 어댑터 밖에서 OmniRoute 관리 경로 문자열을 쓰지 않는다 (G-S5.9).
//   GET    /api/me/keys                 → { keys[], maxKeys, remainingSlots } 원문 필드는 없다
//   POST   /api/me/keys {label?}        → 201 { key, secret } 발급 (issue.ts). 원문은 이 응답에만 있다
//   PATCH  /api/me/keys/:id {label}     → 200 { key } 우리 DB 만 바꾼다 (OmniRoute 이름은 m_ 규칙 그대로)
//   POST   /api/me/keys/:id/disable     → 200 { key } 바로 끈다 (K3 applyKey, disabled_reason member). 반영 실패면 202 (큐가 다시 끈다)
//   POST   /api/me/keys/:id/enable      → 200 { key } 회원이 끈 키만 (K3 requestEnable). 관리자가 끈 키 403, 한도로 꺼진 키 409 limit_exhausted
//   POST   /api/me/keys/:id/regenerate  → 201 { key, secret } 새 키를 발급 순서로 만들고 옛 키를 삭제 순서로 지운다 (v5.6, V19).
//                                          OmniRoute regenerate 는 부르지 않는다. 최대 개수는 옛 키를 빼고 센다
//   DELETE /api/me/keys/:id             → 200 { key } state deleted·deleted_at, 행은 남긴다 (V18). 바로 끄고 key.delete 는 끈 뒤 2분
// 공통
//   - 회원 세션 필요 (401). 역할·상태는 DB 에서 읽는다. 탈퇴(deleted) 회원은 모두 403.
//   - 키는 id 와 세션 회원 id 로 함께 찾는다. 남의 키·삭제한 키·없는 키는 모두 404 이고 OmniRoute 를 부르지 않는다.
//   - 키 변경(켜기·끄기·이름·재발급·삭제)은 회원당 분당 30회 (429).
//   - 발급 중인 자리 행(issue.ts)은 목록에 state issuing 으로 보이고(개수에 든다), 바꾸는 요청은 모두 409 issuing 이다.
//   - 변경 요청은 같은 출처만 (guard.ts sameOrigin, app.ts 에서 건다). 발급·재발급은 요청 수 제한 (Q4, 429, IPv6 는 /64).
//   - OmniRoute 연결(주소·관리 토큰)이 없으면 OmniRoute 를 부르는 요청은 503 omniroute_unavailable.
import { and, asc, eq, ne } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { applyKey, KeyConflictError, requestEnable } from "../keys/apply.ts";
import { readTarget } from "../keys/target.ts";
import type { ClientFor } from "../limits/daily.ts";
import type { Services } from "../app.ts";
import { consumeChange, consumeIssue, sessionMember, type Member } from "./guard.ts";
import { IssueError, issueKey, maxKeysOf, PENDING_PREFIX, type KeysClient } from "./issue.ts";

/** 원문이 든 응답은 브라우저·프록시가 저장하지 않게 한다 (K4 보안 리뷰 L1) */
const NO_STORE = { "cache-control": "no-store" };

/** 이름 최대 길이 */
export const LABEL_MAX = 64;

const k = (s: Services) => s.db.schema.apiKeys;

/** 발급 중인 자리 행인가 (issue.ts). 회원은 이 행을 바꾸지 못하고, 목록에는 state issuing 으로 보인다 */
const issuing = (r: { omnirouteKeyId: string }) => r.omnirouteKeyId.startsWith(PENDING_PREFIX);

/** 회원에게 보내는 키 필드 (허용 목록). OmniRoute id·예산 값은 보내지 않는다 */
function view(r: any) {
  return {
    id: r.id as string,
    label: (r.label ?? null) as string | null,
    preview: r.keyPreview as string,
    state: (issuing(r) ? "issuing" : r.state) as string,
    disabledReason: (r.disabledReason ?? null) as string | null,
    syncState: r.syncState as string,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/** 이름 검사. undefined 는 "주지 않음", 빈 문자열·null 은 이름 없음 */
function parseLabel(v: unknown): { ok: true; label: string | null | undefined } | { ok: false } {
  if (v === undefined) return { ok: true, label: undefined };
  if (v === null) return { ok: true, label: null };
  if (typeof v !== "string") return { ok: false };
  const t = v.trim();
  if (t.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(t)) return { ok: false };
  return { ok: true, label: t === "" ? null : t };
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const ct = c.req.header("content-type") ?? "";
  if (ct === "" && (c.req.header("content-length") ?? "0") === "0") return {};
  if (!/^application\/json\b/i.test(ct)) return null;
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

/**
 * 바꿀 수 있는 내 키 행. 회원당 분당 변경 횟수를 넘으면 429 (K4 보안 리뷰 L3), 없으면 404, 발급 중이면 409 issuing 응답 (M1).
 * 횟수는 키를 찾기 전에 센다 (남의 키 id 를 찔러 보는 요청도 센다)
 */
async function changeable(c: Context, s: Services, m: Member, id: string): Promise<any | Response> {
  if (!(await consumeChange(s.db, m.id))) return c.json({ error: "too_many_requests" }, 429);
  const row = await myKey(s, m, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (issuing(row)) return c.json({ error: "issuing" }, 409);
  return row;
}

/** 내 키 행 (삭제한 키 제외). 없으면 null */
async function myKey(s: Services, m: Member, id: string) {
  const t = k(s);
  const [row] = await s.db.db
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.userId, m.id), ne(t.state, "deleted")));
  return row ?? null;
}

async function rowOf(s: Services, id: string) {
  const t = k(s);
  const [row] = await s.db.db.select().from(t).where(eq(t.id, id));
  return row;
}

const issueError = (c: Context, e: IssueError) => c.json({ error: e.code }, e.status);

export function keyRoutes(services: () => Promise<Services>) {
  const r = new Hono<{ Variables: { s: Services; m: Member } }>();

  // 세션 회원. 탈퇴 회원은 자기 키도 보지 못한다
  r.use("*", async (c, next) => {
    const s = await services();
    const m = await sessionMember(c, s);
    if (m instanceof Response) return m;
    if (m.status === "deleted") return c.json({ error: "member_inactive" }, 403);
    c.set("s", s);
    c.set("m", m);
    await next();
  });

  /** OmniRoute 어댑터. 연결이 없으면 503 응답 */
  const clientOf = async (c: Context, s: Services): Promise<ClientFor<KeysClient> | Response> => {
    const client = await s.keysClient?.();
    return client ?? c.json({ error: "omniroute_unavailable" }, 503);
  };

  r.get("/", async (c) => {
    const s = c.get("s");
    const m = c.get("m");
    const t = k(s);
    const rows = await s.db.db
      .select()
      .from(t)
      .where(and(eq(t.userId, m.id), ne(t.state, "deleted")))
      .orderBy(asc(t.createdAt), asc(t.id));
    const maxKeys = await maxKeysOf(s.db, m);
    return c.json({ keys: rows.map(view), maxKeys, remainingSlots: Math.max(maxKeys - rows.length, 0) });
  });

  /** 발급·재발급 공통: 요청 수 제한 → 발급 */
  const issue = async (c: Context, s: Services, m: Member, label: string | null, replacing?: string) => {
    if (m.status !== "active") return c.json({ error: "member_inactive" }, 403);
    if (!m.emailVerified) return c.json({ error: "email_unverified" }, 403);
    if (!(await consumeIssue(s.db, m.id, (await s.clientIp?.(c.req.raw)) ?? null))) return c.json({ error: "too_many_requests" }, 429);
    const client = await clientOf(c, s);
    if (client instanceof Response) return client;
    try {
      return await issueKey(s.db, m, { client, label, replacing });
    } catch (e) {
      if (e instanceof IssueError) return issueError(c, e);
      throw e;
    }
  };

  r.post("/", async (c) => {
    const s = c.get("s");
    const m = c.get("m");
    const body = await jsonBody(c);
    const label = parseLabel(body?.label);
    if (!body || !label.ok) return c.json({ error: "invalid_body" }, 400);
    const issued = await issue(c, s, m, label.label ?? null);
    if (issued instanceof Response) return issued;
    return c.json({ key: view(await rowOf(s, issued.id)), secret: issued.secret }, 201, NO_STORE);
  });

  r.patch("/:id", async (c) => {
    const s = c.get("s");
    const m = c.get("m");
    const body = await jsonBody(c);
    const label = parseLabel(body?.label);
    if (!body || !label.ok || label.label === undefined) return c.json({ error: "invalid_body" }, 400);
    const t = k(s);
    const row = await changeable(c, s, m, c.req.param("id"));
    if (row instanceof Response) return row;
    await s.db.db
      .update(t)
      .set({ label: label.label })
      .where(and(eq(t.id, c.req.param("id")), eq(t.userId, m.id), ne(t.state, "deleted")));
    return c.json({ key: view(await rowOf(s, c.req.param("id"))) });
  });

  r.post("/:id/disable", async (c) => {
    const s = c.get("s");
    const m = c.get("m");
    const id = c.req.param("id");
    const row = await changeable(c, s, m, id);
    if (row instanceof Response) return row;
    const client = await clientOf(c, s);
    if (client instanceof Response) return client;
    // 관리자·회원이 이미 끈 키는 이유를 바꾸지 않는다 (관리자가 끈 키를 member 로 바꾸면 회원이 다시 켤 수 있다)
    if (row.state === "active" || (row.state === "disabled" && (row.disabledReason === "limit" || row.disabledReason === "user_status"))) {
      const t = k(s);
      await s.db.db
        .update(t)
        .set({ state: "disabled", disabledReason: "member" })
        .where(and(eq(t.id, id), eq(t.userId, m.id), eq(t.state, row.state), row.disabledReason == null ? undefined : eq(t.disabledReason, row.disabledReason)));
    }
    const r2 = await applyKey(s.db, id, { client });
    return c.json({ key: view(await rowOf(s, id)) }, r2.syncState === "synced" ? 200 : 202);
  });

  r.post("/:id/enable", async (c) => {
    const s = c.get("s");
    const m = c.get("m");
    const id = c.req.param("id");
    const row = await changeable(c, s, m, id);
    if (row instanceof Response) return row;
    if (row.state === "disabled" && row.disabledReason === "admin") return c.json({ error: "disabled_by_admin" }, 403);
    if (row.state === "disabled" && row.disabledReason === "limit") return c.json({ error: "limit_exhausted" }, 409);
    if (m.status !== "active") return c.json({ error: "member_inactive" }, 403);
    if (!m.emailVerified) return c.json({ error: "email_unverified" }, 403);
    const client = await clientOf(c, s);
    if (client instanceof Response) return client;
    let result;
    try {
      result = await requestEnable(s.db, id, "member", { client });
    } catch (e) {
      if (e instanceof KeyConflictError) return c.json({ error: "conflict" }, 409);
      throw e;
    }
    // 켜기 전 예산 계산이 남은 한도 0 을 보면 반영이 이 키를 limit 으로 껐다
    const cur = await readTarget(s.db, id);
    if (cur?.keyState === "disabled" && cur.disabledReason === "limit") return c.json({ error: "limit_exhausted" }, 409);
    return c.json({ key: view(await rowOf(s, id)) }, result.syncState === "synced" ? 200 : 202);
  });

  r.post("/:id/regenerate", async (c) => {
    const s = c.get("s");
    const m = c.get("m");
    const id = c.req.param("id");
    const old = await changeable(c, s, m, id);
    if (old instanceof Response) return old;
    // 관리자가 끈 키를 재발급으로 켜진 새 키로 바꾸지 못한다
    if (old.state === "disabled" && old.disabledReason === "admin") return c.json({ error: "disabled_by_admin" }, 403);
    const issued = await issue(c, s, m, old.label ?? null, id);
    if (issued instanceof Response) return issued;
    // 새 키가 켜진 뒤 옛 키를 삭제 순서로 지운다 (끄기 → 2분 뒤 DELETE)
    await deleteKeyRow(s, m, id);
    const client = await clientOf(c, s);
    if (!(client instanceof Response)) await applyKey(s.db, id, { client });
    return c.json({ key: view(await rowOf(s, issued.id)), secret: issued.secret }, 201, NO_STORE);
  });

  r.delete("/:id", async (c) => {
    const s = c.get("s");
    const m = c.get("m");
    const id = c.req.param("id");
    const row = await changeable(c, s, m, id);
    if (row instanceof Response) return row;
    const client = await clientOf(c, s);
    if (client instanceof Response) return client;
    await deleteKeyRow(s, m, id);
    const r2 = await applyKey(s.db, id, { client });
    return c.json({ key: view(await rowOf(s, id)) }, r2.syncState === "synced" ? 200 : 202);
  });

  return r;
}

/** 삭제 표시. 행과 매핑은 남긴다 — 그 키의 이번 달 사용액이 회원 합계에 남아 한도가 초기화되지 않는다 (V18) */
async function deleteKeyRow(s: Services, m: Member, id: string) {
  const t = k(s);
  await s.db.db
    .update(t)
    .set({ state: "deleted", deletedAt: new Date(), syncState: "pending" })
    .where(and(eq(t.id, id), eq(t.userId, m.id), ne(t.state, "deleted")));
}
