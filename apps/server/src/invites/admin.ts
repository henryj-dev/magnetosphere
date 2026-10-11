// 관리자 초대 API (3단계 실행판 M3.T1, 계획서 4.2, Q3·Q4·Q5).
//   POST   /api/admin/invites { email?, role, expiresInDays? } → 201 { invite, link } · 409 invite_conflict   (Cache-Control: no-store)
//   GET    /api/admin/invites                                   → 200 { invites }                         (Cache-Control: no-store)
//   DELETE /api/admin/invites/:id                               → 200 { invite } · 404 not_found
//   - 활성 관리자만 (routes/guard.ts sessionAdmin, 역할·상태는 DB). 변경 요청의 같은 출처 검사는 app.ts 가 /api/admin/* 에 건다.
//     요청 수 제한은 세 경로를 합쳐 관리자당 분당 30회 (넘으면 429 rate_limited).
//   - 토큰: 32바이트 무작위 base64url. DB 에는 SHA-256 16진(token_hash)만 둔다. 원문은 201 응답의 링크
//     <public_base_url>/invite#<토큰> 에만 한 번 나간다. 조각(#)이라 서버 접근 기록에 남지 않는다. 감사 기록·로그에는 토큰·링크·이메일을 넣지 않는다.
//   - 규칙: role 은 member|admin. admin 이면 email 필수(400 admin_invite_requires_email, 링크가 새도 관리자 권한이 넘어가지 않게).
//     email 은 필드 없음·null 만 "없음"이다. 문자열이면 trim → 소문자 → NFC 뒤 형식 검사(빈 문자열·제어문자·공백·<>(),;:"[]\ 는 400 invalid_email).
//     expiresInDays 는 정수 1~30 (기본 7, 그 밖 400 invalid_expires).
//     정책 closed·sso_only 면 409 signup_closed, 설치 전(public_base_url 없음) 409 setup_required,
//     메일 설정 없음(mail_settings 행 없음, 가입 판정과 같은 기준) + email 없음이면 409 mail_required.
//   - 같은 email 의 살아 있는(미사용·미만료·미취소) 초대는 취소하고 새로 만든다. 취소·새 초대·감사 기록은 한 트랜잭션(D1 은 batch)이다.
//     invite.revoke 는 그 트랜잭션·batch 안에서 실제로 취소한 행에만 남긴다 (Node: UPDATE … RETURNING, MySQL 은 SELECT … FOR UPDATE 뒤 UPDATE.
//     D1: 같은 조건의 INSERT … SELECT 를 UPDATE 앞에 둔다).
//   - 같은 email 을 동시에 만들면 서로의 취소를 못 볼 수 있다. 그래서 만든 뒤 한 번 더 정리한다: 같은 email 의 살아 있는 다른 초대 중
//     (expires_at, id) 가 자기보다 큰 것이 있으면 자기를 취소하고 409 invite_conflict(링크 없음), 없으면 자기보다 작은 것을 취소한다
//     (invite.revoke {reason: "superseded"}). 그 정리는 자기 행이 아직 살아 있을 때만 한다. 승자는 (expires_at, id) 가 가장 큰 것 하나다.
//   - DELETE 는 미사용·미취소 초대만 취소한다(만료한 초대도 취소할 수 있다). 없는 id·이미 취소·이미 사용한 초대는 404 not_found 이고
//     아무것도 쓰지 않는다. 읽은 뒤 다른 요청이 사용·취소했어도 404 이고 감사 기록이 없다. 취소와 감사 기록 invite.revoke 는 한 트랜잭션(D1 은 batch)이다.
//   - 목록에는 토큰·해시를 넣지 않는다. invites 에 created_at 이 없어 만료 시각 늦은 순이다.
import { and, desc, eq, getTableName, gt, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { updatedRows } from "@magnetosphere/runtime/lease";
import type { Services } from "../app.ts";
import { auditRow, auditStatement, type AuditEntry } from "../audit/index.ts";
import { consume, sessionAdmin, type Member } from "../routes/guard.ts";
import { mailConfigured, readSettings } from "../settings/index.ts";
import { readPublicBaseUrl } from "./base-url.ts";

export const INVITE_ROLES = ["member", "admin"] as const;
export const INVITE_EXPIRES_DAYS = { default: 7, min: 1, max: 30 } as const;
export const INVITE_ADMIN_LIMIT = { max: 30, windowMs: 60_000 } as const;
const DAY_MS = 86_400_000;
// 이메일 각 부분에 올 수 없는 글자: 공백(유니코드 포함)·@·<>(),;:"[]\·제어문자
const NOT_IN_EMAIL = String.raw`\s@<>(),;:"\[\]\\\x00-\x1f\x7f`;
const EMAIL = new RegExp(`^[^${NOT_IN_EMAIL}]+@[^${NOT_IN_EMAIL}]+\\.[^${NOT_IN_EMAIL}]+$`, "u");
const EMAIL_MAX = 255;
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
    const e = b.email.trim().toLowerCase().normalize("NFC");
    if (e.length > EMAIL_MAX || !EMAIL.test(e)) return { error: "invalid_email" };
    email = e;
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

/** 살아 있는(미사용·미취소·미만료) 초대 조건. t 는 invites 나 그 별칭 */
function liveOn(t: any, now: Date) {
  return and(isNull(t.usedAt), isNull(t.revokedAt), gt(t.expiresAt, now));
}

/** (expires_at, id) 가 기준보다 큰지(dir "gt")·작은지(dir "lt") */
function ranked(t: any, dir: "gt" | "lt", expiresAt: unknown, id: string) {
  const cmp = dir === "gt" ? gt : lt;
  return or(cmp(t.expiresAt, expiresAt), and(eq(t.expiresAt, expiresAt), cmp(t.id, id)));
}

type RevokeEntry = Omit<AuditEntry, "target">;

/**
 * 트랜잭션 안에서 cond 에 맞는 초대를 취소하고, 실제로 취소한 id 를 돌려준다 (Node 넷).
 * MySQL 은 RETURNING 이 없어 SELECT … FOR UPDATE 로 행을 잠근 뒤 그 id 로 UPDATE 한다. 나머지는 UPDATE … RETURNING.
 */
async function revokeWhere(h: DbHandle, tx: any, cond: SQL | undefined, now: Date): Promise<string[]> {
  const t = h.schema.invites;
  if (h.provider === "mysql") {
    const ids: string[] = (await tx.select({ id: t.id }).from(t).where(cond).for("update")).map((r: { id: string }) => r.id);
    for (const id of ids) await tx.update(t).set({ revokedAt: now }).where(and(eq(t.id, id), cond));
    return ids;
  }
  return (await tx.update(t).set({ revokedAt: now }).where(cond).returning({ id: t.id })).map((r: { id: string }) => r.id);
}

/**
 * D1 batch 용: cond 에 맞는 invites 행마다 invite.revoke 감사 한 행을 넣는 INSERT … SELECT (target = 그 행 id).
 * 같은 cond 의 UPDATE 앞에 두면 batch 가 한 번에 돌아 감사 기록 = 실제로 취소한 행이 된다. 행 검사는 auditRow 그대로다.
 */
function auditEachStatement(h: DbHandle, db: any, e: RevokeEntry, cond: SQL | undefined) {
  const a = h.schema.auditLog;
  const t = h.schema.invites;
  const row = auditRow({ ...e, target: null });
  const cols = [a.id, a.actorId, a.action, a.target, a.detail, a.ip, a.createdAt];
  const values = [
    sql`lower(hex(randomblob(16)))`,
    sql.param(row.actorId, a.actorId),
    sql.param(row.action, a.action),
    sql`${t.id}`,
    sql.param(row.detail, a.detail),
    sql.param(row.ip, a.ip),
    sql.param(row.createdAt, a.createdAt),
  ];
  return db.run(
    sql`insert into ${a} (${sql.join(cols.map((c) => sql.identifier(c.name)), sql`, `)}) select ${sql.join(values, sql`, `)} from ${t} where ${cond}`,
  );
}

/**
 * 같은 email 동시 생성 정리. 자기 행이 살아 있을 때만: 더 큰 (expires_at, id) 의 살아 있는 형제가 있으면 자기를 취소하고,
 * 없으면 더 작은 형제를 취소한다. 감사 invite.revoke {reason: "superseded"} 는 실제로 취소한 행에만.
 */
async function settleSiblings(h: DbHandle, id: string, email: string, actorId: string, ip: string | null): Promise<void> {
  const t = h.schema.invites;
  const now = new Date();
  const entry = (detail: Record<string, unknown>): RevokeEntry => ({ actorId, action: "invite.revoke", detail, ip, now });
  if (h.kind === "d1") {
    const [self] = await h.db.select({ expiresAt: t.expiresAt }).from(t).where(eq(t.id, id));
    if (!self) return;
    const o = h.schema.invites;
    // 같은 표를 서브쿼리에서 다시 읽는다 (SQLite 는 UPDATE 의 WHERE 에서 같은 표를 읽을 수 있다)
    const other = (cond: SQL | undefined) => sql`exists (select 1 from ${sql.identifier(getTableName(o))} as ${sql.identifier("o")} where ${cond})`;
    const oc = (name: string) => sql`${sql.identifier("o")}.${sql.identifier(name)}`;
    const oCols = { id: oc(o.id.name), email: oc(o.email.name), expiresAt: oc(o.expiresAt.name), usedAt: oc(o.usedAt.name), revokedAt: oc(o.revokedAt.name) };
    const enc = (v: unknown, col: any) => sql.param(v, col);
    const oLive = sql`${oCols.usedAt} is null and ${oCols.revokedAt} is null and ${oCols.expiresAt} > ${enc(now, t.expiresAt)}`;
    const selfLive = other(sql`${oCols.id} = ${id} and ${oLive}`);
    const largerLive = other(
      sql`${oCols.email} = ${email} and ${oCols.id} <> ${id} and ${oLive} and (${oCols.expiresAt} > ${enc(self.expiresAt, t.expiresAt)} or (${oCols.expiresAt} = ${enc(self.expiresAt, t.expiresAt)} and ${oCols.id} > ${id}))`,
    );
    const selfCond = and(eq(t.id, id), liveOn(t, now), largerLive);
    const smallerCond = and(eq(t.email, email), ne(t.id, id), liveOn(t, now), ranked(t, "lt", self.expiresAt, id), selfLive);
    await h.db.batch([
      auditEachStatement(h, h.db, entry({ reason: "superseded" }), selfCond),
      h.db.update(t).set({ revokedAt: now }).where(selfCond),
      auditEachStatement(h, h.db, entry({ reason: "superseded", replacedBy: id }), smallerCond),
      h.db.update(t).set({ revokedAt: now }).where(smallerCond),
    ]);
    return;
  }
  await h.db.transaction(async (tx: any) => {
    let q = tx.select({ expiresAt: t.expiresAt, usedAt: t.usedAt, revokedAt: t.revokedAt }).from(t).where(eq(t.id, id));
    if (h.provider !== "sqlite") q = q.for("update");
    const [self] = await q;
    if (!self || self.usedAt !== null || self.revokedAt !== null || new Date(self.expiresAt).getTime() <= now.getTime()) return;
    const siblings = and(eq(t.email, email), ne(t.id, id), liveOn(t, now));
    const [larger] = await tx.select({ id: t.id }).from(t).where(and(siblings, ranked(t, "gt", self.expiresAt, id))).limit(1);
    if (larger) {
      for (const x of await revokeWhere(h, tx, and(eq(t.id, id), liveOn(t, now)), now)) await auditStatement(h, { ...entry({ reason: "superseded" }), target: x }, tx);
      return;
    }
    for (const x of await revokeWhere(h, tx, and(siblings, ranked(t, "lt", self.expiresAt, id)), now)) {
      await auditStatement(h, { ...entry({ reason: "superseded", replacedBy: id }), target: x }, tx);
    }
  });
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
    c.header("Cache-Control", "no-store");
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
    const reinvite: RevokeEntry = { actorId: admin.id, action: "invite.revoke", detail: { reason: "reinvite", replacedBy: row.id }, ip, now };
    const created: AuditEntry = {
      actorId: admin.id,
      action: "invite.create",
      target: row.id,
      detail: { role: p.role, emailBound: p.email !== null, expiresInDays: p.days },
      ip,
      now,
    };
    // 같은 이메일의 살아 있는 초대
    const sameEmail = p.email === null ? null : and(eq(t.email, p.email), liveOn(t, now));
    if (h.kind === "d1") {
      await h.db.batch([
        ...(sameEmail ? [auditEachStatement(h, h.db, reinvite, sameEmail), h.db.update(t).set({ revokedAt: now }).where(sameEmail)] : []),
        h.db.insert(t).values(row),
        auditStatement(h, created),
      ]);
    } else {
      await h.db.transaction(async (tx: any) => {
        const revoked = sameEmail ? await revokeWhere(h, tx, sameEmail, now) : [];
        await tx.insert(t).values(row);
        for (const id of revoked) await auditStatement(h, { ...reinvite, target: id }, tx);
        await auditStatement(h, created, tx);
      });
    }
    c.header("Cache-Control", "no-store");
    if (p.email !== null) {
      await settleSiblings(h, row.id, p.email, admin.id, ip);
      const mine = await readInvite(h, row.id);
      if (!mine || view(mine, Date.now()).status !== "active") return c.json({ error: "invite_conflict" }, 409);
    }
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
    const entry: RevokeEntry = { actorId: admin.id, action: "invite.revoke", detail: { reason: "admin" }, ip, now };
    const open = and(eq(t.id, id), isNull(t.usedAt), isNull(t.revokedAt));
    let changed: number;
    if (h.kind === "d1") {
      // 감사 INSERT … SELECT 를 같은 조건의 UPDATE 앞에 둔다. 읽은 뒤 사용·취소됐으면 둘 다 0행이다
      const res = await h.db.batch([auditEachStatement(h, h.db, entry, open), h.db.update(t).set({ revokedAt: now }).where(open).returning({ id: t.id })]);
      changed = (res[1] as unknown[]).length;
    } else {
      changed = await h.db.transaction(async (tx: any) => {
        const n = await updatedRows(h, tx.update(t).set({ revokedAt: now }).where(open), t.id);
        if (n === 1) await auditStatement(h, { ...entry, target: id }, tx);
        return n;
      });
    }
    if (changed !== 1) return c.json({ error: "not_found" }, 404);
    const after = await readInvite(h, id);
    return c.json({ invite: view(after ?? { ...found, revokedAt: now }, now.getTime()) });
  });

  return r;
}
