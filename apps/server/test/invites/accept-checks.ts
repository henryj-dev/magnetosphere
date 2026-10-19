// 초대 수락 (M3.T2) 공용 단언. Node 네 DB(accept.db.test.ts, test/signup/env.ts serverRig)와 D1(accept.workers.test.ts,
// test/signup/d1-rig.ts 시험 Worker)이 같은 함수를 부른다. 두 Rig 모두 운영과 같은 createApp + buildServices(진짜 Better Auth)다.
import { createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";
import { mail, PASSWORD } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { installed, login, proofHeader, type HttpRig } from "../signup/checks.ts";

export const ACCEPT = "/api/invites/accept";
export const INVALID = JSON.stringify({ error: "invalid_invite" });
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** 형식은 맞지만 어느 초대에도 없는 토큰 */
export const unknownToken = () => randomBytes(32).toString("base64url");

/** 설치 뒤·메일 있음·invite_only·공개 주소 있음. 관리자 세션을 돌려준다 */
export async function prepareAccept(rig: HttpRig) {
  await installed(rig);
  await rig.op("setSetting", "signup_mode", "invite_only");
  await rig.op("setSetting", "public_base_url", "https://llm.example.test");
  return login(rig, "admin");
}

/** 관리자 API 로 초대를 만들고 id·원문 토큰을 돌려준다. 관리자 초대는 step-up proof 를 싣는다 (A1) */
export async function makeInvite(rig: HttpRig, admin: { cookie: string }, b: { role: "member" | "admin"; email?: string; expiresInDays?: number }) {
  const headers = b.role === "admin" ? await proofHeader(rig, admin.cookie, "admin.invite", "admin-invite") : undefined;
  const r = await rig.call("POST", "/api/admin/invites", { cookie: admin.cookie, body: b, headers });
  if (r.status !== 201) throw new Error(`초대 만들기 실패 ${r.status} ${r.body}`);
  return { id: r.json.invite.id as string, token: (r.json.link as string).split("#")[1] };
}

export const acceptBody = (token: string, email: string, extra: Record<string, unknown> = {}) => ({ token, email, name: "초대 회원", password: PASSWORD, ...extra });

/** TC-M3.T2.a 같은 토큰으로 동시 수락 10건 (이메일 지정 없음, 이메일 10개) → 201 정확히 1, 나머지 400 invalid_invite, user 증가 1 */
export async function tcM3T2a(rig: HttpRig) {
  const admin = await prepareAccept(rig);
  const inv = await makeInvite(rig, admin, { role: "member" });
  const before = await rig.op("userCount");
  const emails = Array.from({ length: 10 }, (_, i) => mail(`t2a-${i}`));
  const rs = await Promise.all(emails.map((email) => rig.call("POST", ACCEPT, { body: acceptBody(inv.token, email) })));
  const after = await rig.op("userCount");
  const obs = {
    created: rs.filter((r) => r.status === 201).length,
    invalid: rs.filter((r) => r.status === 400 && r.body === INVALID).length,
    other: rs.filter((r) => r.status !== 201 && !(r.status === 400 && r.body === INVALID)).map((r) => `${r.status} ${r.body.slice(0, 120)}`),
    userDelta: after - before,
  };
  expect(obs).toEqual({ created: 1, invalid: 9, other: [], userDelta: 1 });
  // 가입한 회원은 201 을 받은 이메일 하나다
  const winner = emails[rs.findIndex((r) => r.status === 201)];
  const u = await rig.op("user", winner);
  expect({ role: u?.role, status: u?.status }).toEqual({ role: "member", status: "active" });
  expect(await rig.op("audits", "invite.accept")).toBe(1);
  return obs;
}

/** 이 주소로 간 마지막 메일에서 경로가 re 에 맞는 링크의 경로+쿼리 */
async function lastLink(rig: HttpRig, to: string, re: RegExp): Promise<string | null> {
  const m = (await rig.outbox()).filter((x) => x.to === to.toLowerCase() && re.test(x.text)).at(-1);
  const url = m?.text.match(/https?:\/\/\S+/g)?.find((u) => re.test(u));
  if (!url) return null;
  const u = new URL(url);
  return u.pathname + u.search;
}
const signIn = (rig: HttpRig, email: string, password: string) => rig.call("POST", "/api/auth/sign-in/email", { body: { email, password } });
export const ATTACKER_PASSWORD = "attacker-horse-battery-777";

/**
 * TC-M3.T2.g 이메일 없는 초대를 남의 이메일로 수락해도 그 이메일을 가로채지 못한다 (M3.T2 보안 리뷰 H-1).
 * 공격자가 이메일 없는 링크를 피해자 이메일 + 공격자 비밀번호로 수락하면 미인증 invite 회원이 생긴다. 그 회원은 공개 가입과 같은
 * H1 확인 흐름을 탄다: 메일 링크는 비밀번호 확인 단계만 열고(GET 무변경), core /verify-email 은 401, 피해자가 모르는 비밀번호로는 인증되지 않는다.
 * 피해자는 재설정으로 계정을 되찾는다 (재설정이 인증하고 공격자 비밀번호·세션을 무효로 한다).
 * coreToken: 그 이메일의 core 인증 JWT (Better Auth 기본 링크의 토큰 꼴, 서버 비밀값으로 서명). control.keys: 키 어댑터를 넣은 Rig 면 키 발급 201 까지 본다
 */
export async function tcM3T2g(rig: HttpRig, coreToken: (email: string) => Promise<string>, control?: { keys: boolean }) {
  const admin = await prepareAccept(rig);
  const inv = await makeInvite(rig, admin, { role: "member" });
  const victim = mail("t2g-victim");
  const m0 = (await rig.outbox()).filter((m) => m.to === victim).length;
  const r = await rig.call("POST", ACCEPT, { body: acceptBody(inv.token, victim, { password: ATTACKER_PASSWORD }) });
  expect(r.status, r.body).toBe(201);
  expect((await rig.op("user", victim))?.emailVerified).toBe(false);
  const mails = (await rig.outbox()).filter((m) => m.to === victim).slice(m0);
  expect(mails, "피해자에게 메일 1통").toHaveLength(1);
  // 피해자가 메일의 링크를 누른다 — 인증되면 안 된다
  const link = mails[0].text.match(/https?:\/\/\S+/)?.[0];
  expect(link, "메일에 링크가 있다").toBeTruthy();
  const opened = await rig.call("GET", new URL(link!).pathname + new URL(link!).search);
  expect((await rig.op("user", victim))?.emailVerified, `메일 링크(${new URL(link!).pathname})를 누르는 것만으로 인증되면 안 된다`).toBe(false);
  expect(new URL(link!).pathname, "H1 확인 링크").toBe("/api/auth/signup-confirmation");
  expect(opened.status, opened.body).toBe(200);
  expect(opened.setCookie).toEqual([]);
  // core /verify-email 은 401, 그대로 미인증
  const core = await rig.call("GET", `/api/auth/verify-email?token=${encodeURIComponent(await coreToken(victim))}`);
  expect({ status: core.status, verified: (await rig.op("user", victim))?.emailVerified }).toEqual({ status: 401, verified: false });
  // 피해자가 모르는 비밀번호(자기 비밀번호)로 확인 → 401, 그대로 미인증
  const token = new URL(link!).searchParams.get("token")!;
  const wrong = await rig.call("POST", "/api/auth/signup-confirmation", { body: { token, password: "victim-own-password-1" } });
  expect({ status: wrong.status, verified: (await rig.op("user", victim))?.emailVerified }).toEqual({ status: 401, verified: false });
  // 공격자 비밀번호 로그인 → 403 (미인증)
  expect((await signIn(rig, victim, ATTACKER_PASSWORD)).status).toBe(403);
  expect(await rig.op("sessionsOf", victim)).toBe(0);
  // 피해자가 재설정으로 되찾는다
  expect((await rig.call("POST", "/api/auth/request-password-reset", { body: { email: victim, redirectTo: "/" } })).status).toBe(200);
  const reset = await lastLink(rig, victim, /\/reset-password\//);
  expect(reset, "재설정 메일").toBeTruthy();
  const VICTIM = "victim-new-horse-battery-1";
  const done = await rig.call("POST", "/api/auth/reset-password", { body: { newPassword: VICTIM, token: reset!.split("?")[0].split("/").at(-1) } });
  expect(done.status, done.body).toBe(200);
  expect((await rig.op("user", victim))?.emailVerified, "재설정이 인증한다").toBe(true);
  expect((await signIn(rig, victim, ATTACKER_PASSWORD)).status, "공격자 비밀번호 무효").toBe(401);
  expect((await signIn(rig, victim, VICTIM)).status, "피해자 로그인").toBe(200);

  // 대조: 이메일 지정 초대는 그대로 바로 인증·로그인 (인증 메일 0통)
  const bound = mail("t2g-bound");
  const bi = await makeInvite(rig, admin, { role: "member", email: bound });
  const b0 = (await rig.outbox()).filter((m) => m.to === bound).length;
  expect((await rig.call("POST", ACCEPT, { body: acceptBody(bi.token, bound) })).status).toBe(201);
  expect((await rig.outbox()).filter((m) => m.to === bound).length - b0, "인증 메일 0통").toBe(0);
  const login = await signIn(rig, bound, PASSWORD);
  expect(login.status, login.body).toBe(200);
  if (control?.keys) {
    const key = await rig.call("POST", "/api/me/keys", { cookie: login.setCookie.map((c) => c.split(";")[0]).join("; "), body: {} });
    expect(key.status, key.body).toBe(201);
  }
}
