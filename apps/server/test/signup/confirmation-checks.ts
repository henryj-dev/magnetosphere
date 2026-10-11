// H1: 중복 가입 유무와 관계없이 인증 링크는 비밀번호 확인 단계만 연다.
import { expect } from "vitest";
import { body, mail, PASSWORD } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { installed, type HttpRig } from "./checks.ts";

export async function verificationLink(rig: HttpRig, email: string) {
  const message = (await rig.outbox()).filter((m) => m.to === email).at(-1);
  const link = message?.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("인증 메일이 없다");
  const url = new URL(link);
  return { path: url.pathname + url.search, token: url.searchParams.get("token")! };
}

/** TC-M2.T8.e 최초 가입·재발송 인증 링크 GET 은 인증·비밀번호·세션을 바꾸지 않는다. */
export async function tcM2T8e(rig: HttpRig) {
  await installed(rig);
  await rig.op("setSetting", "signup_mode", "open");
  const email = mail("t8e-first");
  expect((await rig.signUp(body(email))).status).toBe(200);
  const first = await verificationLink(rig, email);
  const opened = await rig.call("GET", first.path);
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
  const wrong = await rig.call("POST", "/api/auth/signup-confirmation", { body: { token: first.token, password: "wrong-password-123" } });
  expect(wrong.status, wrong.body).toBe(401);
  expect((await rig.op("user", email))?.emailVerified).toBe(false);
  const confirmed = await rig.call("POST", "/api/auth/signup-confirmation", { body: { token: first.token, password: PASSWORD } });
  expect(confirmed.status, confirmed.body).toBe(200);
  expect((await rig.op("user", email))?.emailVerified).toBe(true);
  expect(confirmed.setCookie).toEqual([]);
  expect(await rig.op("sessionsOf", email)).toBe(0);
}
