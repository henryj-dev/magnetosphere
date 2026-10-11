// 관리자 초대 API (3단계 실행판 M3.T1) — 앱 전체, SQLite 파일 DB (pnpm test). 세션은 가짜 인증(routes/env.ts)이고
// 역할·상태는 DB 에서 읽는다. 단언은 실행판 TC-M3.T1.a~f 그대로다. g·h·i 는 checks.ts 를 네 DB 판(admin.db.test.ts)과 함께 쓴다.
//   DELETE 는 살아 있는(미사용·미취소) 초대만 취소한다. 없는 id·이미 취소한 초대·이미 사용한 초대는 404 not_found 이고
//   아무것도 바뀌지 않으며 감사 기록도 남지 않는다.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, call, openRoutes, type RouteEnv } from "../routes/env.ts";
import { NODE_AND_D1, tcM3T1g, tcM3T1h, tcM3T1i } from "./checks.ts";

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

  it("TC-M3.T1.g 감사 기록은 실제 변경과 같다: 읽은 뒤 사용·취소된 초대의 DELETE 는 404·감사 0행, 재초대 invite.revoke 는 실제로 취소된 행만 (Node SQLite·D1 경로)", () => tcM3T1g(e, NODE_AND_D1));

  it("TC-M3.T1.h 같은 이메일 동시 재초대 → 살아 있는 초대 1개 (승자는 (expires_at, id) 가 큰 쪽, 진 쪽은 409 invite_conflict·링크 없음) (Node SQLite·D1 경로)", () => tcM3T1h(e, NODE_AND_D1));

  it("TC-M3.T1.i 실제 동시 POST(Promise.all) — 빈 표 같은 이메일 2개·같은 이메일 4·8개·서로 다른 이메일 12개, 회차 3: 500 0, 같은 이메일은 살아 있는 초대 1개 = 201 하나(해시 일치)·나머지 201 은 뒤에 취소·409 invite_conflict 링크 없음·감사 = 실제 취소, 다른 이메일은 모두 201·이메일마다 1개, expires_at 왕복 일치 (Node SQLite)", async () => {
    await tcM3T1i(e);
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
