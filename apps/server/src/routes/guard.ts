// 회원 API 공용 검사 (계획서 v5.7 4.5·4.6).
//   - 세션: Better Auth get-session 으로 회원 id 만 얻고, 역할·상태·한도는 DB 에서 읽는다 (세션 응답의 값을 믿지 않는다).
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { DbHandle } from "@magnetosphere/runtime/types";
import type { Services } from "../app.ts";

/** 세션 회원의 DB 값 */
export interface Member {
  id: string;
  role: string;
  status: string;
  emailVerified: boolean;
  monthlyLimitUsd: number | null;
  maxKeys: number | null;
}

/** 요청의 세션 회원. 세션이 없거나 DB 에 회원이 없으면 401 응답 */
export async function sessionMember(c: Context, s: Services): Promise<Member | Response> {
  const probe = new Request(new URL("/api/auth/get-session", c.req.url), { headers: { cookie: c.req.header("cookie") ?? "" } });
  const res = await s.auth.handler(probe);
  const session = res.ok ? ((await res.json().catch(() => null)) as { user?: { id?: unknown } } | null) : null;
  const userId = session?.user?.id;
  if (typeof userId !== "string") return c.json({ error: "unauthorized" }, 401);
  const member = await readMember(s.db, userId);
  if (!member) return c.json({ error: "unauthorized" }, 401);
  return member;
}

export async function readMember(h: DbHandle, userId: string): Promise<Member | null> {
  const u = h.schema.user;
  const [row] = await h.db
    .select({ id: u.id, role: u.role, status: u.status, emailVerified: u.emailVerified, monthlyLimitUsd: u.monthlyLimitUsd, maxKeys: u.maxKeys })
    .from(u)
    .where(eq(u.id, userId));
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    emailVerified: row.emailVerified === true || row.emailVerified === 1,
    monthlyLimitUsd: row.monthlyLimitUsd == null ? null : Number(row.monthlyLimitUsd),
    maxKeys: row.maxKeys == null ? null : Number(row.maxKeys),
  };
}
