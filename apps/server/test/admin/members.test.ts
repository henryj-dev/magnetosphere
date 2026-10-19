// TC-M4.T1 회원 관리 API — SQLite 파일 DB 와 가짜 인증·가짜 OmniRoute (pnpm test).
// 공용 app.ts 라우팅은 이 시험이 소유하지 않는다. memberAdminRoutes 를 독립 Hono 에 싣고, 변경 요청에는 라우트가 기대하는
// sameOrigin 을 시험 fixture 가 직접 건다. 따라서 이 파일의 통과는 운영 앱 연결 완료를 뜻하지 않는다.
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as keyApplication from "../../src/keys/apply.ts";
import { memberAdminRoutes } from "../../src/admin/members.ts";
import { AUTH_VERSION_MAX } from "../../src/admin/guard-sql.ts";
import { sameOrigin } from "../../src/routes/guard.ts";
import { addUser, call, fakeAuth, fakeMfa, mfaAdminSession, openRoutes, type CallOpts, type RouteEnv } from "../routes/env.ts";

let e: RouteEnv;
let clientMode: "available" | "absent" | "throws";
beforeEach(async () => {
  e = await openRoutes();
  clientMode = "available";
  const baseAuth = fakeAuth();
  // 관리자 MFA (A1): 시험 정책 런타임. 관리자 세션은 mfaAdminSession 이 MFA 충족으로 만든다
  const mfa = await fakeMfa(e.h);
  const services = async () => ({
    mfa,
    db: e.h,
    auth: { async handler(req: Request) {
      const res = await baseAuth.handler(req);
      const body = await res.clone().json().catch(() => null) as { user?: { id?: string } } | null;
      return body?.user?.id ? Response.json({ ...body, session: { id: body.user.id } }) : res;
    } },
    cipher: {}, omniroute: { baseUrl: null, initialPassword: null }, clientIp: async () => "203.0.113.7", appOrigin: "http://localhost:3000", keysClient: async () => { if (clientMode === "throws") throw new Error("client unavailable"); return clientMode === "absent" ? null : () => e.om.client(); },
  });
  const standalone = new Hono();
  standalone.use("/api/admin/*", sameOrigin(services as never));
  standalone.route("/api/admin", memberAdminRoutes(services as never));
  e.app = { request: standalone.request.bind(standalone) } as typeof e.app;
});
afterEach(async () => { vi.restoreAllMocks(); await e?.close(); });

const users = () => e.h.db.select().from(e.h.schema.user);
/** 관리자 세션 (id = 회원 id). 관리자 MFA 를 마친 세션이다 (A1, routes/env.ts mfaAdminSession) */
const sessionFor = (userId: string) => mfaAdminSession(e.h, userId);
const audits = (action: string) => e.h.db.select().from(e.h.schema.auditLog).where(eq(e.h.schema.auditLog.action, action));
const api = (method: string, path: string, o: CallOpts = {}) => call(e, method, path, o);

