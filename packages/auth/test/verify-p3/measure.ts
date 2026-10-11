// 3단계 확인 항목 V29~V32 의 측정 (M0). 측정은 Rig 하나만 보고 돈다.
//   Node 네 DB: rig.ts 의 nodeRig (같은 프로세스의 handler·auth.api·Drizzle 연결)
//   D1:         apps/server/test/verify-p3/rig.ts 의 workersRig (wrangler dev 시험 Worker 에 HTTP)
// 그래서 같은 측정이 다섯 DB 에서 같은 관찰 객체를 낸다. 시험은 그 관찰을 docs/verify/V<n>.json 의 answer 와 비교한다.
import type { MailMessage } from "../../src/index.ts";
import { client, email, PASSWORD, type Handler, type Res } from "../client.ts";
import { linkIn } from "../helpers.ts";
import type { OPS, OpName } from "./ops.ts";
import type { HookLog, Scenario } from "./probe.ts";

type OpResult<K extends OpName> = Awaited<ReturnType<(typeof OPS)[K]>>;
type OpArgs<K extends OpName> = (typeof OPS)[K] extends (db: any, s: any, ...a: infer A) => any ? A : never;

export interface Rig {
  runtime: "node" | "workers";
  /** 시험 구성 하나의 공개 HTTP 입구 (/api/auth/*) */
  handler(scenario: Scenario): Handler;
  /** 초대 문맥(ALS) 안의 서버 호출 auth.api.signUpEmail 과 공개 HTTP 가입을 같은 시각에 (probe.ts concurrentSignUps) */
  concurrentSignUps(scenario: Scenario, invited: Record<string, unknown>, publicBody: Record<string, unknown>): Promise<{ api: { status: number; code: string | null }; publicStatus: number; inviteId: string }>;
  op<K extends OpName>(name: K, ...args: OpArgs<K>): Promise<OpResult<K>>;
  /** 지금까지 보낸 메일 전부 (응답과 떼어 보낸 전송이 끝난 뒤) */
  outbox(): Promise<MailMessage[]>;
  /** 지금까지 훅이 남긴 기록 전부 */
  log(): Promise<HookLog[]>;
  /** 시험 구성의 session.cookieCache 설정 */
  cookieCache(scenario: Scenario): Promise<unknown>;
  /** auth.api 의 경로 목록 (경로가 없는 서버 전용 엔드포인트는 "(server) <이름>") */
  apiPaths(): Promise<string[]>;
}

const signUpBody = (e: string, extra: Record<string, unknown> = {}) => ({ email: e, password: PASSWORD, name: "probe", ...extra });

/** 세션 쿠키를 새로 심었나 (지우는 Set-Cookie 는 빼고) */
export const setsSessionCookie = (r: Res) => r.setCookie.some((c) => /session_token=[^;]+/.test(c) && !/max-age=0/i.test(c));

/** 가짜 user 의 무작위 값(id·시각)과 이메일을 지워 응답 모양만 비교한다 */
function shape(json: any) {
  if (!json || typeof json !== "object") return json;
  const user = json.user ? { ...json.user, id: "<id>", email: "<email>", createdAt: "<t>", updatedAt: "<t>" } : json.user;
  return { ...json, ...(json.user ? { user } : {}) };
}

async function rowCounts(rig: Rig) {
  const { user, account, verification } = await rig.op("rows");
  return { user, account, verification };
}

/** 가입 한 번. 상태·본문 모양·생긴 행 수(user·account·verification)·보낸 메일 수 */
async function attempt(rig: Rig, scenario: Scenario, e: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const r0 = await rowCounts(rig);
  const m0 = (await rig.outbox()).length;
  const r = await client(rig.handler(scenario)).post("/sign-up/email", signUpBody(e, extra), headers);
  const r1 = await rowCounts(rig);
  const m1 = (await rig.outbox()).length;
  return {
    status: r.status,
    code: (r.json?.code as string) ?? null,
    shape: shape(r.json),
    rowsLeft: { user: r1.user - r0.user, account: r1.account - r0.account, verification: r1.verification - r0.verification },
    mailSent: m1 - m0,
  };
}

