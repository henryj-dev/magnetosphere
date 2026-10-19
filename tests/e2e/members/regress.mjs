// M5.T2 회원 권한 회귀 (TC-M5.T2.a·b, docs/plan/phase3-todo.md). pnpm e2e --combo docker-sqlite|workers-d1 --scenario members-regress
//
//   a  open(메일 설정) 공개 가입·초대 수락 본문에 role admin·status active·monthlyLimitUsd null·isBootstrapAdmin true·emailVerified 를 넣어도
//      회원 행은 role member·status pending(공개)/active(초대)·monthly_limit_usd 5·is_bootstrap_admin false 이고
//      emailVerified 는 본문이 아니라 초대 문맥대로다 (이메일 없는 초대 false, 이메일 지정 초대 true. 공개 가입 false).
//      maxKeys 는 넣지 않는다 (null 아닌 monthlyLimitUsd·maxKeys 는 400 FIELD_NOT_ALLOWED 로 따로 막힌다, packages/auth/test/auth.test.ts).
//   b  {role:admin} 이메일 없는 초대 400 admin_invite_requires_email · 쓴 토큰 재수락 400 invalid_invite ·
//      같은 토큰 동시 수락 5건 중 201 == 1 (회원 행 +1) · 정지 회원 옛 쿠키 401 ·
//      정지 관리자 옛 쿠키 get-session null + PUT /api/setup/omniroute 401 unauthorized
//
// 마지막 단언은 실제 경로 계약이다. 정지는 auth_version 을 올리고 세션을 지우므로(apps/server/src/admin/guard-sql.ts)
// 옛 쿠키는 세션 없음 401 unauthorized 다 (routes/guard.ts). 403 은 세션이 남은 채 DB 상태로 거부할 때만이다. 401·403 둘 다 받지 않는다.
// 출력은 TC 이름·HTTP 상태·짧은 오류 코드뿐이다.
import { ADMIN, check, codeOf, inviteToken, log, memberId, membersEnv, patchSignup, st, testEmail, testPassword } from "./env.mjs";
import { enroll, proofHeader } from "../mfa.mjs";

const DEFAULT_LIMIT_USD = 5;
/** 본문에 넣는 권한 필드 (서버가 버려야 한다) */
const PRIVILEGED = { role: "admin", status: "active", monthlyLimitUsd: null, isBootstrapAdmin: true, emailVerified: true };
const CONCURRENT = 5;

function expectRow(row, want, tc) {
  const got = row ? `${row.role}/${row.status}/${row.monthlyLimitUsd}/${row.isBootstrapAdmin}/${row.emailVerified}` : "없음";
  const exp = `${want.role}/${want.status}/${want.monthlyLimitUsd}/${want.isBootstrapAdmin}/${want.emailVerified}`;
  check(got === exp, `${tc} 회원 행 role/status/monthly_limit_usd/is_bootstrap_admin/emailVerified = ${exp} (${got})`);
}

