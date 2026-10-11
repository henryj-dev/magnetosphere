// 관리자 초대 API (3단계 실행판 M3.T1) — 앱 전체, SQLite 파일 DB (pnpm test). 세션은 가짜 인증(routes/env.ts)이고
// 역할·상태는 DB 에서 읽는다. 단언은 실행판 TC-M3.T1.a~f 그대로다.
//   DELETE 는 살아 있는(미사용·미취소) 초대만 취소한다. 없는 id·이미 취소한 초대·이미 사용한 초대는 404 not_found 이고
//   아무것도 바뀌지 않으며 감사 기록도 남지 않는다.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, call, openRoutes, type RouteEnv } from "../routes/env.ts";

const BASE = "https://llm.example.com";
const DAY = 86_400_000;

let e: RouteEnv;
let printed: string[];
beforeEach(async () => {
  e = await openRoutes();
  printed = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.map((x) => (x instanceof Error ? `${x.message}\n${(x as any).cause?.message ?? ""}` : String(x))).join(" ")));
  }
  await setRaw("public_base_url", BASE);
  await setRaw("mail_settings", { provider: "resend", from: "noreply@example.com", apiKey: "enc" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await e?.close();
});

/** app_settings 한 행을 그대로 쓴다 (정책 검사 없이, 시험 준비용). value undefined 면 지운다 */
async function setRaw(key: string, value: unknown) {
  const t = e.h.schema.appSettings;
  await e.h.db.delete(t).where(eq(t.key, key));
  if (value !== undefined) await e.h.db.insert(t).values({ key, value: JSON.stringify(value), updatedAt: new Date(), updatedBy: null });
}

const invites = () => e.h.db.select().from(e.h.schema.invites);
const audits = (action: string) => e.h.db.select().from(e.h.schema.auditLog).where(eq(e.h.schema.auditLog.action, action));
const create = (user: string, body: unknown, origin?: string | null) => call(e, "POST", "/api/admin/invites", { user, body, origin });
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : new Date(v as string | number).getTime());

/**
 * 끼어들기 장치. 같은 DB 에 앱을 하나 더 띄우되, 그 앱의 db.transaction·db.batch 를 부를 때마다 queue 의 앞 함수를 먼저 부른다
 * (읽은 뒤 쓰기 전에 다른 요청이 초대를 차지·취소·추가한 상황). d1 이면 DbHandle.kind 를 "d1" 로 바꿔 D1 경로(batch)를 탄다.
 * Node SQLite 드라이버(libsql)도 drizzle batch 를 지원한다 — 실제 D1 런타임은 아니다.
 */
async function interleaved(d1: boolean) {
  const queue: (undefined | (() => Promise<void>))[] = [];
  const target = e.h.db;
  const db = new Proxy(target, {
    get(o, p, r) {
      if (p === "transaction" || p === "batch") {
        const f = o[p].bind(o);
        return async (...a: unknown[]) => {
          const before = queue.shift();
          if (before) await before();
          return f(...a);
        };
      }
      return Reflect.get(o, p, r);
    },
  });
  const app = await openRoutes({ h: { ...e.h, db, kind: d1 ? "d1" : e.h.kind } });
  return { app, queue };
}
const VARIANTS = [
  ["Node SQLite", false],
  ["D1 경로(libsql batch)", true],
] as const;
/** 시험 준비용 초대 행을 바로 넣는다 */
async function rawInvite(o: { email: string | null; createdBy: string; expiresAt?: Date; usedAt?: Date | null; revokedAt?: Date | null }) {
  const id = crypto.randomUUID();
  await e.h.db.insert(e.h.schema.invites).values({
    id,
    email: o.email,
    tokenHash: createHash("sha256").update(id).digest("hex"),
    role: "member",
    expiresAt: o.expiresAt ?? new Date(Date.now() + 7 * DAY),
    usedAt: o.usedAt ?? null,
    usedBy: null,
    createdBy: o.createdBy,
    revokedAt: o.revokedAt ?? null,
  });
  return id;
}
const inviteById = async (id: string) => (await e.h.db.select().from(e.h.schema.invites).where(eq(e.h.schema.invites.id, id)))[0];