/** 지금 구성으로 이미 있는 회원 하나 (인증 메일 1통이 나간다) */
async function existingMember(rig: Rig, tag: string) {
  const e = email(tag);
  const r = await client(rig.handler("plain")).post("/sign-up/email", signUpBody(e));
  if (r.status !== 200 || !(await rig.op("user", e))) throw new Error(`이미 있는 회원을 만들지 못했다: ${r.status} ${JSON.stringify(r.json)}`);
  return e;
}

/** 가입을 막는 시험 구성 하나로 없는 이메일·있는 이메일을 한 번씩 */
async function rejectPair(rig: Rig, scenario: Scenario) {
  const existing = await existingMember(rig, `v29-${scenario}-old`);
  const fresh = await attempt(rig, scenario, email(`v29-${scenario}-new`));
  const dup = await attempt(rig, scenario, existing);
  return {
    status: fresh.status,
    code: fresh.code,
    existingStatus: dup.status,
    sameForExisting: fresh.status === dup.status && JSON.stringify(fresh.shape) === JSON.stringify(dup.shape),
    rowsLeft: fresh.rowsLeft,
    mailSent: fresh.mailSent,
  };
}

// ---------------- V29 ----------------

/** TC-M0.T2.a hooks.before 403 */
export const v29BeforeHook = (rig: Rig) => rejectPair(rig, "before403");

/** TC-M0.T2.b user.create.before 403·400 */
export async function v29CreateHook(rig: Rig) {
  return { createHook403: await rejectPair(rig, "create403"), createHook400: await rejectPair(rig, "create400") };
}

/** 지금 구성(plain) 가입 한 번. D1 에서 transaction: true 그대로 올린 Rig 로 잰다 (V29 d1Transaction) */
export async function signUpOnce(rig: Rig) {
  const a = await attempt(rig, "plain", email("v29-tx"));
  return { status: a.status, rowsLeft: a.rowsLeft, mailSent: a.mailSent };
}

/** TC-M0.T2.c 훅이 돌려준 data 가 저장되는 값과 발송기가 받는 user.emailVerified */
export async function v29HookData(rig: Rig) {
  const e = email("v29-data");
  const logStart = (await rig.log()).length;
  const a = await attempt(rig, "createData", e);
  const row = await rig.op("user", e);
  const mailLog = (await rig.log()).slice(logStart).filter((l) => l.at === "sendVerificationEmail" && l.email === e);
  return {
    status: a.status,
    hookDataOverrides: { emailVerified: row?.emailVerified, status: row?.status, monthlyLimitUsd: row?.monthlyLimitUsd, mailSent: a.mailSent },
    mailerSeesVerified: mailLog.length === 1 ? (mailLog[0] as { emailVerified: boolean }).emailVerified : `발송기 호출 ${mailLog.length}번`,
  };
}

/** TC-M0.T2.d 초대 문맥(ALS)이 서버 호출의 두 훅에서만 보이는지, 위조되는지, user.create.after 가 커밋 뒤인지 */
export async function v29Als(rig: Rig) {
  const logStart = (await rig.log()).length;
  const invited = email("v29-als-invite");
  const pub = email("v29-als-public");
  const forged = email("v29-als-forged");
  const both = await rig.concurrentSignUps("als", signUpBody(invited), signUpBody(pub));
  // 공개 요청이 본문·헤더로 초대 문맥을 만들어 보려는 것
  const forgedRes = await client(rig.handler("als")).post(
    "/sign-up/email",
    signUpBody(forged, { inviteId: both.inviteId, __invite: both.inviteId, invite: { inviteId: both.inviteId } }),
    { "x-invite": both.inviteId, "x-invite-id": both.inviteId },
  );
  const log = (await rig.log()).slice(logStart);
  const seen = (at: HookLog["at"], e: string) => log.filter((l) => l.at === at && "email" in l && l.email === e).map((l) => (l as { inviteId: string | null }).inviteId);
  // 그 자리에서 정확히 한 번, 기대한 값을 봤나
  const once = (at: HookLog["at"], e: string, v: string | null) => JSON.stringify(seen(at, e)) === JSON.stringify([v]);
  const after = log.filter((l) => l.at === "create.after") as Extract<HookLog, { at: "create.after" }>[];
  return {
    statuses: { api: both.api.status, publicRequest: both.publicStatus, forged: forgedRes.status },
    alsVisible: {
      beforeHook: once("before", invited, both.inviteId),
      createHook: once("create.before", invited, both.inviteId),
      createAfter: once("create.after", invited, both.inviteId),
      // 같은 시각 공개 요청에서 두 자리 모두 문맥이 없어야 한다 (보이면 true)
      publicRequest: !(once("before", pub, null) && once("create.before", pub, null)),
      forgeable: !(once("before", forged, null) && once("create.before", forged, null)),
    },
    createAfterRunsAfterCommit: after.length === 3 && after.every((l) => l.userVisible && l.accountVisible),
  };
}

