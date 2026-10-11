// 관리자 초대 API (3단계 실행판 M3.T1, 계획서 4.2, Q3·Q4·Q5).
//   POST   /api/admin/invites { email?, role, expiresInDays? } → 201 { invite, link }   (Cache-Control: no-store)
//   GET    /api/admin/invites                                   → 200 { invites }
//   DELETE /api/admin/invites/:id                               → 200 { invite } · 404 not_found
//   - 활성 관리자만 (routes/guard.ts sessionAdmin, 역할·상태는 DB). 변경 요청의 같은 출처 검사는 app.ts 가 /api/admin/* 에 건다.
//     요청 수 제한은 세 경로를 합쳐 관리자당 분당 30회 (넘으면 429 rate_limited).
//   - 토큰: 32바이트 무작위 base64url. DB 에는 SHA-256 16진(token_hash)만 둔다. 원문은 201 응답의 링크
//     <public_base_url>/invite#<토큰> 에만 한 번 나간다. 조각(#)이라 서버 접근 기록에 남지 않는다. 감사 기록·로그에는 토큰·링크·이메일을 넣지 않는다.
//   - 규칙: role 은 member|admin. admin 이면 email 필수(400 admin_invite_requires_email, 링크가 새도 관리자 권한이 넘어가지 않게).
//     email 은 trim·소문자·형식 검사. expiresInDays 는 정수 1~30 (기본 7, 그 밖 400 invalid_expires).
//     정책 closed·sso_only 면 409 signup_closed, 설치 전(public_base_url 없음) 409 setup_required,
//     메일 설정 없음(mail_settings 행 없음, 가입 판정과 같은 기준) + email 없음이면 409 mail_required.
//   - 같은 email 의 살아 있는(미사용·미만료·미취소) 초대는 취소하고 새로 만든다. 취소·새 초대·감사 기록은 한 트랜잭션(D1 은 batch)이다.
//   - DELETE 는 미사용·미취소 초대만 취소한다(만료한 초대도 취소할 수 있다). 없는 id·이미 취소·이미 사용한 초대는 404 not_found 이고
//     아무것도 쓰지 않는다. 취소와 감사 기록 invite.revoke 는 한 트랜잭션(D1 은 batch)이다.
//   - 목록에는 토큰·해시를 넣지 않는다. invites 에 created_at 이 없어 만료 시각 늦은 순이다.
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { updatedRows } from "@magnetosphere/runtime/lease";
import type { Services } from "../app.ts";
import { auditStatement } from "../audit/index.ts";
import { consume, sessionAdmin, type Member } from "../routes/guard.ts";
import { mailConfigured, readSettings } from "../settings/index.ts";
import { readPublicBaseUrl } from "./base-url.ts";

export const INVITE_ROLES = ["member", "admin"] as const;
export const INVITE_EXPIRES_DAYS = { default: 7, min: 1, max: 30 } as const;
export const INVITE_ADMIN_LIMIT = { max: 30, windowMs: 60_000 } as const;
const DAY_MS = 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_FIELDS = new Set(["email", "role", "expiresInDays"]);

/** 32바이트 무작위 base64url (43자) */
function newToken(): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(32))) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function tokenHash(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface InviteRow {
  id: string;
  email: string | null;
  role: string;
  expiresAt: Date | string | number;
  usedAt: Date | string | number | null;
  usedBy: string | null;
  createdBy: string;
  revokedAt: Date | string | number | null;
}

const iso = (v: Date | string | number | null) => (v === null || v === undefined ? null : new Date(v).toISOString());

function view(r: InviteRow, now: number) {
  const status = r.usedAt !== null ? "used" : r.revokedAt !== null ? "revoked" : new Date(r.expiresAt).getTime() <= now ? "expired" : "active";
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    status,
    expiresAt: iso(r.expiresAt),
    usedAt: iso(r.usedAt),
    usedBy: r.usedBy,
    revokedAt: iso(r.revokedAt),
    createdBy: r.createdBy,
  };
}

function columns(h: DbHandle) {
  const t = h.schema.invites;
  return { id: t.id, email: t.email, role: t.role, expiresAt: t.expiresAt, usedAt: t.usedAt, usedBy: t.usedBy, createdBy: t.createdBy, revokedAt: t.revokedAt };
}

async function readInvite(h: DbHandle, id: string): Promise<InviteRow | undefined> {
  const [row] = await h.db.select(columns(h)).from(h.schema.invites).where(eq(h.schema.invites.id, id));
  return row;
}

type Parsed = { email: string | null; role: (typeof INVITE_ROLES)[number]; days: number } | { error: string };

function parseBody(raw: unknown): Parsed {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid_body" };
  const b = raw as Record<string, unknown>;
  if (!Object.keys(b).every((k) => BODY_FIELDS.has(k))) return { error: "invalid_body" };
  if (!INVITE_ROLES.includes(b.role as never)) return { error: "invalid_role" };
  const role = b.role as (typeof INVITE_ROLES)[number];
  let email: string | null = null;
  if (b.email !== undefined && b.email !== null) {
    if (typeof b.email !== "string") return { error: "invalid_email" };
    const e = b.email.trim().toLowerCase();
    if (e !== "") {
      if (e.length > 255 || !EMAIL.test(e)) return { error: "invalid_email" };
      email = e;
    }
  }
  if (role === "admin" && email === null) return { error: "admin_invite_requires_email" };
  let days: number = INVITE_EXPIRES_DAYS.default;
  if (b.expiresInDays !== undefined) {
    const d = b.expiresInDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < INVITE_EXPIRES_DAYS.min || d > INVITE_EXPIRES_DAYS.max) return { error: "invalid_expires" };
    days = d;
  }
  return { email, role, days };
}