export async function runMembersRegress(ctx) {
  const { http, db, mailSettings } = membersEnv(ctx);
  const admin = await http.signIn(ADMIN.email, ADMIN.password);
  check(admin.status === 200 && !!admin.cookie, `관리자 로그인 200 (${st(admin)})`);
  const A = admin.cookie;
  const put = await http.api("PUT", "/api/admin/settings/mail", A, mailSettings);
  check(put.status === 200 && put.json?.mailConfigured === true, `메일 설정 API 200·mailConfigured (${st(put)})`);
  const open = await patchSignup(http, A, { signupMode: "open" });
  check(open.status === 200 && open.json?.settings?.signupMode === "open", `PATCH open 200 (${st(open)})`);

  // ---------- a ----------
  const pub = { email: testEmail("rpub"), password: testPassword() };
  const su = await http.signUp(pub.email, pub.password, PRIVILEGED);
  check(su.status === 200, `TC-M5.T2.a 권한 필드 넣은 공개 가입 200 (${st(su)})`);
  expectRow(db.user(pub.email), { role: "member", status: "pending", monthlyLimitUsd: DEFAULT_LIMIT_USD, isBootstrapAdmin: false, emailVerified: false }, "TC-M5.T2.a 공개 가입");

  const open1 = await http.api("POST", "/api/admin/invites", A, { role: "member" });
  check(open1.status === 201, `TC-M5.T2.a 이메일 없는 member 초대 201 (${st(open1)})`);
  const usedToken = inviteToken(open1.json?.link);
  const iv = { email: testEmail("rinv"), password: testPassword() };
  const a1 = await http.accept(usedToken, iv.email, iv.password, PRIVILEGED);
  check(a1.status === 201 && a1.json?.emailVerified === false, `TC-M5.T2.a 권한 필드 넣은 이메일 없는 초대 수락 201·emailVerified false (${st(a1)})`);
  expectRow(db.user(iv.email), { role: "member", status: "active", monthlyLimitUsd: DEFAULT_LIMIT_USD, isBootstrapAdmin: false, emailVerified: false }, "TC-M5.T2.a 이메일 없는 초대");

  const ev = { email: testEmail("rinve"), password: testPassword() };
  const named = await http.api("POST", "/api/admin/invites", A, { email: ev.email, role: "member" });
  check(named.status === 201, `TC-M5.T2.a 이메일 지정 member 초대 201 (${st(named)})`);
  const a2 = await http.accept(inviteToken(named.json?.link), ev.email, ev.password, { ...PRIVILEGED, emailVerified: false });
  check(a2.status === 201 && a2.json?.emailVerified === true, `TC-M5.T2.a 이메일 지정 초대 수락(본문 emailVerified false) 201·emailVerified true (${st(a2)})`);
  expectRow(db.user(ev.email), { role: "member", status: "active", monthlyLimitUsd: DEFAULT_LIMIT_USD, isBootstrapAdmin: false, emailVerified: true }, "TC-M5.T2.a 이메일 지정 초대");

  // ---------- b ----------
  const ai = await http.api("POST", "/api/admin/invites", A, { role: "admin" });
  check(ai.status === 400 && codeOf(ai.json) === "admin_invite_requires_email", `TC-M5.T2.b {role:admin} 이메일 없는 초대 400 admin_invite_requires_email (${st(ai)})`);
  const re = await http.accept(usedToken, testEmail("rre"), testPassword());
  check(re.status === 400 && codeOf(re.json) === "invalid_invite", `TC-M5.T2.b 쓴 토큰 재수락 400 invalid_invite (${st(re)})`);

  const race = await http.api("POST", "/api/admin/invites", A, { role: "member" });
  check(race.status === 201, `TC-M5.T2.b 동시 수락용 이메일 없는 초대 201 (${st(race)})`);
  const raceToken = inviteToken(race.json?.link);
  const before = db.userCount();
  const results = await Promise.all(Array.from({ length: CONCURRENT }, (_, i) => http.accept(raceToken, testEmail(`race${i}`), testPassword())));
  const won = results.filter((r) => r.status === 201).length;
  const lost = results.filter((r) => r.status === 400 && codeOf(r.json) === "invalid_invite").length;
  check(won === 1 && lost === CONCURRENT - 1, `TC-M5.T2.b 같은 토큰 동시 수락 ${CONCURRENT}건 중 201 == 1 (201 ${won}건, 400 invalid_invite ${lost}건, 상태 ${results.map((r) => r.status).join(",")})`);
  check(db.userCount() === before + 1, "TC-M5.T2.b 동시 수락 뒤 회원 행 +1");

  const ml = await http.signIn(ev.email, ev.password);
  check(ml.status === 200 && !!ml.cookie, `TC-M5.T2.b 회원 로그인 200 (${st(ml)})`);
  const live = await http.api("GET", "/api/me/keys", ml.cookie);
  check(live.status === 200, `TC-M5.T2.b 정지 전 회원 세션 200 (${st(live)})`);
  const mid = await memberId(http, A, ev.email, "active");
  const sus = await http.api("POST", `/api/admin/users/${mid}/suspend`, A);
  check(sus.status === 200 && sus.json?.user?.status === "suspended", `TC-M5.T2.b 회원 suspend 200 (${st(sus)})`);
  const oldM = await http.api("GET", "/api/me/keys", ml.cookie);
  check(oldM.status === 401, `TC-M5.T2.b 정지 회원 옛 쿠키 401 (${st(oldM)})`);

  const a2d = { email: testEmail("radm"), password: testPassword() };
  // 관리자 초대는 작업에 묶인 step-up proof 가 필요하다 (A1)
  const mfaCall = (m, q, c, b, h) => http.api(m, q, c, b, h);
  const adInv = await http.api("POST", "/api/admin/invites", A, { email: a2d.email, role: "admin" }, await proofHeader(mfaCall, A, "admin.invite", a2d.email.trim().toLowerCase().normalize("NFC")));
  check(adInv.status === 201, `TC-M5.T2.b 이메일 지정 admin 초대 201 (${st(adInv)})`);
  const adAcc = await http.accept(inviteToken(adInv.json?.link), a2d.email, a2d.password);
  check(adAcc.status === 201, `TC-M5.T2.b admin 초대 수락 201 (${st(adAcc)})`);
  const aid = await memberId(http, A, a2d.email, "active");
  // 관리자 초대 수락 응답의 등록 grant 로 MFA 를 등록한다 (A1, 2026-10-19 사용자 결정)
  check(typeof adAcc.json?.mfaGrant?.grant === "string", "TC-M5.T2.b admin 초대 수락 응답에 MFA 등록 자격");
  const al = await http.signIn(a2d.email, a2d.password);
  check(al.status === 200 && !!al.cookie, `TC-M5.T2.b 두 번째 관리자 로그인 200 (${st(al)})`);
  await enroll(mfaCall, al.cookie, adAcc.json.mfaGrant.grant);
  // 관리자 확인을 통과하는지 먼저 본다. 틀린 토큰이라 저장하지 않고 400 이다
  const pre = await http.api("PUT", "/api/setup/omniroute", al.cookie, { token: "e2e-not-a-token" });
  check(pre.status === 400, `TC-M5.T2.b 정지 전 두 번째 관리자 PUT /api/setup/omniroute 가 관리자 확인 통과 (${st(pre)})`);
  // 다른 관리자 정지는 대상에 묶은 step-up proof 가 필요하다 (A1 보안 리뷰 M1)
  const asus = await http.api("POST", `/api/admin/users/${aid}/suspend`, A, undefined, await proofHeader(mfaCall, A, "admin.suspend", aid));
  check(asus.status === 200 && asus.json?.user?.status === "suspended", `TC-M5.T2.b 두 번째 관리자 suspend 200 (${st(asus)})`);
  const gs = await http.api("GET", "/api/auth/get-session", al.cookie);
  check(gs.status === 200 && gs.json === null, `TC-M5.T2.b 정지 관리자 옛 쿠키 get-session null (${gs.status} ${gs.json === null ? "null" : "세션 있음"})`);
  const denied = await http.api("PUT", "/api/setup/omniroute", al.cookie, { token: "e2e-not-a-token" });
  check(denied.status === 401 && codeOf(denied.json) === "unauthorized", `TC-M5.T2.b 정지 관리자 옛 쿠키 PUT /api/setup/omniroute 401 unauthorized (${st(denied)})`);
  log("TC-M5.T2.a·b 끝");
}
