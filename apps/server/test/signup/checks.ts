// 가입 정책 시험(M2)의 서버 단언. Node 네 DB(policy.db.test.ts)와 D1(signup.workers.test.ts)이 같은 함수를 부른다.
// 가입 거부는 응답 코드가 아니라 생긴 행 수(user·account·verification)와 메일 수로 본다 (실행판 0절).
import { expect } from "vitest";
import { attempt, body, mail, PASSWORD, userRows, type Rig } from "../../../../packages/auth/test/signup-policy/rig.ts";

export interface CallOpts {
  body?: unknown;
  cookie?: string;
  ip?: string;
  /** 기본 같은 출처. null 이면 Origin 을 빼고 보낸다 */
  origin?: string | null;
  headers?: Record<string, string>;
}
export interface CallRes {
  status: number;
  json: any;
  body: string;
  setCookie: string[];
}
/** 서버 앱 전체에 요청을 보내는 Rig (Node 네 DB env.ts, D1 d1-rig.ts) */
export interface HttpRig extends Rig {
  call(method: string, path: string, o?: CallOpts): Promise<CallRes>;
}

export async function callRes(res: Response): Promise<CallRes> {
  const body = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {}
  return { status: res.status, json, body, setCookie: res.headers.getSetCookie() };
}

/** 비밀번호 회원을 만들고 로그인해 세션 쿠키 머리글 값을 돌려준다 */
export async function login(rig: HttpRig, role: "member" | "admin", status: "active" | "suspended" = "active") {
  const email = mail(`login-${role}-${status}`);
  const id = await rig.op("addPasswordUser", email, PASSWORD, role, status);
  const r = await rig.call("POST", "/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`로그인 실패 ${r.status} ${r.body}`);
  const cookie = r.setCookie.map((c) => c.split(";")[0]).join("; ");
  return { id, email, cookie };
}

const MODES = ["open", "invite_only", "domain_allowlist", "closed", "sso_only"] as const;
/** 공개 가입을 받는 정책 (Q1·Q19) */
const PUBLIC_OPEN = new Set(["open", "domain_allowlist"]);

/** 설치 뒤·메일 있음·허용 도메인 example.test·승인 끔·상한 없음 */
export async function installed(rig: Rig) {
  await rig.op("addAdmin");
  await rig.op("setMail", true);
  await rig.op("setSetting", "allowed_domains", ["example.test"]);
  await rig.op("setSetting", "signup_requires_approval", false);
  await rig.op("setSetting", "daily_signup_cap", null);
}

/** TC-M2.T1.a 정책 다섯 × 공개 가입: 행 수로 판정 */
export async function tcM2T1a(rig: Rig) {
  await installed(rig);
  for (const mode of MODES) {
    await rig.op("setSetting", "signup_mode", mode);
    const pub = await attempt(rig, () => rig.signUp(body(mail(`t1a-${mode}`))));
    if (PUBLIC_OPEN.has(mode)) {
      expect({ mode, status: pub.status, user: pub.user, account: pub.account, mail: pub.mail }, pub.body).toEqual({ mode, status: 200, user: 1, account: 1, mail: 1 });
    } else {
      expect({ mode, status: pub.status, code: pub.code, user: pub.user, account: pub.account, verification: pub.verification, mail: pub.mail }).toEqual({
        mode,
        status: 403,
        code: "signup_closed",
        user: 0,
        account: 0,
        verification: 0,
        mail: 0,
      });
    }
    // 초대 문맥(runAsInvite, 가짜 초대) 안의 서버 호출. invite_only·open·domain_allowlist → +1, closed·sso_only → 0 (Q3)
    const inv = await attempt(rig, () => rig.apiSignUp(body(mail(`t1a-inv-${mode}`, "invited.example")), FAKE_INVITE));
    const want = INVITE_OPEN.has(mode) ? { status: 200, user: 1, account: 1 } : { status: 403, user: 0, account: 0 };
    expect({ mode, status: inv.status, user: inv.user, account: inv.account }, inv.body).toEqual({ mode, ...want });
  }
}

/** 시험용 가짜 초대. 이메일 없는 링크라 수락이 인증을 대신하지 않는다 */
export const FAKE_INVITE = { inviteId: "inv-test", role: "member", email: null, verified: false } as const;
/** 초대를 받는 정책 (Q3) */
const INVITE_OPEN = new Set(["invite_only", "open", "domain_allowlist"]);

/**
 * TC-M2.T3.a 상한을 넘으면 그날 남은 공개 가입을 막는다 (Q13 (가)). a·b 는 같은 DB 의 서버 인스턴스 둘이다.
 * atomicSignup: 가입의 user·account 삽입이 한 트랜잭션인가 (Node 네 DB). D1 은 아니다 (#15) — (3) 에서 user 행이 남을 수 있고, 센 값만 0 이어야 한다.
 */
export async function tcM2T3a(a: HttpRig, b: HttpRig, o: { atomicSignup: boolean }) {
  await installed(a);
  await a.op("setSetting", "signup_mode", "open");
  await a.op("setSetting", "daily_signup_cap", 3);
  await a.op("newDay");

  // (1) 차례로 4건 → +3, 4번째 403 signup_cap·행 0, 알림 1행. 한 번 더 막혀도 알림은 그대로 1행
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(await attempt(a, () => a.signUp(body(mail(`t3a-seq-${i}`)))));
  expect(seq.map((r) => [r.status, r.code, r.user])).toEqual([[200, null, 1], [200, null, 1], [200, null, 1], [403, "signup_cap", 0]]);
  expect(seq[3].mail).toBe(0);
  await b.signUp(body(mail("t3a-seq-again")));
  expect(await a.op("signupCount")).toBe(3);
  expect(await a.op("audits", "alert.signup_cap")).toBe(1);

  // (2) 새 날, 인스턴스 둘이 동시에 공개 가입 10건 → 센 값 == 실제로 생긴 공개 가입 수, 500(SQLITE_BUSY 등) 0
  await a.op("newDay");
  const u0 = await userRows(a);
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? b : a).signUp(body(mail(`t3a-burst-${i}`)))));
  const created = (await userRows(a)) - u0;
  expect(burst.filter((r) => r.status >= 500).map((r) => r.body)).toEqual([]);
  expect(burst.filter((r) => r.status !== 200).every((r) => r.status === 403 && r.code === "signup_cap")).toBe(true);
  expect(created).toBe(burst.filter((r) => r.status === 200).length);
  expect(created).toBeGreaterThanOrEqual(3);
  expect(await a.op("signupCount")).toBe(created);
  const after = await attempt(b, () => b.signUp(body(mail("t3a-after"))));
  expect({ status: after.status, code: after.code, user: after.user }).toEqual({ status: 403, code: "signup_cap", user: 0 });
  expect(await a.op("audits", "alert.signup_cap")).toBe(1);

  // (3) 가입이 account 넣기에서 실패하면 세지 않는다 (트랜잭션이면 user 도 0)
  await a.op("newDay");
  await a.op("renameTable", "account", "account_off");
  // account 표가 없으므로 행 수는 user 만 센다
  const ub = await userRows(a);
  let broken;
  try {
    broken = await a.signUp(body(mail("t3a-broken")));
  } finally {
    await a.op("renameTable", "account_off", "account");
  }
  const brokenUsers = (await userRows(a)) - ub;
  expect(broken.status, broken.body).not.toBe(200);
  expect(await a.op("signupCount")).toBe(0);
  if (o.atomicSignup) expect(brokenUsers).toBe(0);
  else expect(brokenUsers).toBeLessThanOrEqual(1);

  // 초대 수락은 세지 않고 상한 뒤에도 된다
  await a.op("setSetting", "daily_signup_cap", 0);
  const inv = await attempt(a, () => a.apiSignUp(body(mail("t3a-inv")), FAKE_INVITE));
  expect({ status: inv.status, user: inv.user }, inv.body).toEqual({ status: 200, user: 1 });
  expect(await a.op("signupCount")).toBe(0);
}

