// TC-A1.T2~T4 관리자 MFA 서버 흐름 — Node 진입점 + SQLite 파일 DB (pnpm test). 네 DB 동시성은 admin-mfa.db.test.ts, D1 은 admin-mfa.workers.test.ts.
//   T2 가드·부분 세션·challenge (a~e), T3 설치 직후 bootstrap·등록·복구 코드 (a~d), T4 step-up·승격·초기화·마지막 관리자·초대 수락 grant (a~d).
// 정책 수치는 시험 전용 값이다 (packages/auth/test/mfa-policy.ts). 실제 /api/auth/admin-mfa/* 와 관리 API 를 HTTP 로 부른다.
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { addActiveFactor, challengeHttp, enrollHttp, resetFactorStep, stepUpHttp, totpCode } from "../../../../packages/auth/test/mfa-fixture.ts";
import { OPS } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { ADMIN, boot, closeAll, httpCall, installAdmin, makeTestEnv, opened, post, signInCookie, sql, TEST_ENCRYPTION_KEY, tokenIn, type Running } from "../helpers.ts";

afterEach(closeAll);

const handles: DbHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
});
async function dbOf(r: Running): Promise<DbHandle> {
  const h = await connectNode(r.t.env.DATABASE_URL);
  handles.push(h);
  return h;
}

const MEMBER_PASSWORD = "member-password-1234";

async function api(r: Running, method: string, path: string, o: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return httpCall(r)(method, path, o);
}

async function addMember(h: DbHandle, email: string) {
  return OPS.addPasswordUser(h.db, h.schema, email, MEMBER_PASSWORD, "member", "active");
}