describe("TC-M4.T1 회원 목록·상태 API", () => {
  it("TC-M4.T1.a 목록은 허용 목록 50개·cursor 이고 status 밖 값과 큰 cursor 는 400", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    await sessionFor(admin);
    for (let i = 0; i < 51; i++) await addUser(e.h, { status: i % 2 ? "pending" : "active" });
    const page = await api("GET", "/api/admin/users", { user: admin });
    expect(page.status).toBe(200);
    expect(page.json.users).toHaveLength(50);
    expect(Object.keys(page.json.users[0]).sort()).toEqual(["createdAt", "email", "emailVerified", "id", "isBootstrapAdmin", "name", "role", "status"]);
    expect(page.json.nextCursor).toEqual(expect.any(String));
    const next = await api("GET", `/api/admin/users?cursor=${encodeURIComponent(page.json.nextCursor)}`, { user: admin });
    expect(next.json.users).toHaveLength(2);
    expect(next.json.nextCursor).toBeNull();
    const expected = await e.h.db.select({ id: e.h.schema.user.id }).from(e.h.schema.user).orderBy(asc(e.h.schema.user.createdAt), asc(e.h.schema.user.id));
    const ids = [...page.json.users, ...next.json.users].map((row: { id: string }) => row.id);
    expect(ids).toEqual(expected.map((row: { id: string }) => row.id));
    expect(new Set(ids).size).toBe(52);
    expect(next.json.users.map((row: { id: string }) => row.id)).toEqual(expected.slice(50).map((row: { id: string }) => row.id));
    expect(page.json.nextCursor).toBe(`${page.json.users[49].createdAt}|${page.json.users[49].id}`);
    expect((await api("GET", "/api/admin/users?status=invited", { user: admin })).status).toBe(400);
    expect((await api("GET", `/api/admin/users?cursor=${"x".repeat(81)}`, { user: admin })).status).toBe(400);
  });

  it("TC-M4.T1.b 승인·거절·정지·해제·역할은 transition 과 CAS 를 따르고 세션·감사를 한 결과로 남긴다", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    await sessionFor(admin);
    const pending = await addUser(e.h, { status: "pending" });
    await e.h.db.insert(e.h.schema.session).values({ id: randomUUID(), expiresAt: new Date(Date.now() + 60_000), token: randomUUID(), createdAt: new Date(), updatedAt: new Date(), userId: pending });
    const approved = await api("POST", `/api/admin/users/${pending}/approve`, { user: admin });
    expect(approved.status).toBe(200);
    expect((await users()).find((row: any) => row.id === pending)?.status).toBe("active");
    expect(await e.h.db.select().from(e.h.schema.session).where(eq(e.h.schema.session.userId, pending))).toHaveLength(0);
    expect(await audits("member.approve")).toHaveLength(1);
    const rejected = await addUser(e.h, { status: "pending" });
    expect((await api("POST", `/api/admin/users/${rejected}/reject`, { user: admin })).json.deleted).toBe(true);
    expect((await users()).some((row: any) => row.id === rejected)).toBe(false);
    const active = await addUser(e.h);
    expect((await api("POST", `/api/admin/users/${active}/suspend`, { user: admin })).status).toBe(200);
    expect((await api("POST", `/api/admin/users/${active}/unsuspend`, { user: admin })).status).toBe(200);
    expect((await api("PATCH", `/api/admin/users/${active}/role`, { user: admin, body: { role: "admin" } })).status).toBe(200);
    expect((await api("PATCH", `/api/admin/users/${active}/role`, { user: admin, body: { role: "owner" } })).status).toBe(400);
  });

  it("TC-M4.T1.c 권한·CSRF·요청 수·bootstrap·자기 정지·마지막 관리자를 구분한다", async () => {
    const member = await addUser(e.h);
    const admin = await addUser(e.h, { role: "admin" });
    await sessionFor(admin);
    const pending = await addUser(e.h, { status: "pending" });
    expect((await api("POST", `/api/admin/users/${pending}/approve`)).status).toBe(401);
    expect((await api("POST", `/api/admin/users/${pending}/approve`, { user: member })).status).toBe(403);
    expect((await api("POST", `/api/admin/users/${pending}/approve`, { user: admin, origin: "https://evil.example" })).status).toBe(403);
    await e.h.db.update(e.h.schema.user).set({ isBootstrapAdmin: true }).where(eq(e.h.schema.user.id, admin));
    expect((await api("POST", `/api/admin/users/${admin}/suspend`, { user: admin })).json.error).toBe("bootstrap_admin");
    const other = await addUser(e.h, { role: "admin" });
    await sessionFor(other);
    expect((await api("POST", `/api/admin/users/${other}/suspend`, { user: other })).json.error).toBe("self");
    expect((await api("POST", `/api/admin/users/${admin}/suspend`, { user: other })).json.error).toBe("bootstrap_admin");
    expect((await api("POST", `/api/admin/users/${pending}/approve`, { user: other })).status).toBe(200);
    for (let i = 0; i < 27; i++) expect((await api("POST", `/api/admin/users/${pending}/approve`, { user: other })).status).toBe(409);
    expect((await api("POST", `/api/admin/users/${pending}/approve`, { user: other })).status).toBe(429);
  });

  it("TC-M4.T1.d stale actor 는 401/403, 권한 있는 마지막 관리자 제거는 409, 버전 상한은 증가하지 않는다", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    await sessionFor(admin);
    const other = await addUser(e.h, { role: "admin" });
    await sessionFor(other);
    await e.h.db.update(e.h.schema.user).set({ status: "suspended" }).where(eq(e.h.schema.user.id, admin));
    expect([401, 403]).toContain((await api("POST", `/api/admin/users/${other}/suspend`, { user: admin })).status);
    await e.h.db.update(e.h.schema.user).set({ status: "active" }).where(eq(e.h.schema.user.id, admin));
    await e.h.db.update(e.h.schema.user).set({ status: "active", authVersion: AUTH_VERSION_MAX }).where(eq(e.h.schema.user.id, other));
    const exhausted = await api("POST", `/api/admin/users/${other}/suspend`, { user: admin });
    expect(exhausted.status).toBe(409);
    expect(exhausted.json.error).toBe("version_exhausted");
    expect(await audits("member.suspend")).toHaveLength(0);
    expect(await e.h.db.select().from(e.h.schema.session).where(eq(e.h.schema.session.userId, other))).toHaveLength(1);
    expect((await users()).find((row: any) => row.id === other)?.authVersion).toBe(AUTH_VERSION_MAX);
  });

  it("TC-M4.T1.e 정지·해제는 DB 커밋 후 K3 를 호출하고 외부 실패는 pending 이다", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    await sessionFor(admin);
    const target = await addUser(e.h);
    const key = await e.h.db.insert(e.h.schema.apiKeys).values({ id: randomUUID(), userId: target, omnirouteKeyId: randomUUID(), keyPreview: "abcd", state: "active", createdAt: new Date() }).returning();
    e.om.fail.setKeyActive = [new Error("omni down")];
    const suspended = await api("POST", `/api/admin/users/${target}/suspend`, { user: admin });
    expect(suspended.json.sync).toBe("pending");
    expect((await users()).find((row: any) => row.id === target)?.status).toBe("suspended");
    expect(e.om.of("setKeyActive")).toHaveLength(1);
    expect(key).toBeDefined();
    const [mapping] = await e.h.db.select().from(e.h.schema.apiKeys).where(eq(e.h.schema.apiKeys.id, key[0].id));
    expect(mapping.syncState).toBe("pending");
    const jobs = await e.h.db.select().from(e.h.schema.omnirouteJobs).where(and(eq(e.h.schema.omnirouteJobs.keyId, key[0].id), eq(e.h.schema.omnirouteJobs.action, "key.apply_state")));
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].payload)).toEqual({ keyId: key[0].id });
  });

  it.each(["absent", "throws", "applyThrows"] as const)("TC-M4.T1.e 클라이언트/반영 %s 때 커밋 뒤 pending과 기존 재시도 작업을 남긴다", async (mode) => {
    if (mode === "applyThrows") vi.spyOn(keyApplication, "applyKey").mockRejectedValueOnce(new Error("unexpected apply failure"));
    else clientMode = mode;
    const admin = await addUser(e.h, { role: "admin" });
    await sessionFor(admin);
    const target = await addUser(e.h);
    const keyId = randomUUID();
    await e.h.db.insert(e.h.schema.apiKeys).values({ id: keyId, userId: target, omnirouteKeyId: randomUUID(), keyPreview: "abcd", state: "active", createdAt: new Date() });
    const response = await api("POST", `/api/admin/users/${target}/suspend`, { user: admin });
    expect(response.status).toBe(200);
    expect(response.json.sync).toBe("pending");
    expect((await users()).find((row: any) => row.id === target)?.status).toBe("suspended");
    expect(e.om.of("setKeyActive")).toHaveLength(0);
    const [mapping] = await e.h.db.select().from(e.h.schema.apiKeys).where(eq(e.h.schema.apiKeys.id, keyId));
    expect(mapping.syncState).toBe("pending");
    const jobs = await e.h.db.select().from(e.h.schema.omnirouteJobs).where(and(eq(e.h.schema.omnirouteJobs.keyId, keyId), eq(e.h.schema.omnirouteJobs.action, "key.apply_state")));
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].payload)).toEqual({ keyId });
  });

  it("TC-M4.T1.f 거절 전이 검사가 실패하면 감사·회원 쓰기가 없다", async () => {
    const admin = await addUser(e.h, { role: "admin" });
    await sessionFor(admin);
    const target = await addUser(e.h, { status: "active" });
    const before = await audits("member.reject");
    expect((await api("POST", `/api/admin/users/${target}/reject`, { user: admin })).status).toBe(409);
    expect(await audits("member.reject")).toEqual(before);
    expect(await users()).toHaveLength(2);
  });
});
