// 관리자 초대 API (3단계 실행판 M3.T1, 계획서 4.2, Q3·Q4·Q5).
//   POST   /api/admin/invites { email?, role, expiresInDays? } → 201 { invite, link }   (Cache-Control: no-store)
//   GET    /api/admin/invites                                   → 200 { invites }         (Cache-Control: no-store)
//   DELETE /api/admin/invites/:id                               → 200 { invite } · 404 not_found
//   - 활성 관리자만 (routes/guard.ts sessionAdmin, 역할·상태는 DB). 변경 요청의 같은 출처 검사는 app.ts 가 /api/admin/* 에 건다.
//     요청 수 제한은 세 경로를 합쳐 관리자당 분당 30회 (넘으면 429 rate_limited).
//   - 토큰: 32바이트 무작위 base64url. DB 에는 SHA-256 16진(token_hash)만 둔다. 원문은 201 응답의 링크
//     <public_base_url>/invite#<토큰> 에만 한 번 나간다. 조각(#)이라 서버 접근 기록에 남지 않는다. 감사 기록·로그에는 토큰·링크·이메일을 넣지 않는다.
//   - 규칙: role 은 member|admin. admin 이면 email 필수(400 admin_invite_requires_email, 링크가 새도 관리자 권한이 넘어가지 않게).
//     email 은 필드 없음·null 만 "없음"이다. 문자열이면 trim → 소문자 → NFC 뒤 형식 검사(빈 문자열·제어·서식 문자(\p{Cc}\p{Cf})·공백·
//     <>(),;:"[]\ ·점으로 시작하는 도메인은 400 invalid_email). expiresInDays 는 정수 1~30 (기본 7, 그 밖 400 invalid_expires).
//     정책 closed·sso_only 면 409 signup_closed, 설치 전(public_base_url 없음) 409 setup_required,
//     메일 설정 없음(mail_settings 행 없음, 가입 판정과 같은 기준) + email 없음이면 409 mail_required.
//   - 새 초대는 같은 email 의 살아 있는(미사용·미만료·미취소) 초대를 대체한다: 그것들을 취소하고 새로 만든다. 취소·새 초대·감사 기록은
//     한 트랜잭션(D1 은 batch)이다. invite.revoke {reason: "reinvite", replacedBy} 는 실제로 취소한 행에만 남는다.
//   - 초대 만들기는 직렬화한다. 같은 email 의 동시 요청이 서로의 취소를 못 보면 살아 있는 초대가 둘 남고, invites.email 에 인덱스가 없어
//     email 조건 잠금은 MySQL·MariaDB 에서 표 전체를 잠가 교착이 난다. 그래서 job_leases 의 고정 행(INVITE_MUTEX)을 뮤텍스로 쓴다:
//     행은 트랜잭션 밖에서 먼저 만들어 두고(INSERT IGNORE / ON CONFLICT DO NOTHING, 자동 커밋 — 트랜잭션 안에서 넣으면 MySQL 이 공유 잠금을
//     배타 잠금으로 올리다 교착한다), Node 쓰기 트랜잭션(READ COMMITTED 명시)의 첫 잠금으로 SELECT … FOR UPDATE 한다 (pg·mysql·mariadb).
//     pg 는 그 앞에 SET LOCAL lock_timeout 5s 를 둔다 (넘으면 500).
//     SQLite 는 프로세스 안 쓰기 차례와 쓰기 잠금 하나로, D1 은 batch 가 한 번에 돌아 이미 직렬이다.
//     직렬이므로 모든 성공은 201 이다. 먼저 커밋된 201 의 링크는 뒤 요청이 취소한다 (차례로 재초대한 것과 같다).
//   - DELETE 는 미사용·미취소 초대만 취소한다(만료한 초대도 취소할 수 있다). 없는 id·이미 취소·이미 사용한 초대는 404 not_found 이고
//     아무것도 쓰지 않는다. 읽은 뒤 다른 요청이 사용·취소했어도 404 이고 감사 기록이 없다. 기본 키 한 행만 잠그므로 뮤텍스를 쓰지 않는다.
//     취소와 감사 기록 invite.revoke 는 한 트랜잭션(D1 은 batch)이다.
//   - 목록에는 토큰·해시를 넣지 않는다. invites 에 created_at 이 없어 만료 시각 늦은 순이다.
import { and, desc, eq, getTableColumns, gt, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
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
/**
 * 초대 쓰기 뮤텍스: job_leases 의 이 이름 행. 주기 작업 임대(acquireLease)는 만료했거나 같은 holder 일 때만 행을 가져가므로
 * locked_until 을 먼 미래로 둬 임대로 잡히지 않게 한다. 행은 지우지 않는다 (job_leases 를 지우는 코드는 없다).
 */
export const INVITE_MUTEX = { name: "invite_write_mutex", holder: "invites", lockedUntil: new Date("2999-12-31T00:00:00.000Z") } as const;
const DAY_MS = 86_400_000;
// 이메일 각 부분에 올 수 없는 글자: 공백(유니코드 포함)·@·<>(),;:"[]\·제어 문자(\p{Cc})·서식 문자(\p{Cf}, 너비 없는 글자·방향 표시 등)
const NOT_IN_EMAIL = String.raw`\s@<>(),;:"\[\]\\\p{Cc}\p{Cf}`;
// 도메인은 점으로 시작할 수 없다
const EMAIL = new RegExp(`^[^${NOT_IN_EMAIL}]+@(?!\\.)[^${NOT_IN_EMAIL}]+\\.[^${NOT_IN_EMAIL}]+$`, "u");
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

/** 이메일 정규화·형식 검사 (trim → 소문자 → NFC). 형식이 틀리면 null. 초대 수락(accept.ts)도 같은 규칙으로 본문 이메일을 비교한다 */
export function normalizeInviteEmail(v: string): string | null {
  const e = v.trim().toLowerCase().normalize("NFC");
  return e.length <= EMAIL_MAX && EMAIL.test(e) ? e : null;
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
    email = normalizeInviteEmail(b.email);
    if (email === null) return { error: "invalid_email" };
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
function liveOn(t: any, now: Date) {
  return and(isNull(t.usedAt), isNull(t.revokedAt), gt(t.expiresAt, now));
}

/** 뮤텍스 행을 둔다 (트랜잭션 밖, 자동 커밋). 이미 있으면 아무것도 하지 않는다. pg·mysql·mariadb 만 쓴다 */
async function ensureInviteMutex(h: DbHandle): Promise<void> {
  const t = h.schema.jobLeases;
  const row = { name: INVITE_MUTEX.name, holder: INVITE_MUTEX.holder, lockedUntil: INVITE_MUTEX.lockedUntil, fence: 0 };
  if (h.provider === "mysql") await h.db.insert(t).ignore().values(row);
  else await h.db.insert(t).values(row).onConflictDoNothing();
}

/**
 * 뮤텍스를 잡는 트랜잭션의 격리 수준. 기본값(pg READ COMMITTED, InnoDB REPEATABLE READ)에 기대지 않고 명시한다.
 * pg REPEATABLE READ 처럼 트랜잭션 시작 스냅숏을 보는 격리에서는 뮤텍스를 기다리는 동안 커밋된 앞 초대를 못 봐 살아 있는 초대가 둘 남는다.
 * drizzle 은 pg 에서 SET TRANSACTION, mysql2 에서 BEGIN 앞 SET TRANSACTION ISOLATION LEVEL 로 보낸다.
 */
export const INVITE_TX = { isolationLevel: "read committed" } as const;
/** pg 뮤텍스 대기 상한. 넘으면 lock_timeout 오류로 500 이다. MySQL·MariaDB 는 innodb_lock_wait_timeout(기본 50초)을 쓴다 */
export const INVITE_PG_LOCK_TIMEOUT = "5s";

/** 트랜잭션의 첫 잠금: 뮤텍스 행 배타 잠금. 커밋·되돌리기까지 다른 초대 만들기가 기다린다. pg 는 그 앞에 대기 상한을 둔다 */
async function lockInviteMutex(h: DbHandle, tx: any): Promise<void> {
  const t = h.schema.jobLeases;
  if (h.provider === "pg") await tx.execute(sql.raw(`set local lock_timeout = '${INVITE_PG_LOCK_TIMEOUT}'`));
  const got = await tx.select({ name: t.name }).from(t).where(eq(t.name, INVITE_MUTEX.name)).for("update");
  if (got.length !== 1) throw new Error("초대 뮤텍스 행이 없다");
}

/**
 * 트랜잭션 안에서 cond 에 맞는 초대를 취소하고, 실제로 취소한 id 를 돌려준다 (Node 넷, 뮤텍스를 쥔 채로).
 * sqlite·pg 는 UPDATE … RETURNING. MySQL 은 RETURNING 이 없어 맞는 id 를 읽고 id 마다 같은 조건으로 UPDATE 해 바뀐 것만 센다
 * (email 조건 잠금 읽기는 인덱스가 없어 표 전체를 잠그므로 쓰지 않는다. 각 UPDATE 는 기본 키 한 행만 잠근다).
 */
async function revokeWhere(h: DbHandle, tx: any, cond: SQL | undefined, now: Date): Promise<string[]> {
  const t = h.schema.invites;
  if (h.provider === "mysql") {
    const ids: string[] = (await tx.select({ id: t.id }).from(t).where(cond)).map((r: { id: string }) => r.id);
    const out: string[] = [];
    for (const id of ids) if ((await updatedRows(h, tx.update(t).set({ revokedAt: now }).where(and(eq(t.id, id), cond)), t.id)) === 1) out.push(id);
    return out;
  }
  return (await tx.update(t).set({ revokedAt: now }).where(cond).returning({ id: t.id })).map((r: { id: string }) => r.id);
}

export type RevokeEntry = Omit<AuditEntry, "target">;

/** SQLite 식: UUID v4 꼴 무작위 id (D1 감사 행 id 를 auditRow 가 만드는 crypto.randomUUID() 와 같은 꼴로) */
const SQLITE_UUID = sql.raw(
  "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || " +
    "substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))",
);

/**
 * D1 batch 용: cond 에 맞는 invites 행마다 감사 한 행(e.action, 취소면 invite.revoke·수락이면 invite.accept)을 넣는 INSERT … SELECT (target = 그 행 id).
 * 같은 cond 의 UPDATE 앞에 두면 batch 가 한 번에 돌아 감사 기록 = 실제로 취소한 행이 된다. 행 검사는 auditRow 그대로다.
 */
export function auditEachStatement(h: DbHandle, db: any, e: RevokeEntry, cond: SQL | undefined) {
  const a = h.schema.auditLog;
  const t = h.schema.invites;
  const row = auditRow({ ...e, target: null });
  const values: Record<string, SQLWrapper> = {
    id: SQLITE_UUID,
    actorId: sql.param(row.actorId, a.actorId),
    action: sql.param(row.action, a.action),
    target: sql`${t.id}`,
    detail: sql.param(row.detail, a.detail),
    ip: sql.param(row.ip, a.ip),
    createdAt: sql.param(row.createdAt, a.createdAt),
  };
  // insert().select(SQL) 은 표 정의 순서의 모든 칼럼으로 INSERT 한다. 값도 그 순서로 맞춘다.
  // db.run(sql) 원시 문장은 D1 batch 항목이 되지 못한다 (drizzle d1 session.batch 가 stmt.bind 를 부른다) — 쿼리 빌더 문장이어야 한다
  const order = Object.keys(getTableColumns(a)).map((k) => {
    const v = values[k];
    if (!v) throw new Error(`audit_log 칼럼 ${k} 의 값이 없다`);
    return v;
  });
  return db.insert(a).select(sql`select ${sql.join(order, sql`, `)} from ${t} where ${cond}`);
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
    // 같은 이메일의 살아 있는 초대. MySQL·MariaDB 의 기본 정렬은 악센트를 무시하므로 정규화 뒤 바이트가 같은 주소만 고른다.
    // 다른 DB 는 기존 eq 그대로다. 취소와 재초대 감사는 이 조건을 같이 쓴다.
    const sameEmail = p.email === null ? null : and(h.provider === "mysql" ? sql`${t.email} = cast(${p.email} as binary)` : eq(t.email, p.email), liveOn(t, now));
    if (h.kind === "d1") {
      await h.db.batch([
        ...(sameEmail ? [auditEachStatement(h, h.db, reinvite, sameEmail), h.db.update(t).set({ revokedAt: now }).where(sameEmail)] : []),
        h.db.insert(t).values(row),
        auditStatement(h, created),
      ]);
    } else {
      const locking = h.provider !== "sqlite";
      if (locking) await ensureInviteMutex(h);
      const body = async (tx: any) => {
        if (locking) await lockInviteMutex(h, tx);
        const revoked = sameEmail ? await revokeWhere(h, tx, sameEmail, now) : [];
        await tx.insert(t).values(row);
        for (const id of revoked) await auditStatement(h, { ...reinvite, target: id }, tx);
        await auditStatement(h, created, tx);
      };
      await (locking ? h.db.transaction(body, INVITE_TX) : h.db.transaction(body));
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