/** 가입 정책 설정 GET 의 updatedAt (필드 → ISO|null) */
async function readUpdatedAt(rig: HttpRig, cookie: string) {
  const r = await rig.call("GET", "/api/admin/settings/signup", { cookie });
  expect(r.status, r.body).toBe(200);
  return r.json.updatedAt as Record<string, string | null>;
}

/** TC-M2.T5.d 설정 쓰기와 감사 기록은 같이 남거나 같이 남지 않는다 (M1 리뷰) */
export async function tcM2T5d(rig: HttpRig) {
  await rig.op("setSetting", "daily_signup_cap", 20);
  const admin = await login(rig, "admin");
  const before = await rig.op("audits", "settings.update");
  let at = await readUpdatedAt(rig, admin.cookie);
  // 감사 기록 문장이 실행 중에 실패한다 (표가 없다) → 500, 설정 그대로, 감사 기록 0
  await rig.op("renameTable", "audit_log", "audit_log_off");
  let failed;
  try {
    failed = await rig.call("PATCH", "/api/admin/settings/signup", { cookie: admin.cookie, body: { dailySignupCap: 7, updatedAt: { dailySignupCap: at.dailySignupCap } } });
  } finally {
    await rig.op("renameTable", "audit_log_off", "audit_log");
  }
  expect(failed.status, failed.body).toBe(500);
  const kept = await rig.call("GET", "/api/admin/settings/signup", { cookie: admin.cookie });
  expect(kept.json.settings.dailySignupCap).toBe(20);
  expect(kept.json.updatedAt.dailySignupCap).toBe(at.dailySignupCap);
  expect(await rig.op("audits", "settings.update")).toBe(before);
  // 정상 PATCH → 설정 행과 감사 기록 1행
  at = await readUpdatedAt(rig, admin.cookie);
  const ok = await rig.call("PATCH", "/api/admin/settings/signup", { cookie: admin.cookie, body: { dailySignupCap: 7, updatedAt: { dailySignupCap: at.dailySignupCap } } });
  expect(ok.status, ok.body).toBe(200);
  expect(ok.json.settings.dailySignupCap).toBe(7);
  expect(await rig.op("audits", "settings.update")).toBe(before + 1);
}

