// 관리자 한도·최대 개수 API (계획서 v5.7 5.2·5.3, K4.T3).
//   PATCH /api/admin/users/:id {monthlyLimitUsd?, maxKeys?} → 200 { user, rebalanced }
//     - 관리자 세션만. 역할은 DB 에서 읽는다 (세션 없음 401, 관리자 아님 403). 권한 칼럼은 Better Auth 로 못 바꾸고(input: false, 4.6) 여기서만 바꾼다.
//     - monthlyLimitUsd: null(무제한) 또는 0 이상 DECIMAL(12,6) 범위(999,999.999999 이하)·소수 6자리 이하의 수. 문자열은 받지 않는다.
//     - maxKeys: null(설정 기본값) 또는 0 이상 정수. 줄여도 이미 가진 키는 그대로 두고 새 발급만 막는다 (5.2).
//     - 저장 → audit_log(action limits.update) 1행 → 즉시 분배 rebalanceMember (5.3 "관리자가 한도를 바꾼 직후").
//       분배가 OmniRoute 에서 실패하면 rebalanced false 다. 저장한 한도는 1분 분배가 다시 건다.
//     - 잘못된 값·모르는 필드·빈 본문은 400 이고 DB 를 바꾸지 않는다. 없는 회원은 404.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Services } from "../app.ts";
import { rebalanceMember } from "../limits/member.ts";
import { sessionAdmin } from "./guard.ts";

/** DECIMAL(12,6) 의 가장 큰 값 */
export const LIMIT_MAX_USD = 999_999.999999;
/** 최대 키 개수의 상한 (INTEGER 범위 안, 운영에서 쓸 일 없는 큰 값) */
export const MAX_KEYS_MAX = 1000;

const FIELDS = new Set(["monthlyLimitUsd", "maxKeys"]);

/** 소수 6자리 이하인가 (부동소수 표현 오차는 받는다) */
const sixDecimals = (v: number) => Math.abs(v * 1e6 - Math.round(v * 1e6)) < 1e-6 * Math.max(1, Math.abs(v));

export function validLimit(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= LIMIT_MAX_USD && sixDecimals(v));
}

export function validMaxKeys(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_KEYS_MAX);
}

export function adminLimitRoutes(services: () => Promise<Services>) {
  const r = new Hono();
  r.patch("/users/:id", async (c) => {
    const s = await services();
    const admin = await sessionAdmin(c, s);
    if (admin instanceof Response) return admin;
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "invalid_body" }, 400);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_body" }, 400);
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((x) => !FIELDS.has(x))) return c.json({ error: "invalid_body" }, 400);
    if ("monthlyLimitUsd" in body && !validLimit(body.monthlyLimitUsd)) return c.json({ error: "invalid_monthly_limit" }, 400);
    if ("maxKeys" in body && !validMaxKeys(body.maxKeys)) return c.json({ error: "invalid_max_keys" }, 400);

    const u = s.db.schema.user;
    const id = c.req.param("id");
    const [before] = await s.db.db.select({ monthlyLimitUsd: u.monthlyLimitUsd, maxKeys: u.maxKeys }).from(u).where(eq(u.id, id));
    if (!before) return c.json({ error: "not_found" }, 404);
    const set: Record<string, unknown> = {};
    if ("monthlyLimitUsd" in body) set.monthlyLimitUsd = body.monthlyLimitUsd;
    if ("maxKeys" in body) set.maxKeys = body.maxKeys;
    await s.db.db.update(u).set(set).where(eq(u.id, id));
    const [after] = await s.db.db.select({ monthlyLimitUsd: u.monthlyLimitUsd, maxKeys: u.maxKeys }).from(u).where(eq(u.id, id));
    const now = new Date();
    const num = (v: unknown) => (v == null ? null : Number(v));
    const user = { id, monthlyLimitUsd: num(after.monthlyLimitUsd), maxKeys: num(after.maxKeys) };
    await s.db.db.insert(s.db.schema.auditLog).values({
      id: crypto.randomUUID(),
      actorId: admin.id,
      action: "limits.update",
      target: id,
      detail: JSON.stringify({ before: { monthlyLimitUsd: num(before.monthlyLimitUsd), maxKeys: num(before.maxKeys) }, after: { monthlyLimitUsd: user.monthlyLimitUsd, maxKeys: user.maxKeys } }),
      ip: (await s.clientIp?.(c.req.raw)) ?? null,
      createdAt: now,
    });
    let rebalanced = false;
    const client = await s.keysClient?.();
    if (client) {
      try {
        await rebalanceMember(s.db, id, { now, client });
        rebalanced = true;
      } catch (e) {
        console.error(`[admin] 한도 변경 뒤 즉시 분배 실패 (회원 ${id})`, e instanceof Error ? e.message : e);
      }
    }
    return c.json({ user, rebalanced });
  });
  return r;
}
