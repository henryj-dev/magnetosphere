// TC-A1 관리자 MFA 공용 단언 (T2.f·T3.e·T4.e 는 다섯 DB, T6.a 는 D1 전체 흐름). Node 네 DB(admin-mfa.db.test.ts, signup/env.ts serverRig)와 D1(admin-mfa.workers.test.ts, signup/d1-rig.ts)이
// 같은 함수를 부른다. 두 Rig 모두 운영과 같은 createApp + buildServices(진짜 Better Auth)이고 정책은 시험 전용 값이다.
import { expect } from "vitest";
import { enrollHttp, totpCode } from "../../../../packages/auth/test/mfa-fixture.ts";
import { mail, PASSWORD } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { installed, login, mfaCall, proofHeader, type HttpRig } from "../signup/checks.ts";
import { TEST_SECRET } from "../helpers.ts";

const cookieOf = (setCookie: string[]) => setCookie.map((c) => c.split(";")[0]).join("; ");

async function signIn(rig: HttpRig, email: string): Promise<string> {
  const r = await rig.call("POST", "/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`로그인 실패 ${r.status}`);
  return cookieOf(r.setCookie);
}

/** TC-A1.T2.f 같은 관리자의 부분 세션 여섯이 같은 코드로 동시에 challenge → 정확히 1건 200, 나머지 401 INVALID_MFA_CODE. 실패 세션은 관리 API 403 */
export async function tcA1T2f(rig: HttpRig) {
  await installed(rig);
  const admin = await login(rig, "admin");
  const cookies: string[] = [];
  for (let i = 0; i < 6; i++) cookies.push(await signIn(rig, admin.email));
  await rig.op("mfaResetStep", admin.id);
  const code = await totpCode();
  const results = await Promise.all(cookies.map((cookie) => rig.call("POST", "/api/auth/admin-mfa/challenge", { cookie, body: { code } })));
  expect(results.filter((r) => r.status >= 500).map((r) => r.status)).toEqual([]);
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(results.filter((r) => r.status !== 200).every((r) => r.status === 401 && r.json?.code === "INVALID_MFA_CODE")).toBe(true);
  const statuses = await Promise.all(cookies.map(async (cookie) => (await rig.call("GET", "/api/admin/users", { cookie })).status));
  expect(statuses.sort()).toEqual([200, 403, 403, 403, 403, 403]);

  // 같은 계정·같은 IP 의 연속 실패: 제한(5)까지는 401, 그 다음은 지연 429 (실패 칸 UPDATE 경로를 DB 마다 지난다)
  const ip = "198.18.250.7";
  const partial = cookieOf((await rig.call("POST", "/api/auth/sign-in/email", { body: { email: admin.email, password: PASSWORD }, ip })).setCookie);
  const wrong = [];
  for (let i = 0; i < 6; i++) wrong.push(await rig.call("POST", "/api/auth/admin-mfa/challenge", { cookie: partial, body: { code: "000000" }, ip }));
  expect(wrong.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 429]);
  expect(wrong[5].json?.code).toBe("MFA_TOO_MANY_ATTEMPTS");

  // 같은 계정·IP 를 바꾼 실패: IP 마다 제한(5) 안이어도 계정 칸 제한(20)을 넘으면 새 IP 에서도 429 (보안 리뷰 L2)
  const spread = await login(rig, "admin", "active", { mfa: false });
  const spreadWrong = [];
  for (let i = 0; i < 20; i++) spreadWrong.push((await rig.call("POST", "/api/auth/admin-mfa/challenge", { cookie: spread.cookie, body: { code: "000000" }, ip: `198.18.251.${Math.floor(i / 4) + 1}` })).status);
  expect(spreadWrong).toEqual(Array(20).fill(401));
  const fresh = await rig.call("POST", "/api/auth/admin-mfa/challenge", { cookie: spread.cookie, body: { code: await totpCode() }, ip: "198.18.251.99" });
  expect({ status: fresh.status, code: fresh.json?.code }).toEqual({ status: 429, code: "MFA_TOO_MANY_ATTEMPTS" });
}

/** TC-A1.T4.e 같은 proof 로 역할 변경 둘을 동시에 → 정확히 1건 200, 나머지 403 mfa_proof_invalid. 다른 목적의 proof 는 403 */
export async function tcA1T4e(rig: HttpRig) {
  await installed(rig);
  const admin = await login(rig, "admin");
  const x = await rig.op("addPasswordUser", mail("a1m-x"), PASSWORD, "member", "active");
  const wrong = await proofHeader(rig, admin.cookie, "admin.invite", x);
  expect((await rig.call("PATCH", `/api/admin/users/${x}/role`, { cookie: admin.cookie, body: { role: "member" }, headers: wrong })).json?.error).toBe("mfa_proof_invalid");
  const headers = await proofHeader(rig, admin.cookie, "role.change", x);
  const both = await Promise.all([0, 1].map(() => rig.call("PATCH", `/api/admin/users/${x}/role`, { cookie: admin.cookie, body: { role: "member" }, headers })));
  expect(both.map((r) => r.status).sort()).toEqual([200, 403]);
  expect(both.find((r) => r.status === 403)?.json?.error).toBe("mfa_proof_invalid");
  expect(await rig.op("audits", "member.role")).toBe(1);
}

/**
 * TC-A1.T6.a grant → 등록(원자 단위) → 정상 세션 → 승격(proof·promotion grant 한 단위) → 대상 등록 → 초기화(reset grant) → 관리자 초대 수락 grant → 등록.
 * 부분 세션은 관리 API 403, grant 없는 등록 403, 등록 확인은 다른 세션을 끊는다
 */