// ---------------- V30 ----------------

/** 인증된 회원 하나 (지금 구성으로 가입하고 인증만 DB 로 켠다) */
async function verifiedMember(rig: Rig, tag: string) {
  const e = await existingMember(rig, tag);
  await rig.op("setUser", e, { emailVerified: true });
  return e;
}

async function signedIn(rig: Rig, scenario: Scenario, e: string, password = PASSWORD) {
  const c = client(rig.handler(scenario));
  const r = await c.post("/sign-in/email", { email: e, password });
  return { c, r };
}

const sessionOf = async (c: ReturnType<typeof client>) => (await c.get("/get-session")).json;

/** TC-M0.T3.a 세션 행을 지운 뒤 첫 요청 */
export async function v30Delete(rig: Rig) {
  const e = await verifiedMember(rig, "v30-del");
  const { c, r } = await signedIn(rig, "plain", e);
  const before = await sessionOf(c);
  await rig.op("deleteSessionsOf", e);
  const firstRequestAfterDelete = await sessionOf(c);
  return {
    cookieCacheEnabled: ((await rig.cookieCache("plain")) as { enabled?: boolean } | null)?.enabled === true,
    signInStatus: r.status,
    sessionBeforeDelete: before?.user?.email === e,
    firstRequestAfterDelete,
  };
}

/** 메일 상자에서 이 주소로 간 마지막 재설정 링크의 토큰 */
async function resetToken(rig: Rig, e: string) {
  const mail = (await rig.outbox()).filter((m) => m.to === e && /비밀번호 재설정/.test(m.subject)).at(-1);
  const url = mail && linkIn(mail.text);
  const token = url && new URL(url).pathname.split("/").at(-1);
  if (!token) throw new Error(`재설정 메일이 없다: ${e}`);
  return token;
}

/** 재설정 메일을 받아 새 비밀번호로 바꾼다. 재설정 응답 */
async function resetPassword(rig: Rig, scenario: Scenario, e: string, newPassword: string) {
  const c = client(rig.handler(scenario));
  const asked = await c.post("/request-password-reset", { email: e, redirectTo: "/reset" });
  if (asked.status !== 200) throw new Error(`재설정 요청 실패: ${asked.status} ${JSON.stringify(asked.json)}`);
  return c.post("/reset-password", { newPassword, token: await resetToken(rig, e) });
}

/** TC-M0.T3.b 비밀번호 변경·재설정 뒤 다른 세션 */
export async function v30Password(rig: Rig) {
  const e = await verifiedMember(rig, "v30-change");
  const a = await signedIn(rig, "plain", e);
  const b = await signedIn(rig, "plain", e);
  const changed = await a.c.post("/change-password", { currentPassword: PASSWORD, newPassword: "changed-horse-battery-1" });
  const otherSessionsAfterPasswordChange = (await sessionOf(b.c))?.user?.email === e;

  const sessionsAfterReset: Record<"off" | "on", number> = { off: -1, on: -1 };
  const resetStatus: Record<"off" | "on", number> = { off: -1, on: -1 };
  for (const [key, scenario] of [["off", "resetKeep"], ["on", "resetRevoke"]] as const) {
    const r = await verifiedMember(rig, `v30-reset-${key}`);
    await signedIn(rig, "plain", r);
    await signedIn(rig, "plain", r);
    const before = await rig.op("sessionsOf", r);
    if (before !== 2) throw new Error(`세션 둘을 만들지 못했다: ${before}`);
    resetStatus[key] = (await resetPassword(rig, scenario, r, `reset-horse-battery-${key}`)).status;
    sessionsAfterReset[key] = await rig.op("sessionsOf", r);
  }
  return { changePasswordStatus: changed.status, otherSessionsAfterPasswordChange, resetStatus, sessionsAfterReset };
}