describe("TC-M3.T1 관리자 초대 API", () => {
  it("TC-M3.T1.a 이메일 없는 관리자 초대는 400 admin_invite_requires_email·0행, 이메일 있으면 201·소문자 저장", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    const no = await create(admin, { role: "admin" });
    expect({ status: no.status, error: no.json?.error }).toEqual({ status: 400, error: "admin_invite_requires_email" });
    expect(await invites()).toHaveLength(0);
    // 공백뿐인 문자열은 "없음"이 아니라 잘못된 이메일이다 (역할과 무관)
    for (const role of ["admin", "member"]) {
      const blank = await create(admin, { role, email: "   " });
      expect({ role, status: blank.status, error: blank.json?.error }).toEqual({ role, status: 400, error: "invalid_email" });
    }
    // 제어문자·공백·특수문자가 든 주소는 400 invalid_email
    for (const email of ["a\u0000b@x.com", "a\u007f@x.com", "a b@x.com", "a\n@x.com", "<a@x.com>", "a,b@x.com", "a;b@x.com", "a:b@x.com", 'a"b@x.com', "a[b]@x.com", "a\\b@x.com", "a(b)@x.com", "a@@x.com", "a@x", `${"a".repeat(250)}@x.com`]) {
      const r = await create(admin, { role: "member", email });
      expect({ email, status: r.status, error: r.json?.error }).toEqual({ email, status: 400, error: "invalid_email" });
    }
    expect(await invites()).toHaveLength(0);
    // NFC 로 정규화해 저장한다 (분해형 é → 합성형)
    const nfc = await create(admin, { role: "member", email: "José@x.com" });
    expect(nfc.status, nfc.text).toBe(201);
    expect(nfc.json.invite.email).toBe("josé@x.com");
    await e.h.db.delete(e.h.schema.invites);
    const ok = await create(admin, { role: "admin", email: " A@x.com " });
    expect(ok.status, ok.text).toBe(201);
    const rows = await invites();
    expect(rows).toHaveLength(1);
    expect({ email: rows[0].email, role: rows[0].role, createdBy: rows[0].createdBy }).toEqual({ email: "a@x.com", role: "admin", createdBy: admin });
    expect(ok.json.invite).toMatchObject({ id: rows[0].id, email: "a@x.com", role: "admin" });
    // 잘못된 역할·이메일 형식은 400, 행 그대로
    for (const b of [{ role: "owner", email: "b@x.com" }, { email: "b@x.com" }, { role: "member", email: "not-an-email" }, { role: "member", email: 3 }]) {
      expect((await create(admin, b)).status, JSON.stringify(b)).toBe(400);
    }
    expect(await invites()).toHaveLength(1);
  });

  it("TC-M3.T1.b 원문 토큰은 201 응답 링크에만 있다: token_hash == sha256(t), DB·로그·감사 기록에 t 0건, Cache-Control no-store", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    const r = await create(admin, { role: "member", email: "tok@example.com" });
    expect(r.status, r.text).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const link: string = r.json.link;
    expect(link.startsWith(`${BASE}/invite#`)).toBe(true);
    const tok = link.slice(`${BASE}/invite#`.length);
    // 32바이트 base64url = 43자
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await invites();
    expect(row.tokenHash).toBe(createHash("sha256").update(tok).digest("hex"));
    // DB 덤프: 파일 전체(WAL 포함)와 모든 표의 행
    const file = e.t.env.DATABASE_URL.replace(/^file:/, "");
    for (const f of [file, `${file}-wal`]) {
      let bytes = "";
      try {
        bytes = readFileSync(f).toString("latin1");
      } catch {
        // WAL 파일이 없을 수 있다
      }
      expect(bytes.includes(tok), f).toBe(false);
    }
    const dump: unknown[] = [];
    for (const table of Object.values(e.h.schema) as any[]) {
      try {
        dump.push(await e.h.db.select().from(table));
      } catch {
        // 표가 아닌 내보내기
      }
    }
    expect(JSON.stringify(dump).includes(tok)).toBe(false);
    const audit = await e.h.db.select().from(e.h.schema.auditLog);
    expect(audit.filter((a: any) => a.action === "invite.create")).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(tok);
    expect(JSON.stringify(audit)).not.toContain("/invite");
    expect(JSON.stringify(audit)).not.toContain("tok@example.com");
    expect([...e.logs, ...printed].join("\n")).not.toContain(tok);
    // 목록에는 토큰도 해시도 없다
    const list = await call(e, "GET", "/api/admin/invites", { user: admin });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(list.text).not.toContain(tok);
    expect(list.text).not.toContain(row.tokenHash);
    expect(list.json.invites).toHaveLength(1);
  });

  it("TC-M3.T1.c 만료: 없음 → now+7일, 30 → 201, 31·0·1.5·문자열 → 400", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    const t0 = Date.now();
    const d = await create(admin, { role: "member", email: "c7@example.com" });
    const t1 = Date.now();
    expect(d.status, d.text).toBe(201);
    const [row] = await invites();
    // 저장 정밀도(초)만큼 여유를 둔다
    expect(ms(row.expiresAt)).toBeGreaterThanOrEqual(Math.floor(t0 / 1000) * 1000 + 7 * DAY);
    expect(ms(row.expiresAt)).toBeLessThanOrEqual(t1 + 7 * DAY);
    const thirty = await create(admin, { role: "member", email: "c30@example.com", expiresInDays: 30 });
    expect(thirty.status, thirty.text).toBe(201);
    expect(ms(thirty.json.invite.expiresAt) - Date.now()).toBeGreaterThan(29.9 * DAY);
    expect(ms(thirty.json.invite.expiresAt) - Date.now()).toBeLessThanOrEqual(30 * DAY);
    for (const x of [31, 0, 1.5, "7", -1, null]) {
      const r = await create(admin, { role: "member", email: "cx@example.com", expiresInDays: x });
      expect({ x, status: r.status, error: r.json?.error }).toEqual({ x, status: 400, error: "invalid_expires" });
    }
    expect(await invites()).toHaveLength(2);
  });

  it("TC-M3.T1.d 세션 없음 401, 회원 403, 정지된 관리자 403, 다른 출처 403 forbidden_origin, 활성 관리자 201", async () => {
    const member = await addUser(e.h);
    const suspended = await addUser(e.h, { role: "admin", status: "suspended" });
    const admin = await addUser(e.h, { role: "admin" });
    const b = { role: "member", email: "d@example.com" };
    expect((await call(e, "POST", "/api/admin/invites", { body: b })).status).toBe(401);
    expect((await create(member, b)).status).toBe(403);
    expect((await create(suspended, b)).status).toBe(403);
    const cross = await create(admin, b, "https://evil.example");
    expect({ status: cross.status, error: cross.json?.error }).toEqual({ status: 403, error: "forbidden_origin" });
    expect((await create(admin, b, null)).status).toBe(403);
    expect(await invites()).toHaveLength(0);
    // 목록·취소도 같다
    expect((await call(e, "GET", "/api/admin/invites")).status).toBe(401);
    expect((await call(e, "GET", "/api/admin/invites", { user: member })).status).toBe(403);
    expect((await call(e, "GET", "/api/admin/invites", { user: suspended })).status).toBe(403);
    const ok = await create(admin, b);
    expect(ok.status, ok.text).toBe(201);
    const id = ok.json.invite.id;
    expect((await call(e, "DELETE", `/api/admin/invites/${id}`)).status).toBe(401);
    expect((await call(e, "DELETE", `/api/admin/invites/${id}`, { user: member })).status).toBe(403);
    expect((await call(e, "DELETE", `/api/admin/invites/${id}`, { user: suspended })).status).toBe(403);
    expect((await call(e, "DELETE", `/api/admin/invites/${id}`, { user: admin, origin: "https://evil.example" })).status).toBe(403);
    expect((await invites())[0].revokedAt).toBeNull();
    // 요청 수 제한: 관리자당 분당 30회. 앞에서 활성 관리자는 1회(201)를 썼다
    for (let i = 0; i < 29; i++) expect((await call(e, "GET", "/api/admin/invites", { user: admin })).status).toBe(200);
    const limited = await create(admin, { role: "member", email: "d2@example.com" });
    expect({ status: limited.status, error: limited.json?.error }).toEqual({ status: 429, error: "rate_limited" });
    expect(await invites()).toHaveLength(1);
    // 다른 관리자는 따로 센다
    const other = await addUser(e.h, { role: "admin" });
    expect((await create(other, { role: "member", email: "d3@example.com" })).status).toBe(201);
  });

  it("TC-M3.T1.e closed·sso_only → 409 signup_closed, 메일 없음 + email 없음 → 409 mail_required, 메일 없음 + email 있음 → 201", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    for (const m of ["closed", "sso_only"]) {
      await setRaw("signup_mode", m);
      for (const b of [{ role: "member" }, { role: "member", email: "e@example.com" }, { role: "admin", email: "e@example.com" }]) {
        const r = await create(admin, b);
        expect({ m, b, status: r.status, error: r.json?.error }).toEqual({ m, b, status: 409, error: "signup_closed" });
      }
    }
    expect(await invites()).toHaveLength(0);
    await setRaw("signup_mode", "invite_only");
    await setRaw("mail_settings", undefined);
    const no = await create(admin, { role: "member" });
    expect({ status: no.status, error: no.json?.error }).toEqual({ status: 409, error: "mail_required" });
    const nul = await create(admin, { role: "member", email: null });
    expect({ status: nul.status, error: nul.json?.error }).toEqual({ status: 409, error: "mail_required" });
    // 공백뿐인 email 은 "없음"으로 보지 않는다 → 400 invalid_email (mail_required 아님)
    const blank = await create(admin, { role: "member", email: "  " });
    expect({ status: blank.status, error: blank.json?.error }).toEqual({ status: 400, error: "invalid_email" });
    expect(await invites()).toHaveLength(0);
    const yes = await create(admin, { role: "member", email: "e@example.com" });
    expect(yes.status, yes.text).toBe(201);
    // 대조: 메일이 있으면 이메일 없는 링크도 만든다
    await setRaw("mail_settings", { provider: "resend", from: "noreply@example.com", apiKey: "enc" });
    const open = await create(admin, { role: "member" });
    expect(open.status, open.text).toBe(201);
    expect(open.json.invite.email).toBeNull();
    // 설치 전(public_base_url 없음)에는 링크를 만들 수 없다
    await setRaw("public_base_url", undefined);
    const pre = await create(admin, { role: "member", email: "pre@example.com" });
    expect({ status: pre.status, error: pre.json?.error }).toEqual({ status: 409, error: "setup_required" });
    expect(await invites()).toHaveLength(2);
    expect(await audits("invite.create")).toHaveLength(2);
  });

  it("TC-M3.T1.f DELETE → revoked_at·invite.revoke 1행, 같은 이메일 두 번 POST → 미사용 초대 1개(앞 것 revoked_at)", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    const a = await create(admin, { role: "member", email: "f-del@example.com" });
    expect(a.status, a.text).toBe(201);
    const del = await call(e, "DELETE", `/api/admin/invites/${a.json.invite.id}`, { user: admin });
    expect(del.status, del.text).toBe(200);
    expect(del.json.invite.revokedAt).not.toBeNull();
    const [row] = await invites();
    expect(row.revokedAt).not.toBeNull();
    const revokes = await audits("invite.revoke");
    expect(revokes).toHaveLength(1);
    expect({ actor: revokes[0].actorId, target: revokes[0].target }).toEqual({ actor: admin, target: a.json.invite.id });
    // 이미 취소한 초대·없는 id 는 404, 감사 기록 그대로
    expect((await call(e, "DELETE", `/api/admin/invites/${a.json.invite.id}`, { user: admin })).status).toBe(404);
    expect((await call(e, "DELETE", `/api/admin/invites/no-such-id`, { user: admin })).status).toBe(404);
    expect(await audits("invite.revoke")).toHaveLength(1);

    // 같은 이메일(대소문자만 다름) 두 번 → 살아 있는 초대 1개
    const first = await create(admin, { role: "member", email: "f-twice@example.com" });
    const second = await create(admin, { role: "admin", email: "F-Twice@Example.com" });
    expect([first.status, second.status]).toEqual([201, 201]);
    const same = (await invites()).filter((r: any) => r.email === "f-twice@example.com");
    expect(same).toHaveLength(2);
    const live = same.filter((r: any) => r.usedAt === null && r.revokedAt === null);
    expect(live.map((r: any) => r.id)).toEqual([second.json.invite.id]);
    expect(same.find((r: any) => r.id === first.json.invite.id)!.revokedAt).not.toBeNull();
    expect(await audits("invite.revoke")).toHaveLength(2);

    // 사용한 초대는 취소하지 않는다 (404, 행 그대로)
    await e.h.db.update(e.h.schema.invites).set({ usedAt: new Date() }).where(eq(e.h.schema.invites.id, second.json.invite.id));
    expect((await call(e, "DELETE", `/api/admin/invites/${second.json.invite.id}`, { user: admin })).status).toBe(404);
    const [used] = await e.h.db.select().from(e.h.schema.invites).where(eq(e.h.schema.invites.id, second.json.invite.id));
    expect(used.revokedAt).toBeNull();

    // 목록: 토큰·해시 없이 상태가 보인다
    const list = await call(e, "GET", "/api/admin/invites", { user: admin });
    expect(list.status).toBe(200);
    const byId = Object.fromEntries(list.json.invites.map((i: any) => [i.id, i]));
    expect(byId[a.json.invite.id].status).toBe("revoked");
    expect(byId[first.json.invite.id].status).toBe("revoked");
    expect(byId[second.json.invite.id].status).toBe("used");
    for (const i of list.json.invites) expect(Object.keys(i).sort()).toEqual(["createdBy", "email", "expiresAt", "id", "revokedAt", "role", "status", "usedAt", "usedBy"]);
  });

  it("TC-M3.T1.g 감사 기록은 실제 변경과 같다: 읽은 뒤 사용·취소된 초대의 DELETE 는 404·감사 0행, 재초대 invite.revoke 는 실제로 취소된 행만 (Node SQLite·D1 경로)", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    for (const [label, d1] of VARIANTS) {
      const { app, queue } = await interleaved(d1);
      try {
        const revokes = async () => (await audits("invite.revoke")).map((a: any) => a.target as string).sort();
        const before = await revokes();
        // DELETE: 읽은 뒤 다른 요청이 사용(수락)·취소한다
        for (const claim of ["usedAt", "revokedAt"] as const) {
          const id = await rawInvite({ email: `g-del-${claim}-${d1}@example.com`, createdBy: admin });
          queue.push(async () => void (await e.h.db.update(e.h.schema.invites).set({ [claim]: new Date() }).where(eq(e.h.schema.invites.id, id))));
          const del = await call(app, "DELETE", `/api/admin/invites/${id}`, { user: admin });
          expect({ label, claim, status: del.status, error: del.json?.error }).toEqual({ label, claim, status: 404, error: "not_found" });
          expect(await revokes(), `${label} ${claim}`).toEqual(before);
          const row = await inviteById(id);
          if (claim === "usedAt") expect(row.revokedAt, label).toBeNull();
        }
        // 재초대: 앞서 살아 있던 A 를 읽은 뒤 A 는 사용되고, 같은 이메일 B 가 끼어든다
        const email = `g-re-${d1}@example.com`;
        const a = await rawInvite({ email, createdBy: admin });
        let b = "";
        queue.push(async () => {
          await e.h.db.update(e.h.schema.invites).set({ usedAt: new Date() }).where(eq(e.h.schema.invites.id, a));
          b = await rawInvite({ email, createdBy: admin });
        });
        const re = await call(app, "POST", "/api/admin/invites", { user: admin, body: { role: "member", email } });
        expect(re.status, `${label} ${re.text}`).toBe(201);
        expect((await inviteById(a)).revokedAt, `${label} 사용한 A 는 취소되지 않는다`).toBeNull();
        expect((await inviteById(b)).revokedAt, `${label} 끼어든 B 는 취소된다`).not.toBeNull();
        const added = (await revokes()).filter((x: string) => !before.includes(x));
        expect({ label, revoked: added }).toEqual({ label, revoked: [b] });
      } finally {
        await app.close();
      }
    }
  });

  it("TC-M3.T1.h 같은 이메일 동시 재초대 → 살아 있는 초대 1개 (승자는 (expires_at, id) 가 큰 쪽, 진 쪽은 409 invite_conflict·링크 없음) (Node SQLite·D1 경로)", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    const liveOf = async (email: string) => (await invites()).filter((r: any) => r.email === email && r.usedAt === null && r.revokedAt === null && ms(r.expiresAt) > Date.now());
    const supersededTargets = async () =>
      (await audits("invite.revoke")).filter((a: any) => JSON.parse(a.detail).reason === "superseded").map((a: any) => a.target as string).sort();
    for (const [label, d1] of VARIANTS) {
      const { app, queue } = await interleaved(d1);
      try {
        // 내 트랜잭션이 커밋된 뒤, 정리 전에 서로의 취소를 못 본 동시 요청의 초대가 생긴다 (첫 번째 호출 = 만들기, 두 번째 = 정리)
        // 더 큰 형제(만료 30일) → 나는 진다
        const big = `h-big-${d1}@example.com`;
        let sib = "";
        queue.push(undefined, async () => void (sib = await rawInvite({ email: big, createdBy: admin, expiresAt: new Date(Date.now() + 30 * DAY) })));
        const lose = await call(app, "POST", "/api/admin/invites", { user: admin, body: { role: "member", email: big } });
        expect({ label, status: lose.status, error: lose.json?.error, link: lose.json?.link }).toEqual({ label, status: 409, error: "invite_conflict", link: undefined });
        expect(lose.text).not.toContain("/invite#");
        expect((await liveOf(big)).map((r: any) => r.id), label).toEqual([sib]);
        // 더 작은 형제(만료 1일) → 내가 이기고 형제를 취소한다
        const small = `h-small-${d1}@example.com`;
        let low = "";
        const before = await supersededTargets();
        queue.push(undefined, async () => void (low = await rawInvite({ email: small, createdBy: admin, expiresAt: new Date(Date.now() + DAY) })));
        const win = await call(app, "POST", "/api/admin/invites", { user: admin, body: { role: "member", email: small } });
        expect(win.status, `${label} ${win.text}`).toBe(201);
        expect((await liveOf(small)).map((r: any) => r.id), label).toEqual([win.json.invite.id]);
        expect((await inviteById(low)).revokedAt, label).not.toBeNull();
        const added = (await supersededTargets()).filter((x: string) => !before.includes(x));
        expect(added.includes(low), label).toBe(true);
        // 진 요청의 자기 행은 취소됐고 superseded 감사가 있다. 이긴 형제(sib)에는 취소 기록이 없다
        const loser = (await invites()).filter((r: any) => r.email === big && r.id !== sib);
        expect(loser.map((r: any) => r.revokedAt !== null), label).toEqual([true]);
        const targets = await supersededTargets();
        expect([targets.includes(loser[0].id), targets.includes(sib)], label).toEqual([true, false]);
      } finally {
        await app.close();
      }
    }
    // 실제로 겹친 요청 여럿: 살아 있는 초대는 정확히 1개이고 그것은 201 을 받은 것 중 하나다
    const email = "h-many@example.com";
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => create(admin, { role: "member", email, expiresInDays: 1 + (i % 3) })));
    expect(rs.every((r) => r.status === 201 || (r.status === 409 && r.json?.error === "invite_conflict" && r.json?.link === undefined)), rs.map((r) => r.text).join("\n")).toBe(true);
    const live = await liveOf(email);
    expect(live).toHaveLength(1);
    expect(rs.filter((r) => r.status === 201).map((r) => r.json.invite.id)).toContain(live[0].id);
  });
});