/** TC-M2.T5.e 오래된 값으로 덮어쓰지 않는다 — 같은 키 동시 PATCH 는 하나만 200, 다른 키는 둘 다 200 (M1 리뷰) */
export async function tcM2T5e(rig: HttpRig) {
  await rig.op("setSetting", "daily_signup_cap", 20);
  const [x, y] = [await login(rig, "admin"), await login(rig, "admin")];
  const before = await rig.op("audits", "settings.update");
  const at = await readUpdatedAt(rig, x.cookie);
  const patch = (who: { cookie: string }, cap: number) =>
    rig.call("PATCH", "/api/admin/settings/signup", { cookie: who.cookie, body: { dailySignupCap: cap, updatedAt: { dailySignupCap: at.dailySignupCap } } });
  const [rx, ry] = await Promise.all([patch(x, 11), patch(y, 12)]);
  expect([rx.status, ry.status].sort(), `${rx.body} / ${ry.body}`).toEqual([200, 409]);
  const lost = rx.status === 409 ? rx : ry;
  expect(lost.json).toEqual({ error: "stale_setting" });
  const won = rx.status === 200 ? 11 : 12;
  const now = await rig.call("GET", "/api/admin/settings/signup", { cookie: x.cookie });
  expect(now.json.settings.dailySignupCap).toBe(won);
  expect(await rig.op("audits", "settings.update")).toBe(before + 1);
  // 옛 화면의 값으로 다시 써도 409 (방금 바뀐 값을 되돌리지 않는다)
  const stale = await patch(x, 20);
  expect(stale.status).toBe(409);
  // 다른 키를 동시에 → 둘 다 200 (키 단위)
  const fresh = await readUpdatedAt(rig, x.cookie);
  const [ka, kb] = await Promise.all([
    rig.call("PATCH", "/api/admin/settings/signup", { cookie: x.cookie, body: { dailySignupCap: 13, updatedAt: { dailySignupCap: fresh.dailySignupCap } } }),
    rig.call("PATCH", "/api/admin/settings/signup", { cookie: y.cookie, body: { signupRequiresApproval: true, updatedAt: { signupRequiresApproval: fresh.signupRequiresApproval } } }),
  ]);
  expect([ka.status, kb.status], `${ka.body} / ${kb.body}`).toEqual([200, 200]);
  expect(await rig.op("audits", "settings.update")).toBe(before + 3);
}

/** 메일 상자에서 이 주소로 간 마지막 링크 가운데 경로가 re 에 맞는 것의 경로+쿼리 */
async function linkTo(rig: HttpRig, to: string, re: RegExp) {
  const m = (await rig.outbox()).filter((x) => x.to === to.toLowerCase() && re.test(x.text)).at(-1);
  const url = m?.text.match(/https?:\/\/\S+/g)?.find((u) => re.test(u));
  if (!url) return null;
  const u = new URL(url);
  return u.pathname + u.search;
}
const VERIFY = /\/signup-confirmation\?/;
const RESET = /\/reset-password\//;

async function signIn(rig: HttpRig, email: string, password: string) {
  return rig.call("POST", "/api/auth/sign-in/email", { body: { email, password } });
}

/** 재설정 링크(/reset-password/<토큰>)로 새 비밀번호를 정한다 */
async function resetWith(rig: HttpRig, email: string, newPassword: string) {
  const link = await linkTo(rig, email, RESET);
  if (!link) throw new Error(`재설정 메일이 없다: ${email}`);
  const token = link.split("?")[0].split("/").at(-1);
  return rig.call("POST", "/api/auth/reset-password", { body: { newPassword, token } });
}

const ATTACKER_PW = "attacker-horse-battery-1";
const VICTIM_PW = "victim-horse-battery-22";

async function openInstalled(rig: HttpRig) {
  await installed(rig);
  await rig.op("setSetting", "signup_mode", "open");
  await rig.op("newDay");
}

