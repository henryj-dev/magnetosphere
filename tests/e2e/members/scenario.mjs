// M5.T1 회원 정책 시나리오 (TC-M5.T1.a~d, docs/plan/phase3-todo.md). pnpm e2e --combo <조합> --scenario members
//
// 설치·관리자(run.mjs) 뒤 한 묶음에서 차례로 돈다 (d 는 a 의 초대 회원·키를 쓴다. 공개 가입 하루 상한을 b 가 쓰고 c 가 푼다):
//   a  설치 직후(invite_only) 공개 가입 403·회원 행 +0 → 이메일 지정 member 초대 → 수락 201 → 그 회원 로그인 →
//      키 발급 201 (확인 메일 없이) → 같은 토큰 재수락 400 invalid_invite
//   d  초대 회원 키 요청 200 → suspend → 다음 요청 403 permission_denied·회원 세션 401·로그인 403 ACCOUNT_SUSPENDED →
//      unsuspend → 키 요청 200 → DELETE → 키 403 permission_denied·로그인 401
//   b  메일 설정(API) → PATCH open·하루 상한 2 → 공개 가입 2건 행 +2 → 3번째 403 signup_cap·행 +0·alert.signup_cap 1행 →
//      확인 메일의 토큰 + 가입 비밀번호로 POST 확인 → pending 로그인 200 → 승인 전 키 발급 403 → approve → 옛 쿠키 401 →
//      다시 로그인 200 → 키 발급 201 → monthly_limit_usd 5
//   c  domain_allowlist ["e2e.test"](상한 없음) → @e2e.test 행 +1, @other.test 403 domain_not_allowed·행 +0 →
//      closed → 공개 가입 403·행 +0, 초대 만들기 409 signup_closed
//
// 회원은 가입·초대 API 로만 만든다. DB 는 행 수·감사·회원 권한 필드만 읽는다 (env.mjs dbRead).
// 출력은 TC 이름·HTTP 상태·짧은 오류 코드뿐이다 (토큰·링크·키 원문·이메일·오류 본문을 내지 않는다).
import { ADMIN, check, codeOf, confirmationToken, infer, inviteToken, log, memberId, membersEnv, patchSignup, permissionDenied, sameSignupDay, sleep, stableSignupDay, st, testEmail, testPassword, until, VERIFY_SUBJECT } from "./env.mjs";

/** 기본 한도 (가입 정책 시드 default_limit_usd) */
const DEFAULT_LIMIT_USD = 5;
/** unsuspend 뒤 키가 다시 받아질 때까지 (OmniRoute 키 검증 캐시 60초 + 여유) */
const REENABLE_MS = 70_000;

