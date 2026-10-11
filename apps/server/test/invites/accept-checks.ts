// 초대 수락 (M3.T2) 공용 단언. Node 네 DB(accept.db.test.ts, test/signup/env.ts serverRig)와 D1(accept.workers.test.ts,
// test/signup/d1-rig.ts 시험 Worker)이 같은 함수를 부른다. 두 Rig 모두 운영과 같은 createApp + buildServices(진짜 Better Auth)다.
import { createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";
import { mail, PASSWORD } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { installed, login, type HttpRig } from "../signup/checks.ts";

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

/** 관리자 API 로 초대를 만들고 id·원문 토큰을 돌려준다 */
export async function makeInvite(rig: HttpRig, admin: { cookie: string }, b: { role: "member" | "admin"; email?: string; expiresInDays?: number }) {
  const r = await rig.call("POST", "/api/admin/invites", { cookie: admin.cookie, body: b });
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