/** 세션 관리자 + 요청 수 제한. 통과하면 관리자, 아니면 응답 */
async function admitted(c: Context, s: Services): Promise<Member | Response> {
  const admin = await sessionAdmin(c, s);
  if (admin instanceof Response) return admin;
  if (!(await consume(s.db, `invite-admin|${admin.id}`, INVITE_ADMIN_LIMIT.max, INVITE_ADMIN_LIMIT.windowMs, Date.now()))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  return admin;
}

/** 살아 있는(미사용·미취소·미만료) 초대 조건 */
function live(h: DbHandle, now: Date) {
  const t = h.schema.invites;
  return and(isNull(t.usedAt), isNull(t.revokedAt), gt(t.expiresAt, now));
}

export function inviteAdminRoutes(services: () => Promise<Services>) {
  const r = new Hono();

  r.get("/", async (c) => {
    const s = await services();
    const admin = await admitted(c, s);
    if (admin instanceof Response) return admin;
    const h = s.db;
    const rows: InviteRow[] = await h.db.select(columns(h)).from(h.schema.invites).orderBy(desc(h.schema.invites.expiresAt));
    const now = Date.now();
    return c.json({ invites: rows.map((row) => view(row, now)) });
  });

  r.post("/", async (c) => {
    const s = await services();
    const admin = await admitted(c, s);
    if (admin instanceof Response) return admin;
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "invalid_body" }, 400);
    const p = parseBody(await c.req.json().catch(() => null));
    if ("error" in p) return c.json({ error: p.error }, 400);
    const h = s.db;
    const mode = (await readSettings(h)).signup_mode;
    if (mode === "closed" || mode === "sso_only") return c.json({ error: "signup_closed" }, 409);
    const base = await readPublicBaseUrl(h);
    if (base === null) return c.json({ error: "setup_required" }, 409);
    if (p.email === null && !(await mailConfigured(h))) return c.json({ error: "mail_required" }, 409);

    const t = h.schema.invites;
    const now = new Date();
    const token = newToken();
    const row = {
      id: crypto.randomUUID(),
      email: p.email,
      tokenHash: await tokenHash(token),
      role: p.role,
      expiresAt: new Date(now.getTime() + p.days * DAY_MS),
      usedAt: null,
      usedBy: null,
      createdBy: admin.id,
      revokedAt: null,
    };
    const ip = (await s.clientIp?.(c.req.raw)) ?? null;
    // 같은 이메일의 살아 있는 초대 (감사 기록 invite.revoke 를 남길 대상)
    const replaced: string[] =
      p.email === null ? [] : (await h.db.select({ id: t.id }).from(t).where(and(eq(t.email, p.email), live(h, now)))).map((x: { id: string }) => x.id);
    const statements = (db: any) => [
      // 앞서 읽은 뒤 끼어든 같은 이메일 초대까지 취소한다
      ...(p.email !== null ? [db.update(t).set({ revokedAt: now }).where(and(eq(t.email, p.email), live(h, now)))] : []),
      db.insert(t).values(row),
      ...replaced.map((id) =>
        auditStatement(h, { actorId: admin.id, action: "invite.revoke", target: id, detail: { reason: "reinvite", replacedBy: row.id }, ip, now }, db),
      ),
      auditStatement(h, { actorId: admin.id, action: "invite.create", target: row.id, detail: { role: p.role, emailBound: p.email !== null, expiresInDays: p.days }, ip, now }, db),
    ];
    if (h.kind === "d1") {
      await h.db.batch(statements(h.db));
    } else {
      await h.db.transaction(async (tx: any) => {
        for (const st of statements(tx)) await st;
      });
    }
    c.header("Cache-Control", "no-store");
    return c.json({ invite: view(row, now.getTime()), link: `${base}/invite#${token}` }, 201);
  });

  r.delete("/:id", async (c) => {
    const s = await services();
    const admin = await admitted(c, s);
    if (admin instanceof Response) return admin;
    const h = s.db;
    const t = h.schema.invites;
    const id = c.req.param("id");
    const found = await readInvite(h, id);
    if (!found || found.usedAt !== null || found.revokedAt !== null) return c.json({ error: "not_found" }, 404);
    const now = new Date();
    const ip = (await s.clientIp?.(c.req.raw)) ?? null;
    const revoke = (db: any) => db.update(t).set({ revokedAt: now }).where(and(eq(t.id, id), isNull(t.usedAt), isNull(t.revokedAt)));
    const audit = (db: any) => auditStatement(h, { actorId: admin.id, action: "invite.revoke", target: id, detail: { reason: "admin" }, ip, now }, db);
    if (h.kind === "d1") {
      await h.db.batch([revoke(h.db), audit(h.db)]);
    } else {
      // 읽은 뒤 다른 요청이 취소·사용했으면 감사 기록 없이 404
      const changed = await h.db.transaction(async (tx: any) => {
        const n = await updatedRows(h, revoke(tx), t.id);
        if (n === 1) await audit(tx);
        return n;
      });
      if (changed !== 1) return c.json({ error: "not_found" }, 404);
    }
    const after = await readInvite(h, id);
    return c.json({ invite: view(after ?? { ...found, revokedAt: now }, now.getTime()) });
  });

  return r;
}