/**
 * TC-M2.T8.a 미인증 계정 선점으로 계정을 가로채지 못한다 (보안 리뷰 H1). 공격자가 피해자 이메일로 먼저 가입 → 피해자가 가입(가짜 200)
 * → 피해자가 인증 메일을 다시 받아 인증 → 공격자 비밀번호 로그인 401·그 계정 세션 0, 피해자에게 재설정 메일 → 재설정 뒤 피해자 로그인 200
 */
export async function tcM2T8a(rig: HttpRig) {
  await openInstalled(rig);
  const victim = mail("t8a-victim");
  expect((await rig.signUp(body(victim, { password: ATTACKER_PW }))).status).toBe(200);
  const dup = await attempt(rig, () => rig.signUp(body(victim, { password: VICTIM_PW })));
  expect({ status: dup.status, user: dup.user }).toEqual({ status: 200, user: 0 });
  expect((await rig.call("POST", "/api/auth/send-verification-email", { body: { email: victim } })).status).toBe(200);
  const verify = await linkTo(rig, victim, VERIFY);
  expect(verify).not.toBeNull();
  expect((await rig.call("GET", verify!)).status).toBe(200);
  expect((await rig.op("user", victim))?.emailVerified).toBe(false);
  const token = new URL(verify!, "http://test").searchParams.get("token");
  expect((await rig.call("POST", "/api/auth/signup-confirmation", { body: { token, password: VICTIM_PW } })).status).toBe(401);
  const attacker = await signIn(rig, victim, ATTACKER_PW);
  expect(attacker.status, attacker.body).toBe(403);
  expect(await rig.op("sessionsOf", victim)).toBe(0);
  // 모르는 가입 비밀번호는 메일함 주인이 재설정한다. 완료 전까지는 인증되지 않는다.
  expect((await rig.call("POST", "/api/auth/request-password-reset", { body: { email: victim, redirectTo: "/" } })).status).toBe(200);
  expect((await rig.op("user", victim))?.emailVerified).toBe(false);
  expect((await resetWith(rig, victim, VICTIM_PW)).status).toBe(200);
  expect((await signIn(rig, victim, VICTIM_PW)).status).toBe(200);
  expect((await signIn(rig, victim, ATTACKER_PW)).status).toBe(401);
}

/** TC-M2.T8.b 다툼이 없는 정상 가입은 인증 뒤 원래 비밀번호로 로그인된다, 재설정 메일 없음 (보안 리뷰 H1 대조) */
export async function tcM2T8b(rig: HttpRig) {
  await openInstalled(rig);
  const e = mail("t8b");
  expect((await rig.signUp(body(e, { password: VICTIM_PW }))).status).toBe(200);
  const verify = await linkTo(rig, e, VERIFY);
  expect((await rig.call("GET", verify!)).status).toBe(200);
  expect((await rig.op("user", e))?.emailVerified).toBe(false);
  const token = new URL(verify!, "http://test").searchParams.get("token");
  expect((await rig.call("POST", "/api/auth/signup-confirmation", { body: { token, password: VICTIM_PW } })).status).toBe(200);
  const r = await signIn(rig, e, VICTIM_PW);
  expect(r.status, r.body).toBe(200);
  expect(await linkTo(rig, e, RESET)).toBeNull();
}

/** TC-M2.T8.c 비밀번호 재설정은 그 회원의 다른 세션을 모두 끊고, 미인증 회원이면 emailVerified 를 true 로 한다 (메일함 소유 증명, 보안 리뷰 H1) */
export async function tcM2T8c(rig: HttpRig) {
  await openInstalled(rig);
  // (1) 인증된 회원의 세션 둘 → 재설정 → 세션 0
  const m = await login(rig, "member");
  await signIn(rig, m.email, PASSWORD);
  expect(await rig.op("sessionsOf", m.email)).toBe(2);
  expect((await rig.call("POST", "/api/auth/request-password-reset", { body: { email: m.email, redirectTo: "/" } })).status).toBe(200);
  expect((await resetWith(rig, m.email, "new-horse-battery-333")).status).toBe(200);
  expect(await rig.op("sessionsOf", m.email)).toBe(0);
  const old = await rig.call("GET", "/api/auth/get-session", { cookie: m.cookie });
  expect(old.json?.session ?? null).toBeNull();
  // (2) 미인증 회원 → 재설정 → emailVerified true·로그인 200
  const e = mail("t8c-unverified");
  expect((await rig.signUp(body(e))).status).toBe(200);
  expect((await rig.op("user", e))?.emailVerified).toBe(false);
  expect((await rig.call("POST", "/api/auth/request-password-reset", { body: { email: e, redirectTo: "/" } })).status).toBe(200);
  expect((await resetWith(rig, e, "reset-horse-battery-444")).status).toBe(200);
  expect((await rig.op("user", e))?.emailVerified).toBe(true);
  expect((await signIn(rig, e, "reset-horse-battery-444")).status).toBe(200);
}