export async function runMembers(ctx) {
  const { http, v1Base, mail, mailAttempts, db, mailSettings } = membersEnv(ctx);
  const admin = await http.signIn(ADMIN.email, ADMIN.password);
  check(admin.status === 200 && !!admin.cookie, `관리자 로그인 200 (${st(admin)})`);
  const A = admin.cookie;

  // ---------- a ----------
  {
    const before = db.userCount();
    const pub = await http.signUp(testEmail("pub"), testPassword());
    check(pub.status === 403 && codeOf(pub.json) === "signup_closed", `TC-M5.T1.a 설치 직후 공개 가입 403 signup_closed (${st(pub)})`);
    check(db.userCount() === before, "TC-M5.T1.a 공개 가입 뒤 회원 행 +0");
  }
  const m = { email: testEmail("inv"), password: testPassword() };
  const inv = await http.api("POST", "/api/admin/invites", A, { email: m.email, role: "member" });
  check(inv.status === 201, `TC-M5.T1.a 이메일 지정 member 초대 201 (${st(inv)})`);
  const invToken = inviteToken(inv.json?.link);
  const attemptsBefore = mailAttempts();
  const acc = await http.accept(invToken, m.email, m.password);
  check(acc.status === 201 && acc.json?.emailVerified === true, `TC-M5.T1.a 초대 수락 201·emailVerified true (${st(acc)})`);
  const ml = await http.signIn(m.email, m.password);
  check(ml.status === 200 && !!ml.cookie, `TC-M5.T1.a 초대 회원 로그인 200 (${st(ml)})`);
  const key = await http.api("POST", "/api/me/keys", ml.cookie, { label: "e2e-m5" });
  check(key.status === 201 && typeof key.json?.secret === "string", `TC-M5.T1.a 키 발급 201 (${st(key)})`);
  check((await mail.count(m.email, VERIFY_SUBJECT)) === 0, "TC-M5.T1.a 메일 미설정 초대: 로컬 수신함 확인 메일 0건 (전송 시도 없음의 증거 아님)");
  // 2초 기다린 뒤 한 번만 다시 읽어 전후 marker 수를 비교한다 (읽기마다 상한 5초, 관측 전체 최대 약 7초)
  await sleep(2_000);
  if (mailAttempts() !== attemptsBefore) throw new Error("E_INVITE_MAIL_ATTEMPT");
  log("ok  TC-M5.T1.a 2초 관측 중 fallback/메일 실패 marker 증가 0 (외부 발송 부재를 증명하지 않음)");
  const again = await http.accept(invToken, testEmail("re"), testPassword());
  check(again.status === 400 && codeOf(again.json) === "invalid_invite", `TC-M5.T1.a 같은 토큰 재수락 400 invalid_invite (${st(again)})`);
  const sameAgain = await http.accept(invToken, m.email, m.password);
  check(sameAgain.status === 400 && codeOf(sameAgain.json) === "invalid_invite", `TC-M5.T1.a 같은 토큰·같은 이메일 재수락 400 invalid_invite (${st(sameAgain)})`);

  // ---------- d ----------
  {
    const secret = key.json.secret;
    const r1 = await infer(v1Base, secret);
    check(r1.status === 200, `TC-M5.T1.d 초대 회원 키 요청 200 (${r1.status})`);
    const id = await memberId(http, A, m.email, "active");
    const sus = await http.api("POST", `/api/admin/users/${id}/suspend`, A);
    check(sus.status === 200 && sus.json?.user?.status === "suspended", `TC-M5.T1.d suspend 200 (${st(sus)}, sync ${sus.json?.sync ?? "-"})`);
    const r2 = await infer(v1Base, secret);
    check(permissionDenied(r2), `TC-M5.T1.d 정지 뒤 다음 키 요청 403 permission_denied (${r2.status} ${codeOf(r2.json)})`);
    const sess = await http.api("GET", "/api/me/keys", ml.cookie);
    check(sess.status === 401, `TC-M5.T1.d 정지 회원 옛 세션 401 (${st(sess)})`);
    const login = await http.signIn(m.email, m.password);
    check(login.status === 403 && login.json?.code === "ACCOUNT_SUSPENDED", `TC-M5.T1.d 정지 회원 로그인 403 ACCOUNT_SUSPENDED (${st(login)})`);
    const un = await http.api("POST", `/api/admin/users/${id}/unsuspend`, A);
    check(un.status === 200 && un.json?.user?.status === "active", `TC-M5.T1.d unsuspend 200 (${st(un)}, sync ${un.json?.sync ?? "-"})`);
    let tries = 0;
    const r3 = await until(async (remaining) => (tries++, infer(v1Base, secret, true, remaining)), (r) => r.status === 200, REENABLE_MS, 2_000);
    check(r3.status === 200, `TC-M5.T1.d 정지 해제 뒤 키 요청 200 (${r3.status}, 시도 ${tries}번, 상한 ${REENABLE_MS}ms)`);
    const del = await http.api("DELETE", `/api/admin/users/${id}`, A);
    check(del.status === 200, `TC-M5.T1.d DELETE 200 (${st(del)})`);
    const r4 = await infer(v1Base, secret);
    check(permissionDenied(r4), `TC-M5.T1.d 삭제 뒤 키 요청 403 permission_denied (${r4.status} ${codeOf(r4.json)})`);
    const gone = await http.signIn(m.email, m.password);
    check(gone.status === 401, `TC-M5.T1.d 삭제 회원 로그인 401 (${st(gone)})`);
  }

  // ---------- b ----------
  const put = await http.api("PUT", "/api/admin/settings/mail", A, mailSettings);
  check(put.status === 200 && put.json?.mailConfigured === true, `TC-M5.T1.b 메일 설정 API 200·mailConfigured (${st(put)})`);
  const open = await patchSignup(http, A, { signupMode: "open", dailySignupCap: 2 });
  check(open.status === 200 && open.json?.settings?.signupMode === "open" && open.json?.settings?.dailySignupCap === 2, `TC-M5.T1.b PATCH open·하루 상한 2 200 (${st(open)})`);
  await mail.clear();
  const p1 = { email: testEmail("pub1"), password: testPassword() };
  const p2 = { email: testEmail("pub2"), password: testPassword() };
  {
    await http.pace.room("sign-up", 3);
    const day = await stableSignupDay();
    const before = db.userCount();
    const counterBefore = db.counter(day) ?? 0;
    sameSignupDay(day);
    check(counterBefore === 0, "TC-M5.T1.b 당일 공개 가입 카운터 0");
    const s1 = await http.signUp(p1.email, p1.password);
    const s2 = await http.signUp(p2.email, p2.password);
    sameSignupDay(day);
    const counted = await until((remaining) => db.counter(day, remaining), (n) => n === 2, 10_000);
    sameSignupDay(day);
    check(counted === 2, "TC-M5.T1.b 공개 가입 2건 뒤 당일 카운터 정확히 2");
    check(s1.status === 200 && s2.status === 200, `TC-M5.T1.b 공개 가입 2건 200 (${st(s1)} / ${st(s2)})`);
    check(db.userCount() === before + 2, "TC-M5.T1.b 공개 가입 2건 뒤 회원 행 +2");
    const alerts = db.auditCount("alert.signup_cap");
    const s3 = await http.signUp(testEmail("pub3"), testPassword());
    sameSignupDay(day);
    check(s3.status === 403 && codeOf(s3.json) === "signup_cap", `TC-M5.T1.b 3번째 공개 가입 403 signup_cap (${st(s3)})`);
    check(db.userCount() === before + 2, "TC-M5.T1.b 3번째 공개 가입 뒤 회원 행 +0");
    const after = await until((remaining) => db.auditCount("alert.signup_cap", remaining), (n) => n >= 1, 10_000);
    const counterAfter = db.counter(day);
    sameSignupDay(day);
    check(counterAfter === 2, "TC-M5.T1.b 상한 거부 뒤 당일 카운터 정확히 2");
    check(alerts === 0 && after === 1, `TC-M5.T1.b 감사 alert.signup_cap 1행 (앞 ${alerts}, 뒤 ${after})`);
  }
  const text = await mail.waitFor(p1.email, VERIFY_SUBJECT, 60_000);
  const conf = await http.confirm(confirmationToken(text), p1.password);
  check(conf.status === 200 && conf.json?.status === true, `TC-M5.T1.b 확인 POST + 가입 비밀번호 200 (${st(conf)})`);
  const pl = await http.signIn(p1.email, p1.password);
  check(pl.status === 200 && !!pl.cookie, `TC-M5.T1.b pending 회원 로그인 200 (${st(pl)})`);
  const k0 = await http.api("POST", "/api/me/keys", pl.cookie, { label: "e2e-m5" });
  check(k0.status === 403 && codeOf(k0.json) === "member_inactive", `TC-M5.T1.b 승인 전 키 발급 403 member_inactive (${st(k0)})`);
  const pid = await memberId(http, A, p1.email, "pending");
  const ap = await http.api("POST", `/api/admin/users/${pid}/approve`, A);
  check(ap.status === 200 && ap.json?.user?.status === "active", `TC-M5.T1.b approve 200 (${st(ap)})`);
  const old = await http.api("GET", "/api/me/keys", pl.cookie);
  check(old.status === 401, `TC-M5.T1.b 승인 뒤 옛 쿠키 401 (${st(old)})`);
  const pl2 = await http.signIn(p1.email, p1.password);
  check(pl2.status === 200 && !!pl2.cookie, `TC-M5.T1.b 다시 로그인 200 (${st(pl2)})`);
  const k1 = await http.api("POST", "/api/me/keys", pl2.cookie, { label: "e2e-m5" });
  check(k1.status === 201, `TC-M5.T1.b 승인 뒤 키 발급 201 (${st(k1)})`);
  const row = db.user(p1.email);
  check(row?.monthlyLimitUsd === DEFAULT_LIMIT_USD, `TC-M5.T1.b 승인 회원 monthly_limit_usd ${DEFAULT_LIMIT_USD} (${row?.monthlyLimitUsd ?? "없음"})`);

  // ---------- c ----------
  const allow = await patchSignup(http, A, { signupMode: "domain_allowlist", allowedDomains: ["e2e.test"], dailySignupCap: null });
  check(allow.status === 200 && allow.json?.settings?.signupMode === "domain_allowlist", `TC-M5.T1.c PATCH domain_allowlist ["e2e.test"]·상한 없음 200 (${st(allow)})`);
  {
    const before = db.userCount();
    const ok = await http.signUp(testEmail("a", "e2e.test"), testPassword());
    check(ok.status === 200 && db.userCount() === before + 1, `TC-M5.T1.c @e2e.test 공개 가입 200·회원 행 +1 (${st(ok)})`);
    const no = await http.signUp(testEmail("a", "other.test"), testPassword());
    check(no.status === 403 && codeOf(no.json) === "domain_not_allowed", `TC-M5.T1.c @other.test 공개 가입 403 domain_not_allowed (${st(no)})`);
    check(db.userCount() === before + 1, "TC-M5.T1.c @other.test 뒤 회원 행 +0");
  }
  const closed = await patchSignup(http, A, { signupMode: "closed" });
  check(closed.status === 200 && closed.json?.settings?.signupMode === "closed", `TC-M5.T1.c PATCH closed 200 (${st(closed)})`);
  {
    const before = db.userCount();
    const pub = await http.signUp(testEmail("closed", "e2e.test"), testPassword());
    check(pub.status === 403 && codeOf(pub.json) === "signup_closed", `TC-M5.T1.c closed 공개 가입 403 signup_closed (${st(pub)})`);
    check(db.userCount() === before, "TC-M5.T1.c closed 공개 가입 뒤 회원 행 +0");
  }
  const ci = await http.api("POST", "/api/admin/invites", A, { email: testEmail("ci"), role: "member" });
  check(ci.status === 409 && codeOf(ci.json) === "signup_closed", `TC-M5.T1.c closed 초대 만들기 409 signup_closed (${st(ci)})`);
  log("TC-M5.T1.a~d 끝");
}