// ---------------- V31 ----------------

/** TC-M0.T4.a session.create.before 가 정지 회원의 로그인을 거부할 때 */
export async function v31Reject(rig: Rig) {
  const active = await verifiedMember(rig, "v31-active");
  const suspended = await verifiedMember(rig, "v31-suspended");
  const pending = await verifiedMember(rig, "v31-pending");
  await rig.op("setUser", suspended, { status: "suspended" });
  await rig.op("setUser", pending, { status: "pending" });
  const ok = await signedIn(rig, "sessionGuard", active);
  const rejected = await signedIn(rig, "sessionGuard", suspended);
  const wrong = await signedIn(rig, "sessionGuard", suspended, "wrong-horse-battery-staple");
  const pend = await signedIn(rig, "sessionGuard", pending);
  return {
    activeStatus: ok.r.status,
    activeSessionRows: await rig.op("sessionsOf", active),
    rejectStatus: rejected.r.status,
    rejectCode: (rejected.r.json?.code as string) ?? null,
    pendingCode: (pend.r.json?.code as string) ?? null,
    sessionRows: (await rig.op("sessionsOf", suspended)) + (await rig.op("sessionsOf", pending)),
    sessionCookie: setsSessionCookie(rejected.r) || setsSessionCookie(pend.r),
    wrongPasswordStatus: wrong.r.status,
  };
}

/** TC-M0.T4.b 재설정·인증 링크가 세션을 만드는지, session.create.after 가 방금 만든 세션을 지울 수 있는지 */
export async function v31Paths(rig: Rig) {
  // 재설정: 정지 회원이 링크로 비밀번호를 바꾼다
  const reset = await verifiedMember(rig, "v31-reset");
  await rig.op("setUser", reset, { status: "suspended" });
  const resetRes = await resetPassword(rig, "sessionGuard", reset, "reset-horse-battery-v31");
  const resetCreatesSession = setsSessionCookie(resetRes) || (await rig.op("sessionsOf", reset)) > 0;

  // 인증 링크: 가입 메일의 링크를 정지 상태에서 연다
  const verify = await existingMember(rig, "v31-verify");
  await rig.op("setUser", verify, { status: "suspended" });
  const mail = (await rig.outbox()).filter((m) => m.to === verify).at(-1);
  const link = mail && linkIn(mail.text);
  if (!link) throw new Error("인증 메일이 없다");
  const verifyRes = await client(rig.handler("sessionGuard")).get(link);
  const verifyCreatesSession = setsSessionCookie(verifyRes) || (await rig.op("sessionsOf", verify)) > 0;

  // after 훅이 방금 만든 세션을 지운다
  const racer = await verifiedMember(rig, "v31-after");
  const { c, r } = await signedIn(rig, "sessionAfterDelete", racer);
  const rowsAfter = await rig.op("sessionsOf", racer);
  const sessionAfter = await sessionOf(c);
  return {
    resetStatus: resetRes.status,
    resetCreatesSession,
    verifyStatus: verifyRes.status,
    verifiedAfterLink: (await rig.op("user", verify))?.emailVerified,
    verifyCreatesSession,
    afterHookSignIn: { status: r.status, sessionCookie: setsSessionCookie(r) },
    afterHookCanDelete: rowsAfter === 0 && sessionAfter === null,
  };
}

// ---------------- V32 ----------------

