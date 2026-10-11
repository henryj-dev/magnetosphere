// H1: 중복 가입 유무와 관계없이 인증 링크는 비밀번호 확인 단계만 연다.
import { expect } from "vitest";
import { body, mail, PASSWORD } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { installed, type HttpRig } from "./checks.ts";

export async function verificationLink(rig: HttpRig, email: string) {
  const message = (await rig.outbox()).filter((m) => m.to === email && m.text.includes("/signup-confirmation?")).at(-1);
  const link = message?.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("인증 메일이 없다");
  const url = new URL(link);
  return { path: url.pathname + url.search, token: url.searchParams.get("token")! };
}

async function signup(rig: HttpRig, tag: string) {
  await installed(rig);
  await rig.op("setSetting", "signup_mode", "open");
  const email = mail(tag);
  expect((await rig.signUp(body(email))).status).toBe(200);
  return { email, ...(await verificationLink(rig, email)) };
}
const confirm = (rig: HttpRig, token: string, password = PASSWORD) => rig.call("POST", "/api/auth/signup-confirmation", { body: { token, password } });

/** TC-M2.T8.e 최초 가입·재발송 인증 링크 GET 은 인증·비밀번호·세션을 바꾸지 않는다. */
export async function tcM2T8e(rig: HttpRig) {
  const { email, path, token } = await signup(rig, "t8e-first");
  const opened = await rig.call("GET", path);
  expect((await rig.op("user", email))?.emailVerified, "GET만으로 최초 가입이 인증되면 안 된다").toBe(false);
  expect(opened.status, opened.body).toBe(200);
  expect(await rig.op("sessionsOf", email)).toBe(0);
  expect(opened.setCookie).toEqual([]);
  expect(opened.json).toMatchObject({ status: "password_confirmation_required" });
  expect((await rig.call("POST", "/api/auth/send-verification-email", { body: { email } })).status).toBe(200);
  const resend = await verificationLink(rig, email);
  const second = await rig.call("GET", resend.path);
  expect(second.status, second.body).toBe(200);
  expect((await rig.op("user", email))?.emailVerified).toBe(false);
  expect(await rig.op("sessionsOf", email)).toBe(0);
  expect(second.setCookie).toEqual([]);
  expect((await confirm(rig, token, "wrong-password-123")).status).toBe(401);
  expect((await rig.op("user", email))?.emailVerified).toBe(false);
  const confirmed = await confirm(rig, token);
  expect(confirmed.status, confirmed.body).toBe(200);
  expect((await rig.op("user", email))?.emailVerified).toBe(true);
  expect(confirmed.setCookie).toEqual([]);
  expect(await rig.op("sessionsOf", email)).toBe(0);
  expect((await confirm(rig, token)).status).toBe(401);
}

/** TC-M2.T8.f Origin·위조·core GET 우회는 모두 상태 변경 없이 거부한다. */
export async function tcM2T8f(rig: HttpRig) {
  const { email, token } = await signup(rig, "t8f-core");
  for (const origin of [null, "https://attacker.example"]) {
    expect((await rig.call("POST", "/api/auth/signup-confirmation", { body: { token, password: PASSWORD }, origin })).status).toBe(403);
  }
  expect((await confirm(rig, token.slice(0, -8) + "forgedxx")).status).toBe(401);
  expect((await rig.call("GET", `/api/auth/verify-email?token=${encodeURIComponent(token)}`)).status).toBe(401);
  expect((await rig.op("user", email))?.emailVerified).toBe(false);
  const two = await Promise.all([confirm(rig, token), confirm(rig, token)]);
  expect(two.map((r) => r.status).sort()).toEqual([200, 401]);
}

/** TC-M2.T8.g 삭제 후 같은 이메일 재가입·재설정 뒤 옛 메일은 새 credential을 인증하지 못한다. */
export async function tcM2T8g(rig: HttpRig) {
  const old = await signup(rig, "t8g-recreate");
  const oldId = (await rig.op("user", old.email))!.id;
  await rig.op("deleteMembers");
  expect((await rig.signUp(body(old.email))).status).toBe(200);
  expect((await rig.op("user", old.email))!.id).not.toBe(oldId);
  expect((await confirm(rig, old.token)).status).toBe(401);
  expect((await rig.op("user", old.email))?.emailVerified).toBe(false);
  const current = await verificationLink(rig, old.email);
  expect((await rig.call("POST", "/api/auth/request-password-reset", { body: { email: old.email, redirectTo: "/" } })).status).toBe(200);
  expect((await rig.op("user", old.email))?.emailVerified).toBe(false);
  const resetMail = (await rig.outbox()).filter((m) => m.to === old.email && m.text.includes("/reset-password/")).at(-1)!;
  const resetToken = new URL(resetMail.text.match(/https?:\/\/\S+/)![0]).pathname.split("/").at(-1);
  const newPassword = "reset-only-new-password-123";
  const reset = await rig.call("POST", "/api/auth/reset-password", { body: { token: resetToken, newPassword } });
  expect(reset.status, reset.body).toBe(200);
  expect(reset.setCookie).toEqual([]);
  expect(await rig.op("sessionsOf", old.email)).toBe(0);
  expect((await confirm(rig, current.token, newPassword)).status).toBe(401);
  expect((await rig.call("POST", "/api/auth/sign-in/email", { body: { email: old.email, password: PASSWORD } })).status).toBe(401);
  expect((await rig.call("POST", "/api/auth/sign-in/email", { body: { email: old.email, password: newPassword } })).status).toBe(200);
}