describe("초대 API 주변 (M3.T1 보안 리뷰 L4·L6)", () => {
  it("L4 DB 쿼리 오류는 쿼리 문과 원인 메시지만 기록하고 params(이메일·token_hash)는 남기지 않는다", async () => {
    const { createApp } = await import("../../src/app.ts");
    const params = ["leak@example.com", "deadbeefcafebabe-token-hash"];
    const err = Object.assign(new Error(`Failed query: insert into "invites" values (?, ?)\nparams: ${params.join(",")}`), {
      query: 'insert into "invites" values (?, ?)',
      params,
      cause: new Error("UNIQUE constraint failed: invites.token_hash"),
    });
    const app = createApp({
      services: async () => {
        throw err;
      },
      assets: async (c) => c.text("spa"),
      setupTokenFromSecret: false,
      log: () => {},
    });
    const res = await app.request("http://localhost:3000/api/admin/invites");
    expect(res.status).toBe(500);
    const out = printed.join("\n");
    expect(out).toContain('insert into "invites" values (?, ?)');
    expect(out).toContain("UNIQUE constraint failed: invites.token_hash");
    for (const p of params) expect(out).not.toContain(p);
  });

  it("L6 public_base_url 은 http(s)·사용자 정보·쿼리·조각 없음만 받고 origin + pathname(끝 슬래시 뗌)을 쓴다", async () => {
    const { readPublicBaseUrl } = await import("../../src/invites/base-url.ts");
    const cases: [unknown, string | null][] = [
      ["https://llm.example.com/", "https://llm.example.com"],
      ["https://LLM.example.com/base/", "https://llm.example.com/base"],
      [" http://llm.example.com:8080 ", "http://llm.example.com:8080"],
      ["https://user:pw@llm.example.com", null],
      ["https://user@llm.example.com", null],
      ["https://llm.example.com/?x=1", null],
      ["https://llm.example.com/#frag", null],
      ["javascript:alert(1)", null],
      ["ftp://llm.example.com", null],
      ["not a url", null],
      [42, null],
    ];
    for (const [value, want] of cases) {
      await setRaw("public_base_url", value);
      expect({ value, got: await readPublicBaseUrl(e.h) }).toEqual({ value, got: want });
    }
    await setRaw("public_base_url", undefined);
    expect(await readPublicBaseUrl(e.h)).toBeNull();
  });
});