describe("TC-A1 관리자 MFA 서버 흐름 (Node·SQLite)", () => {
  it("TC-A1.T3.b 설치 → bootstrap grant → 등록 → 정상 세션. 비밀번호만·grant 없음·재사용 grant 로는 등록하지 못한다", async () => {
    const r = await boot();
    const res = await post(r, "/api/setup", { token: tokenIn(r.logs), ...ADMIN });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const setup = await res.json();
    expect(setup).toMatchObject({ ok: true, omniroute: "manual_required", mfaGrant: { grant: expect.any(String), expiresAt: expect.any(String) } });
    const grant = setup.mfaGrant.grant as string;
    // DB 에는 grant 원문이 없다
    expect(JSON.stringify(await sql(r.t, "SELECT * FROM mfa_enrollment_grant"))).not.toContain(grant);

    const cookie = await signInCookie(r, ADMIN.email, ADMIN.password);
    // 비밀번호만의 부분 세션: 관리 API 거부, 상태는 enrollment_required
    expect(await api(r, "GET", "/api/admin/users", { cookie })).toMatchObject({ status: 403, json: { error: "mfa_enrollment_required" } });
    expect((await api(r, "GET", "/api/auth/admin-mfa/status", { cookie })).json).toMatchObject({ state: "enrollment_required", recoveryRemaining: null });
    // grant 없음·틀린 grant → 403 MFA_GRANT_REQUIRED, factor 0
    for (const body of [{}, { grant: "x".repeat(43) }]) {
      expect(await api(r, "POST", "/api/auth/admin-mfa/enroll/start", { cookie, body })).toMatchObject({ status: 403, json: { code: "MFA_GRANT_REQUIRED" } });
    }
    expect(await sql(r.t, "SELECT id FROM mfa_factor")).toHaveLength(0);
    // 다른 출처·JSON 아닌 본문은 거부
    const cross = await fetch(`${r.base}/api/auth/admin-mfa/enroll/start`, { method: "POST", headers: { origin: "https://evil.example", cookie, "content-type": "application/json" }, body: JSON.stringify({ grant }) });
    expect(cross.status).toBe(403);
    expect(cross.headers.get("cache-control")).toBe("no-store");

    const enrolled = await enrollHttp(httpCall(r), cookie, grant);
    expect(enrolled.recoveryCodes).toHaveLength(10);
    expect(await api(r, "GET", "/api/admin/users", { cookie })).toMatchObject({ status: 200 });
    expect((await api(r, "GET", "/api/auth/admin-mfa/status", { cookie })).json).toMatchObject({ state: "satisfied", method: "totp", recoveryRemaining: 10 });
    // 복구 코드 원문은 DB 에 없다
    const codes = JSON.stringify(await sql(r.t, "SELECT * FROM mfa_recovery_code"));
    for (const code of enrolled.recoveryCodes) expect(codes).not.toContain(code.replace(/-/g, ""));
    // 같은 grant 로 다시 등록할 수 없다 (소비됨). 새 세션은 부분 세션이고 active factor 가 있어 grant 경로가 아니다
    const second = await signInCookie(r, ADMIN.email, ADMIN.password);
    expect(await api(r, "POST", "/api/auth/admin-mfa/enroll/start", { cookie: second, body: { grant } })).toMatchObject({ status: 403, json: { code: "MFA_REQUIRED" } });
    const [row] = await sql(r.t, "SELECT used_at FROM mfa_enrollment_grant");
    expect(row.used_at).not.toBeNull();
  });

  it("TC-A1.T3.a 정책이 없으면 설치는 토큰을 쓰기 전에 503 mfa_policy_required 이고 관리자·grant 가 생기지 않는다", async () => {
    const t = await makeTestEnv();
    delete t.env.MFA_RECOVERY_CODE_COUNT;
    const r = await boot(t);
    const token = tokenIn(r.logs);
    const res = await post(r, "/api/setup", { token, ...ADMIN });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 503, body: { error: "mfa_policy_required" } });
    expect(await sql(r.t, "SELECT 1 FROM app_settings WHERE key = 'setup_token_hash'")).toHaveLength(1);
    expect(await sql(r.t, "SELECT id FROM user")).toHaveLength(0);
    expect(await sql(r.t, "SELECT id FROM mfa_enrollment_grant")).toHaveLength(0);
    expect(r.logs.join("\n")).not.toContain("재발급 토큰");
  });

  it("TC-A1.T2.a 부분 세션은 관리 API·관리자의 회원 API·/change-password 가 거부되고, challenge 뒤에만 통과한다", async () => {
    const r = await boot();
    const admin = await installAdmin(r);
    const partial = await signInCookie(r, ADMIN.email, ADMIN.password);
    expect(await api(r, "GET", "/api/admin/users", { cookie: partial })).toMatchObject({ status: 403, json: { error: "mfa_required" } });
    expect(await api(r, "GET", "/api/admin/invites", { cookie: partial })).toMatchObject({ status: 403, json: { error: "mfa_required" } });
    expect(await api(r, "GET", "/api/me/keys", { cookie: partial })).toMatchObject({ status: 403, json: { error: "mfa_required" } });
    const change = await api(r, "POST", "/api/auth/change-password", { cookie: partial, body: { currentPassword: ADMIN.password, newPassword: "changed-password-9876" } });
    expect(change).toMatchObject({ status: 403, json: { code: "MFA_REQUIRED" } });
    expect(await api(r, "POST", "/api/auth/update-user", { cookie: partial, body: { name: "x" } })).toMatchObject({ status: 403, json: { code: "MFA_REQUIRED" } });
    // 허용 경로: get-session 은 세션을 돌려준다
    expect((await api(r, "GET", "/api/auth/get-session", { cookie: partial })).json?.user?.email).toBe("admin@example.com");
    // 틀린 코드 → 401 INVALID_MFA_CODE, 그대로 부분 세션
    expect(await api(r, "POST", "/api/auth/admin-mfa/challenge", { cookie: partial, body: { code: "000000" } })).toMatchObject({ status: 401, json: { code: "INVALID_MFA_CODE" } });
    await challengeHttp(httpCall(r), partial, admin.seed);
    expect((await api(r, "GET", "/api/admin/users", { cookie: partial })).status).toBe(200);
    expect((await api(r, "GET", "/api/me/keys", { cookie: partial })).status).not.toBe(403);
    // 비밀번호는 바뀌지 않았다 (부분 세션 때 거부)
    expect((await post(r, "/api/auth/sign-in/email", { email: ADMIN.email, password: ADMIN.password })).status).toBe(200);
    // 로그아웃은 부분 세션도 된다
    const other = await signInCookie(r, ADMIN.email, ADMIN.password);
    expect((await api(r, "POST", "/api/auth/sign-out", { cookie: other, body: {} })).status).toBe(200);
  });

  it("TC-A1.T2.b 정책 버전이 다르거나 factor 가 바뀐 옛 세션은 관리 API 직접 호출에서 거부된다", async () => {
    const r = await boot();
    const admin = await installAdmin(r);
    expect((await api(r, "GET", "/api/admin/users", { cookie: admin.cookie })).status).toBe(200);
    // 정책 버전 불일치 (배포 정책이 바뀐 것과 같은 상태)
    await sql(r.t, `UPDATE session SET mfa_policy_version = '${"0".repeat(64)}'`);
    expect(await api(r, "GET", "/api/admin/users", { cookie: admin.cookie })).toMatchObject({ status: 403, json: { error: "mfa_required" } });
    expect(await api(r, "PATCH", "/api/admin/settings/signup", { cookie: admin.cookie, body: {} })).toMatchObject({ status: 403, json: { error: "mfa_required" } });
    await challengeHttp(httpCall(r), admin.cookie, admin.seed);
    expect((await api(r, "GET", "/api/admin/users", { cookie: admin.cookie })).status).toBe(200);
    // factor 교체: 옛 factor 를 폐기하고 새 factor 를 넣으면 옛 세션의 mfa_factor_id 는 현재 factor 가 아니다
    const h = await dbOf(r);
    const [u] = await sql(r.t, "SELECT id FROM user");
    await h.db.update(h.schema.mfaFactor).set({ state: "revoked", activeSlot: null }).where(eq(h.schema.mfaFactor.userId, String(u.id)));
    await addActiveFactor(h.db, h.schema, String(u.id), TEST_ENCRYPTION_KEY);
    expect(await api(r, "GET", "/api/admin/users", { cookie: admin.cookie })).toMatchObject({ status: 403, json: { error: "mfa_required" } });
    expect(await api(r, "POST", "/api/admin/invites", { cookie: admin.cookie, body: { role: "member" } })).toMatchObject({ status: 403, json: { error: "mfa_required" } });
  });

  it("TC-A1.T4.a step-up proof 는 한 번만 쓰이고 목적·대상이 같아야 한다. 없으면 403 mfa_proof_required", async () => {
    const r = await boot();
    const admin = await installAdmin(r);
    const h = await dbOf(r);
    const x = await addMember(h, "x@example.com");
    const y = await addMember(h, "y@example.com");
    const call = httpCall(r);
    const role = (target: string, headers?: Record<string, string>) => api(r, "PATCH", `/api/admin/users/${target}/role`, { cookie: admin.cookie, body: { role: "member" }, headers });
    expect(await role(x)).toMatchObject({ status: 403, json: { error: "mfa_proof_required" } });
    const proof = await stepUpHttp(call, admin.cookie, "role.change", x);
    expect(await role(y, { "x-mfa-proof": proof })).toMatchObject({ status: 403, json: { error: "mfa_proof_invalid" } });
    const wrongPurpose = await stepUpHttp(call, admin.cookie, "admin.invite", x);
    expect(await role(x, { "x-mfa-proof": wrongPurpose })).toMatchObject({ status: 403, json: { error: "mfa_proof_invalid" } });
    // 거부된 시도는 proof 를 쓰지 않는다
    expect((await role(x, { "x-mfa-proof": proof })).status).toBe(200);
    expect(await role(x, { "x-mfa-proof": proof })).toMatchObject({ status: 403, json: { error: "mfa_proof_invalid" } });
    // 다른 세션의 proof 는 쓸 수 없다
    const other = await signInCookie(r, ADMIN.email, ADMIN.password);
    await challengeHttp(call, other, admin.seed);
    const otherProof = await stepUpHttp(call, other, "role.change", x);
    expect(await role(x, { "x-mfa-proof": otherProof })).toMatchObject({ status: 403, json: { error: "mfa_proof_invalid" } });
    // 코드로 step-up 하면 새 proof. 목적 밖 이름은 400
    await resetFactorStep(h.db, h.schema, String((await sql(r.t, "SELECT id FROM user WHERE role = 'admin'"))[0].id));
    const coded = await api(r, "POST", "/api/auth/admin-mfa/step-up", { cookie: admin.cookie, body: { purpose: "role.change", target: x, code: await totpCode(admin.seed) } });
    expect(coded.status).toBe(200);
    expect((await role(x, { "x-mfa-proof": coded.json.proof })).status).toBe(200);
    expect((await api(r, "POST", "/api/auth/admin-mfa/step-up", { cookie: admin.cookie, body: { purpose: "anything", target: x } })).status).toBe(400);
    // proof 원문은 DB 에 없다
    expect(JSON.stringify(await sql(r.t, "SELECT * FROM mfa_proof"))).not.toContain(proof);
  });

  it("TC-A1.T4.b 승격은 promotion grant 를 한 번 주고 대상은 그 grant 로만 등록한다. 초기화는 reset grant·세션 철회, 자기·bootstrap 은 409", async () => {
    const r = await boot();
    const admin = await installAdmin(r);
    const h = await dbOf(r);
    const call = httpCall(r);
    const b = await addMember(h, "b@example.com");
    const before = await signInCookie(r, "b@example.com", MEMBER_PASSWORD);
    const promoted = await api(r, "PATCH", `/api/admin/users/${b}/role`, { cookie: admin.cookie, body: { role: "admin" }, headers: { "x-mfa-proof": await stepUpHttp(call, admin.cookie, "role.change", b) } });
    expect(promoted).toMatchObject({ status: 200, json: { user: { role: "admin" }, mfaGrant: { grant: expect.any(String) } } });
    // 대상 세션은 철회됐다
    expect((await api(r, "GET", "/api/auth/get-session", { cookie: before })).json).toBeNull();
    const bCookie = await signInCookie(r, "b@example.com", MEMBER_PASSWORD);
    expect(await api(r, "GET", "/api/admin/users", { cookie: bCookie })).toMatchObject({ status: 403, json: { error: "mfa_enrollment_required" } });
    expect((await api(r, "POST", "/api/auth/admin-mfa/enroll/start", { cookie: bCookie, body: {} })).status).toBe(403);
    const bEnrolled = await enrollHttp(call, bCookie, promoted.json.mfaGrant.grant);
    expect((await api(r, "GET", "/api/admin/users", { cookie: bCookie })).status).toBe(200);

    // 초기화: 자기 자신 409 self, bootstrap 대상 409 bootstrap_admin
    const [boot0] = await sql(r.t, "SELECT id FROM user WHERE is_bootstrap_admin = 1");
    const adminId = String(boot0.id);
    const reset = async (cookie: string, target: string) =>
      api(r, "POST", `/api/admin/users/${target}/mfa-reset`, { cookie, body: {}, headers: { "x-mfa-proof": await stepUpHttp(call, cookie, "mfa.reset", target) } });
    expect(await reset(bCookie, b)).toMatchObject({ status: 409, json: { error: "self" } });
    expect(await reset(bCookie, adminId)).toMatchObject({ status: 409, json: { error: "bootstrap_admin" } });
    expect(await api(r, "POST", `/api/admin/users/${b}/mfa-reset`, { cookie: admin.cookie, body: {} })).toMatchObject({ status: 403, json: { error: "mfa_proof_required" } });
    const done = await reset(admin.cookie, b);
    expect(done).toMatchObject({ status: 200, json: { mfaGrant: { grant: expect.any(String) } } });
    expect(await OPS.mfaFactors(h.db, h.schema, b)).toEqual({ pending: 0, active: 0, revoked: 1 });
    expect((await api(r, "GET", "/api/auth/get-session", { cookie: bCookie })).json).toBeNull();
    expect(await OPS.audits(h.db, h.schema, "mfa.reset")).toBe(1);
    // 대상은 옛 seed 로 MFA 를 마칠 수 없고 reset grant 로 다시 등록한다
    const again = await signInCookie(r, "b@example.com", MEMBER_PASSWORD);
    expect((await api(r, "POST", "/api/auth/admin-mfa/challenge", { cookie: again, body: { code: await totpCode(bEnrolled.seed) } })).status).toBe(403);
    await enrollHttp(call, again, done.json.mfaGrant.grant);
    expect((await api(r, "GET", "/api/admin/users", { cookie: again })).status).toBe(200);
    // 강등은 factor 를 폐기한다
    const demoted = await api(r, "PATCH", `/api/admin/users/${b}/role`, { cookie: admin.cookie, body: { role: "member" }, headers: { "x-mfa-proof": await stepUpHttp(call, admin.cookie, "role.change", b) } });
    expect(demoted.status).toBe(200);
    expect((await OPS.mfaFactors(h.db, h.schema, b)).active).toBe(0);
  });

  it("TC-A1.T4.c 마지막 MFA 관리자는 탈퇴할 수 없고 bootstrap 관리자는 강등·초기화할 수 없다. 관리자 탈퇴는 proof 가 필요하다", async () => {
    const r = await boot();
    const admin = await installAdmin(r);
    const h = await dbOf(r);
    const call = httpCall(r);
    const b = await addMember(h, "b2@example.com");
    expect(admin.recoveryCodes).toHaveLength(10);
    const promoted = await api(r, "PATCH", `/api/admin/users/${b}/role`, { cookie: admin.cookie, body: { role: "admin" }, headers: { "x-mfa-proof": await stepUpHttp(call, admin.cookie, "role.change", b) } });
    const bCookie = await signInCookie(r, "b2@example.com", MEMBER_PASSWORD);
    await enrollHttp(call, bCookie, promoted.json.mfaGrant.grant);
    const [boot0] = await sql(r.t, "SELECT id FROM user WHERE is_bootstrap_admin = 1");
    const demoteBootstrap = await api(r, "PATCH", `/api/admin/users/${boot0.id}/role`, { cookie: bCookie, body: { role: "member" }, headers: { "x-mfa-proof": await stepUpHttp(call, bCookie, "role.change", String(boot0.id)) } });
    expect(demoteBootstrap).toMatchObject({ status: 409, json: { error: "bootstrap_admin" } });
    // 관리자 탈퇴: proof 없으면 403, 있으면 판정으로 간다
    const del = async (headers?: Record<string, string>) => api(r, "DELETE", "/api/me", { cookie: bCookie, body: { password: MEMBER_PASSWORD }, headers });
    expect(await del()).toMatchObject({ status: 403, json: { error: "mfa_proof_required" } });
    // bootstrap 관리자의 factor 가 없으면(MFA 를 쓸 수 있는 관리자가 b 하나) b 는 마지막 관리자다
    await h.db.update(h.schema.mfaFactor).set({ state: "revoked", activeSlot: null }).where(eq(h.schema.mfaFactor.userId, String(boot0.id)));
    expect(await del({ "x-mfa-proof": await stepUpHttp(call, bCookie, "admin.delete", b) })).toMatchObject({ status: 409, json: { error: "last_admin" } });
    expect((await api(r, "GET", "/api/admin/users", { cookie: bCookie })).status).toBe(200);
    // bootstrap 이 다시 MFA 를 갖추면 b 는 탈퇴할 수 있고 MFA 행이 남지 않는다
    await addActiveFactor(h.db, h.schema, String(boot0.id), TEST_ENCRYPTION_KEY);
    expect((await del({ "x-mfa-proof": await stepUpHttp(call, bCookie, "admin.delete", b) })).status).toBe(200);
    expect(await sql(r.t, `SELECT id FROM mfa_factor WHERE user_id = '${b}'`)).toHaveLength(0);
    expect(await sql(r.t, `SELECT id FROM mfa_proof WHERE user_id = '${b}'`)).toHaveLength(0);
  });

  it("TC-A1.T2.e 같은 코드로 동시에 challenge 하면 한 건만 성공한다 (SQLite)", async () => {
    const r = await boot();
    const admin = await installAdmin(r);
    // 로그인 요청 수 제한(IP 당 분당 5회) 안에서 부분 세션 넷을 만든다
    const cookies = await Promise.all(Array.from({ length: 4 }, () => signInCookie(r, ADMIN.email, ADMIN.password)));
    const h = await dbOf(r);
    await resetFactorStep(h.db, h.schema, String((await sql(r.t, "SELECT id FROM user"))[0].id));
    const code = await totpCode(admin.seed);
    const results = await Promise.all(cookies.map((cookie) => api(r, "POST", "/api/auth/admin-mfa/challenge", { cookie, body: { code } })));
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    expect(results.filter((x) => x.status !== 200).every((x) => x.status === 401 && x.json?.code === "INVALID_MFA_CODE")).toBe(true);
  });

  it("TC-A1.T2.d 실패 제한을 넘으면 지연 429(Retry-After)이고 감사·로그·오류에 비밀값이 없다", async () => {
    const r = await boot();
    const admin = await installAdmin(r);
    const partial = await signInCookie(r, ADMIN.email, ADMIN.password);
    for (let i = 0; i < 5; i++) expect((await api(r, "POST", "/api/auth/admin-mfa/challenge", { cookie: partial, body: { code: "123456" } })).status).toBe(401);
    const res = await fetch(`${r.base}/api/auth/admin-mfa/challenge`, { method: "POST", headers: { origin: "http://localhost:3000", cookie: partial, "content-type": "application/json" }, body: JSON.stringify({ code: await totpCode(admin.seed) }) });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await res.json()).code).toBe("MFA_TOO_MANY_ATTEMPTS");
    const audit = JSON.stringify(await sql(r.t, "SELECT * FROM audit_log"));
    expect(audit).toContain("mfa.enroll");
    for (const secret of [admin.seed, admin.setup.mfaGrant.grant, ...admin.recoveryCodes]) {
      expect(audit).not.toContain(secret);
      expect(r.logs.join("\n")).not.toContain(secret);
    }
  });

  it("TC-A1.T3.c 재등록은 mfa.reenroll proof 가 필요하고 다른 세션을 끊는다. 복구 코드는 한 번만 challenge 한다", async () => {
    const r = await boot();
    const admin = await installAdmin(r);
    const call = httpCall(r);
    const other = await signInCookie(r, ADMIN.email, ADMIN.password);
    // 복구 코드로 challenge: 한 번만
    expect(await api(r, "POST", "/api/auth/admin-mfa/challenge", { cookie: other, body: { recoveryCode: admin.recoveryCodes[0].toLowerCase() } })).toMatchObject({ status: 200, json: { method: "recovery" } });
    const third = await signInCookie(r, ADMIN.email, ADMIN.password);
    expect((await api(r, "POST", "/api/auth/admin-mfa/challenge", { cookie: third, body: { recoveryCode: admin.recoveryCodes[0] } })).status).toBe(401);
    expect((await api(r, "GET", "/api/auth/admin-mfa/status", { cookie: other })).json).toMatchObject({ state: "satisfied", method: "recovery", recoveryRemaining: 9 });
    // 재등록: proof 없이는 403, 있으면 새 seed → 다른 세션 삭제
    expect(await api(r, "POST", "/api/auth/admin-mfa/enroll/start", { cookie: admin.cookie, body: {} })).toMatchObject({ status: 403, json: { code: "MFA_PROOF_REQUIRED" } });
    const proof = await stepUpHttp(call, admin.cookie, "mfa.reenroll", String((await sql(r.t, "SELECT id FROM user"))[0].id));
    const start = await api(r, "POST", "/api/auth/admin-mfa/enroll/start", { cookie: admin.cookie, body: {}, headers: { "x-mfa-proof": proof } });
    expect(start.status).toBe(200);
    expect(start.json.secret).not.toBe(admin.seed);
    const confirm = await api(r, "POST", "/api/auth/admin-mfa/enroll/confirm", { cookie: admin.cookie, body: { factorId: start.json.factorId, code: await totpCode(start.json.secret) } });
    expect(confirm.status).toBe(200);
    expect((await api(r, "GET", "/api/auth/get-session", { cookie: other })).json).toBeNull();
    expect((await api(r, "GET", "/api/admin/users", { cookie: admin.cookie })).status).toBe(200);
    // 옛 seed 로는 더 이상 MFA 를 마치지 못한다
    const fresh = await signInCookie(r, ADMIN.email, ADMIN.password);
    expect((await api(r, "POST", "/api/auth/admin-mfa/challenge", { cookie: fresh, body: { code: await totpCode(admin.seed, { offsetSteps: 1 }) } })).status).toBe(401);
    // 복구 코드 재발급은 proof 가 필요하고 옛 코드는 모두 폐기된다
    expect((await api(r, "POST", "/api/auth/admin-mfa/recovery-codes/regenerate", { cookie: admin.cookie, body: {} })).status).toBe(403);
  });

  it("TC-A1.T3.d bootstrap grant 재발급은 active factor 가 없는 동안 Node 재발급 토큰으로 한 번만 된다", async () => {
    const first = await boot();
    const res = await post(first, "/api/setup", { token: tokenIn(first.logs), ...ADMIN });
    expect(res.status).toBe(201);
    await first.close();
    opened.splice(opened.indexOf(first), 1);
    const again = await boot(first.t);
    const token = again.logs.join("\n").match(/재발급 토큰: (\S+)/)?.[1];
    expect(token).toBeTruthy();
    expect(again.logs.join("\n")).not.toContain("설치 토큰");
    const reissue = (t: string) => post(again, "/api/setup/mfa-grant", { token: t });
    expect((await reissue("wrong-token")).status).toBe(401);
    const ok = await reissue(token!);
    expect(ok.status).toBe(201);
    const body = await ok.json();
    expect((await reissue(token!)).status).toBe(401);
    // 옛 bootstrap grant 는 취소되고 새 grant 로 등록한다
    const cookie = await signInCookie(again, ADMIN.email, ADMIN.password);
    await enrollHttp(httpCall(again), cookie, body.mfaGrant.grant);
    expect((await api(again, "GET", "/api/admin/users", { cookie })).status).toBe(200);
  });

  it("TC-A1.T2.c 정책이 없으면 관리자 가드·관리자의 회원 API·challenge 가 모두 503 으로 닫힌다 (fail-closed)", async () => {
    const t = await makeTestEnv();
    delete t.env.MFA_TOTP_ALGORITHM;
    const r = await boot(t);
    const h = await dbOf(r);
    await OPS.addPasswordUser(h.db, h.schema, "solo-admin@example.com", MEMBER_PASSWORD, "admin", "active");
    const cookie = await signInCookie(r, "solo-admin@example.com", MEMBER_PASSWORD);
    expect(await api(r, "GET", "/api/admin/users", { cookie })).toMatchObject({ status: 503, json: { error: "mfa_policy_unavailable" } });
    expect(await api(r, "GET", "/api/me/keys", { cookie })).toMatchObject({ status: 503, json: { error: "mfa_policy_unavailable" } });
    expect((await api(r, "GET", "/api/auth/admin-mfa/status", { cookie })).json).toMatchObject({ state: "policy_unavailable", policy: null });
    expect(await api(r, "POST", "/api/auth/admin-mfa/challenge", { cookie, body: { code: "123456" } })).toMatchObject({ status: 503, json: { code: "MFA_POLICY_UNAVAILABLE" } });
    // 회원은 정책과 관계없이 회원 API 를 쓴다
    await OPS.addPasswordUser(h.db, h.schema, "plain@example.com", MEMBER_PASSWORD, "member", "active");
    expect((await api(r, "GET", "/api/me/keys", { cookie: await signInCookie(r, "plain@example.com", MEMBER_PASSWORD) })).status).not.toBe(503);
  });

  it("TC-A1.T4.d 이메일 지정 관리자 초대를 수락하면 응답에 등록 grant 가 한 번 있고, 그 grant 로만 등록한다. 회원 초대에는 없다", async () => {
    const r = await boot();
    const admin = await installAdmin(r);
    const h = await dbOf(r);
    await OPS.setSetting(h.db, h.schema, "signup_mode", "invite_only");
    const call = httpCall(r);
    const invite = async (body: Record<string, unknown>, headers?: Record<string, string>) => api(r, "POST", "/api/admin/invites", { cookie: admin.cookie, body, headers });
    expect(await invite({ email: "new-admin@example.com", role: "admin" })).toMatchObject({ status: 403, json: { error: "mfa_proof_required" } });
    const created = await invite({ email: "new-admin@example.com", role: "admin" }, { "x-mfa-proof": await stepUpHttp(call, admin.cookie, "admin.invite", "new-admin@example.com") });
    expect(created.status).toBe(201);
    const token = String(created.json.link).split("#")[1];
    const accepted = await fetch(`${r.base}/api/invites/accept`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ token, email: "new-admin@example.com", name: "새 관리자", password: MEMBER_PASSWORD }) });
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    const body = await accepted.json();
    expect(body).toEqual({ emailVerified: true, mfaGrant: { grant: expect.any(String), expiresAt: expect.any(String) } });
    expect(JSON.stringify(await sql(r.t, "SELECT * FROM mfa_enrollment_grant"))).not.toContain(body.mfaGrant.grant);
    expect(await OPS.audits(h.db, h.schema, "mfa.grant_issue")).toBe(2);
    const cookie = await signInCookie(r, "new-admin@example.com", MEMBER_PASSWORD);
    expect(await api(r, "GET", "/api/admin/users", { cookie })).toMatchObject({ status: 403, json: { error: "mfa_enrollment_required" } });
    expect((await api(r, "POST", "/api/auth/admin-mfa/enroll/start", { cookie, body: {} })).status).toBe(403);
    await enrollHttp(call, cookie, body.mfaGrant.grant);
    expect((await api(r, "GET", "/api/admin/users", { cookie })).status).toBe(200);
    // 회원 초대 수락에는 grant 가 없다
    const memberInvite = await invite({ email: "new-member@example.com", role: "member" });
    const memberToken = String(memberInvite.json.link).split("#")[1];
    const memberAccepted = await fetch(`${r.base}/api/invites/accept`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ token: memberToken, email: "new-member@example.com", name: "회원", password: MEMBER_PASSWORD }) });
    expect(await memberAccepted.json()).toEqual({ emailVerified: true });
  });

  it("TC-A1.T4.f 다른 관리자의 정지·삭제는 대상에 묶은 proof 가 필요하고, 관리자 초대 proof 는 초대 이메일에 묶인다 (보안 리뷰 M1·L3)", async () => {
    const r = await boot();
    const admin = await installAdmin(r);
    const h = await dbOf(r);
    const call = httpCall(r);
    const promote = async (email: string) => {
      const id = await addMember(h, email);
      const p = await api(r, "PATCH", `/api/admin/users/${id}/role`, { cookie: admin.cookie, body: { role: "admin" }, headers: { "x-mfa-proof": await stepUpHttp(call, admin.cookie, "role.change", id) } });
      await enrollHttp(call, await signInCookie(r, email, MEMBER_PASSWORD), p.json.mfaGrant.grant);
      return id;
    };
    const b = await promote("f-b@example.com");
    const c = await promote("f-c@example.com");
    const proof = async (purpose: string, target: string) => ({ "x-mfa-proof": await stepUpHttp(call, admin.cookie, purpose, target) });
    const suspend = (target: string, headers?: Record<string, string>) => api(r, "POST", `/api/admin/users/${target}/suspend`, { cookie: admin.cookie, body: {}, headers });
    const remove = (target: string, headers?: Record<string, string>) => api(r, "DELETE", `/api/admin/users/${target}`, { cookie: admin.cookie, headers });
    const statusOf = async (id: string) => String((await sql(r.t, `SELECT status FROM user WHERE id = '${id}'`))[0].status);

    // 관리자 대상: proof 없음 403 required, 다른 대상·다른 목적 403 invalid. 거부는 아무것도 쓰지 않고 proof 도 남는다
    expect(await suspend(b)).toMatchObject({ status: 403, json: { error: "mfa_proof_required" } });
    expect(await remove(b)).toMatchObject({ status: 403, json: { error: "mfa_proof_required" } });
    const forB = await proof("admin.suspend", b);
    expect(await suspend(c, forB)).toMatchObject({ status: 403, json: { error: "mfa_proof_invalid" } });
    expect(await suspend(b, await proof("admin.delete", b))).toMatchObject({ status: 403, json: { error: "mfa_proof_invalid" } });
    expect(await remove(b, await proof("admin.suspend", b))).toMatchObject({ status: 403, json: { error: "mfa_proof_invalid" } });
    expect([await statusOf(b), await statusOf(c)]).toEqual(["active", "active"]);
    expect(await OPS.audits(h.db, h.schema, "member.suspend")).toBe(0);
    // 맞는 proof 는 한 번만 쓰인다
    expect((await suspend(b, forB)).status).toBe(200);
    expect(await statusOf(b)).toBe("suspended");
    expect((await api(r, "POST", `/api/admin/users/${b}/unsuspend`, { cookie: admin.cookie, body: {} })).status).toBe(200);
    expect(await suspend(b, forB)).toMatchObject({ status: 403, json: { error: "mfa_proof_invalid" } });
    expect((await remove(c, await proof("admin.delete", c))).status).toBe(200);
    expect(await statusOf(c)).toBe("deleted");
    // 회원 대상은 proof 없이 된다 (proof 는 관리자 대상만)
    const m = await addMember(h, "f-m@example.com");
    expect((await suspend(m)).status).toBe(200);
    expect((await remove(m)).status).toBe(200);

    // 관리자 초대 proof 는 정규화한 초대 이메일에 묶인다: 다른 이메일 403 invalid, 대소문자·공백 차이는 같은 대상
    await OPS.setSetting(h.db, h.schema, "signup_mode", "invite_only");
    const invite = (email: string, headers?: Record<string, string>) => api(r, "POST", "/api/admin/invites", { cookie: admin.cookie, body: { email, role: "admin" }, headers });
    const forOne = await proof("admin.invite", "one@example.com");
    expect(await invite("two@example.com", forOne)).toMatchObject({ status: 403, json: { error: "mfa_proof_invalid" } });
    expect(await sql(r.t, "SELECT id FROM invites WHERE role = 'admin'")).toHaveLength(0);
    expect((await invite("  One@Example.com ", forOne)).status).toBe(201);
    expect(await invite("one@example.com", forOne)).toMatchObject({ status: 403, json: { error: "mfa_proof_invalid" } });
  });
});
