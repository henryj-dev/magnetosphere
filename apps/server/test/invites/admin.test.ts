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
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(" ")));
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

describe("TC-M3.T1 관리자 초대 API", () => {
  it("TC-M3.T1.a 이메일 없는 관리자 초대는 400 admin_invite_requires_email·0행, 이메일 있으면 201·소문자 저장", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    const no = await create(admin, { role: "admin" });
    expect({ status: no.status, error: no.json?.error }).toEqual({ status: 400, error: "admin_invite_requires_email" });
    expect(await invites()).toHaveLength(0);
    const blank = await create(admin, { role: "admin", email: "   " });
    expect(blank.status).toBe(400);
    expect(await invites()).toHaveLength(0);
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
});