/** V32 에서 부르는 회원 변경·생성 경로. 순서대로 부른다 (마지막 셋이 세션을 지운다) */
type Call = { path: string; label?: string; method?: "GET" | "POST"; body?: (ctx: { e: string; other: string; tokenB: string }) => unknown; query?: string };
export const V32_CALLS: Call[] = [
  { path: "/update-user", label: "/update-user email", body: ({ other }) => ({ email: other }) },
  { path: "/update-user", label: "/update-user name", body: () => ({ name: "이름 바꿈" }) },
  { path: "/update-user", label: "/update-user role·status", body: () => ({ role: "admin", status: "active", isBootstrapAdmin: true }) },
  { path: "/change-email", body: ({ other }) => ({ newEmail: other }) },
  { path: "/delete-user", body: () => ({ password: PASSWORD }) },
  { path: "/delete-user/callback", method: "GET", query: "?token=probe-token" },
  { path: "/unlink-account", body: () => ({ providerId: "credential" }) },
  { path: "/link-social", body: () => ({ provider: "google" }) },
  { path: "/sign-in/social", body: () => ({ provider: "google" }) },
  { path: "/callback/:id", label: "/callback/google", method: "GET", query: "?code=probe&state=probe" },
  { path: "/sign-in/sso", body: ({ other }) => ({ email: other, callbackURL: "/" }) },
  { path: "/sso/callback/:providerId", label: "/sso/callback/probe", method: "GET", query: "?code=probe&state=probe" },
  { path: "/sso/callback", method: "GET", query: "?code=probe&state=probe" },
  { path: "/sso/saml2/sp/acs/:providerId", label: "/sso/saml2/sp/acs/probe", body: () => ({ SAMLResponse: "probe" }) },
  { path: "/sign-up/email", body: ({ other }) => signUpBody(other) },
  { path: "/change-password", body: () => ({ currentPassword: PASSWORD, newPassword: "v32-horse-battery-staple" }) },
  { path: "/revoke-session", body: ({ tokenB }) => ({ token: tokenB }) },
  { path: "/revoke-other-sessions", body: () => ({}) },
  { path: "/revoke-sessions", body: () => ({}) },
];

const urlOf = (c: Call) => (c.label && c.label.startsWith("/") && !c.label.includes(" ") ? c.label : c.path) + (c.query ?? "");

async function snapshot(rig: Rig, e: string) {
  const u = await rig.op("user", e);
  return { user: u, rows: await rig.op("rows"), hash: await rig.op("passwordHash", e), sessions: await rig.op("sessionsOf", e) };
}

function effectOf(a: Awaited<ReturnType<typeof snapshot>>, b: Awaited<ReturnType<typeof snapshot>>) {
  const out: string[] = [];
  if (a.user && !b.user) out.push("회원 지워짐");
  if (a.user && b.user) {
    if (a.user.email !== b.user.email) out.push("이메일 바뀜");
    if (a.user.name !== b.user.name) out.push("이름 바뀜");
    if (a.user.role !== b.user.role) out.push("역할 바뀜");
    if (a.user.status !== b.user.status) out.push("상태 바뀜");
  }
  if (b.rows.user > a.rows.user) out.push("회원 생김");
  if (a.hash !== b.hash) out.push("비밀번호 바뀜");
  if (a.sessions !== b.sessions) out.push(`세션 ${a.sessions}→${b.sessions}`);
  return out.length ? out.join(", ") : "없음";
}

/** TC-M0.T5.a 설치 뒤(관리자 있음) 로그인한 회원이 부르는 경로마다 상태코드와 효과 */
export async function v32Paths(rig: Rig) {
  const e = await verifiedMember(rig, "v32-member");
  await rig.op("addAdmin");
  const other = email("v32-other");
  const a = await signedIn(rig, "plain", e);
  const b = await signedIn(rig, "plain", e);
  await signedIn(rig, "plain", e);
  await signedIn(rig, "plain", e);
  const cookieB = [...b.c.jar].find(([k]) => k.endsWith("session_token"))?.[1];
  const tokenB = decodeURIComponent(cookieB ?? "").split(".")[0];
  const paths: { path: string; status: number; effect: string }[] = [];
  for (const call of V32_CALLS) {
    const before = await snapshot(rig, e);
    const url = urlOf(call);
    const r = call.method === "GET" ? await a.c.get(url) : await a.c.post(url, call.body?.({ e, other, tokenB }) ?? {});
    // 이메일이 바뀌었으면 바뀐 주소로 본다
    const after = await snapshot(rig, (await rig.op("user", e)) ? e : other);
    paths.push({ path: call.label ?? call.path, status: r.status, effect: effectOf(before, after) });
  }
  return { paths, allPaths: (await rig.apiPaths()).sort() };
}