export async function tcA1T6a(rig: HttpRig) {
  await installed(rig);
  const email = mail("a1n-admin");
  const id = await rig.op("addPasswordUser", email, PASSWORD, "admin", "active");
  // 같은 DB 를 앞 시험과 함께 쓰므로 감사 행은 증가분으로 본다
  const enrollsBefore = await rig.op("audits", "mfa.enroll");
  const first = await signIn(rig, email);
  const other = await signIn(rig, email);
  expect((await rig.call("GET", "/api/admin/users", { cookie: first })).json?.error).toBe("mfa_enrollment_required");
  expect((await rig.call("POST", "/api/auth/admin-mfa/enroll/start", { cookie: first, body: {} })).json?.code).toBe("MFA_GRANT_REQUIRED");
  const grant = await rig.op("mfaGrant", id, TEST_SECRET, "transition");
  await enrollHttp(mfaCall(rig), first, grant);
  expect((await rig.call("GET", "/api/admin/users", { cookie: first })).status).toBe(200);
  expect((await rig.call("GET", "/api/auth/get-session", { cookie: other })).json).toBeNull();
  expect(await rig.op("audits", "mfa.enroll")).toBe(enrollsBefore + 1);

  const memberEmail = mail("a1n-member");
  const member = await rig.op("addPasswordUser", memberEmail, PASSWORD, "member", "active");
  const promoted = await rig.call("PATCH", `/api/admin/users/${member}/role`, { cookie: first, body: { role: "admin" }, headers: await proofHeader(rig, first, "role.change", member) });
  expect(promoted.status).toBe(200);
  expect(promoted.json?.mfaGrant?.grant).toEqual(expect.any(String));
  const target = await signIn(rig, memberEmail);
  expect((await rig.call("GET", "/api/admin/users", { cookie: target })).json?.error).toBe("mfa_enrollment_required");
  const enrolled = await enrollHttp(mfaCall(rig), target, promoted.json.mfaGrant.grant);
  expect((await rig.call("GET", "/api/admin/users", { cookie: target })).status).toBe(200);

  const reset = await rig.call("POST", `/api/admin/users/${member}/mfa-reset`, { cookie: first, body: {}, headers: await proofHeader(rig, first, "mfa.reset", member) });
  expect(reset.status).toBe(200);
  expect(await rig.op("mfaFactors", member)).toMatchObject({ active: 0 });
  expect((await rig.call("GET", "/api/auth/get-session", { cookie: target })).json).toBeNull();
  const again = await signIn(rig, memberEmail);
  expect((await rig.call("POST", "/api/auth/admin-mfa/challenge", { cookie: again, body: { code: await totpCode(enrolled.seed) } })).status).toBe(403);
  await enrollHttp(mfaCall(rig), again, reset.json.mfaGrant.grant);
  expect((await rig.call("GET", "/api/admin/users", { cookie: again })).status).toBe(200);

  // 관리자 초대 수락: 응답의 등록 grant 로만 등록한다 (같은 원자 단위에서 발급, D1 은 guard batch)
  await rig.op("setSetting", "signup_mode", "invite_only");
  await rig.op("setSetting", "public_base_url", "https://llm.example.test");
  const invited = mail("a1n-invited");
  const inv = await rig.call("POST", "/api/admin/invites", { cookie: first, body: { email: invited, role: "admin" }, headers: await proofHeader(rig, first, "admin.invite", invited) });
  expect(inv.status).toBe(201);
  const accepted = await rig.call("POST", "/api/invites/accept", { body: { token: String(inv.json.link).split("#")[1], email: invited, name: "초대 관리자", password: PASSWORD } });
  expect(accepted.status).toBe(201);
  expect(accepted.json?.mfaGrant?.grant).toEqual(expect.any(String));
  const invitedCookie = await signIn(rig, invited);
  expect((await rig.call("GET", "/api/admin/users", { cookie: invitedCookie })).json?.error).toBe("mfa_enrollment_required");
  await enrollHttp(mfaCall(rig), invitedCookie, accepted.json.mfaGrant.grant);
  expect((await rig.call("GET", "/api/admin/users", { cookie: invitedCookie })).status).toBe(200);
}

/**
 * TC-A1.T3.e 같은 pending factor·같은 코드로 등록 확인 둘을 동시에 → 정확히 1건 200, 다른 1건은 409·401·403 중 하나.
 * active factor 1·grant 소비 1·mfa.enroll 감사 1 (부분 실패로 grant 만 소비되거나 factor 가 둘이 되지 않는다)
 */
export async function tcA1T3e(rig: HttpRig) {
  await installed(rig);
  const email = mail("a1e-admin");
  const id = await rig.op("addPasswordUser", email, PASSWORD, "admin", "active");
  const enrollsBefore = await rig.op("audits", "mfa.enroll");
  const cookie = await signIn(rig, email);
  const grant = await rig.op("mfaGrant", id, TEST_SECRET, "transition");
  const start = await rig.call("POST", "/api/auth/admin-mfa/enroll/start", { cookie, body: { grant } });
  expect(start.status).toBe(200);
  const code = await totpCode(start.json.secret);
  const both = await Promise.all([0, 1].map(() => rig.call("POST", "/api/auth/admin-mfa/enroll/confirm", { cookie, body: { factorId: start.json.factorId, code, grant } })));
  expect(both.filter((r) => r.status >= 500).map((r) => r.status)).toEqual([]);
  expect(both.filter((r) => r.status === 200)).toHaveLength(1);
  expect([401, 403, 409]).toContain(both.find((r) => r.status !== 200)?.status);
  expect(await rig.op("mfaFactors", id)).toMatchObject({ active: 1, pending: 0 });
  expect(await rig.op("audits", "mfa.enroll")).toBe(enrollsBefore + 1);
  expect((await rig.call("GET", "/api/admin/users", { cookie })).status).toBe(200);
}
