// TC-M4.T2·T4 삭제·자기 탈퇴 단언. TC-M4.T2.d 삭제 뒤 재설정 토큰 단언은 delete.db.test.ts 가 네 DB 에서도 쓴다. 작성만 승인됐고 실행하지 않는다.
// 가입·로그인·재설정은 설치된 Better Auth handler 를 그대로 쓰고, 삭제 라우트만 독립 Hono 에서 확인한다.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { expect, vi } from "vitest";
import * as memberDeletion from "../../src/admin/delete.ts";
import { memberAdminRoutes } from "../../src/admin/members.ts";
import { selfDeleteRoutes } from "../../src/admin/self-delete.ts";
import { KEY_DELETE_DELAY_MS } from "../../src/queue/index.ts";
import { sameOrigin } from "../../src/routes/guard.ts";
import { installed, login, proofHeader, type CallOpts, type HttpRig } from "../signup/checks.ts";
import { verificationLink } from "../signup/confirmation-checks.ts";
import { body, mail, PASSWORD } from "../../../../packages/auth/test/signup-policy/rig.ts";
import type { ServerRig } from "../signup/env.ts";

type Rig = ServerRig;

async function rows(rig: Rig) {
  const s = rig.h.schema;
  return {
    users: await rig.h.db.select().from(s.user),
    accounts: await rig.h.db.select().from(s.account),
    sessions: await rig.h.db.select().from(s.session),
    verifications: await rig.h.db.select().from(s.verification),
    keys: await rig.h.db.select().from(s.apiKeys),
    usage: await rig.h.db.select().from(s.usageDaily),
    jobs: await rig.h.db.select().from(s.omnirouteJobs),
    audits: await rig.h.db.select().from(s.auditLog),
  };
}

let beforeVerifiedCommit: ((rig: Rig, userId: string) => Promise<void>) | undefined;
const commitDelete = memberDeletion.deleteMember;
function mount(rig: Rig, client: (() => unknown) | null | (() => never)) {
  vi.restoreAllMocks();
  beforeVerifiedCommit = undefined;
  vi.spyOn(memberDeletion, "deleteMember").mockImplementation(async (services, input) => {
    if (beforeVerifiedCommit && input.selfProof) await beforeVerifiedCommit(rig, input.targetId);
    return commitDelete(services, input);
  });
  const services = async () => ({ ...rig.services, keysClient: async () => client });
  const app = new Hono();
  app.use("/api/admin/*", sameOrigin(services as never));
  app.delete("/api/me", sameOrigin(services as never));
  app.route("/api/admin", memberAdminRoutes(services as never));
  app.route("/api/me", selfDeleteRoutes(services as never));
  return app;
}

async function call(app: { request(input: RequestInfo | URL, init?: RequestInit): Response | Promise<Response> }, method: string, path: string, o: CallOpts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin !== null) headers.origin = o.origin ?? "http://localhost:3000";
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`http://localhost:3000${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

async function realMember(rig: Rig, label: string) {
  await rig.op("setSetting", "signup_mode", "open");
  const email = mail(label);
  const joined = await rig.signUp(body(email));
  expect(joined.status).toBe(200);
  // 공개 가입은 미인증이라 로그인 403이다. 설치된 H1 확인(메일 링크 + 가입 비밀번호)을 거친다.
  const { token } = await verificationLink(rig, email);
  expect((await rig.call("POST", "/api/auth/signup-confirmation", { body: { token, password: PASSWORD } })).status).toBe(200);
  const signed = await rig.call("POST", "/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
  expect(signed.status).toBe(200);
  const user = (await rows(rig)).users.find((row: any) => row.email === email);
  return { id: user.id as string, email, cookie: signed.setCookie.map((value) => value.split(";")[0]).join("; ") };
}

async function resetToken(rig: HttpRig, email: string) {
  expect((await rig.call("POST", "/api/auth/request-password-reset", { body: { email, redirectTo: "/" } })).status).toBe(200);
  const sent = (await rig.outbox()).filter((message) => message.to === email && message.text.includes("/reset-password/")).at(-1);
  expect(sent).toBeTruthy();
  return new URL(sent!.text.match(/https?:\/\/\S+/)![0]).pathname.split("/").at(-1)!;
}

// 조회 순서는 DB 마다 다르므로 id 순으로 맞춰 비교한다.
const byId = (list: any[]) => [...list].sort((x, y) => String(x.id).localeCompare(String(y.id)));
// 실패 출력에 비밀번호 해시·세션 token·재설정 token 원문이 찍히지 않게 id 와 행 전체의 해시만 비교한다.
const digest = (list: any[]) => byId(list).map((row: any) => ({ id: row.id, hash: createHash("sha256").update(JSON.stringify(row)).digest("hex") }));
const TABLES = ["users", "accounts", "sessions", "verifications"] as const;

/** 삭제 대상 밖 회원의 user·account·session·verification 행. 삭제·재설정 시도 앞뒤로 그대로인지 비교한다 */
async function ownedBy(rig: Rig, ids: string[]) {
  const all = await rows(rig);
  return {
    users: byId(all.users.filter((row: any) => ids.includes(row.id))),
    accounts: byId(all.accounts.filter((row: any) => ids.includes(row.userId))),
    sessions: byId(all.sessions.filter((row: any) => ids.includes(row.userId))),
    verifications: byId(all.verifications.filter((row: any) => ids.includes(row.value) || ids.includes(row.identifier))),
  };
}

/**
 * TC-M4.T2.d: 삭제 전에 받아 두고 쓰지 않은 재설정 토큰을 삭제 뒤에 쓴다.
 * 400 INVALID_TOKEN 이어야 하고, 그 시도가 credential account·세션을 다시 만들거나 회원 행·남의 행을 바꾸면 안 된다.
 * Better Auth 재설정은 credential account 가 없으면 새로 만드는 경로가 있어, 토큰 정리가 빠지면 삭제 회원이 되살아난다.
 */
async function resetAfterDelete(rig: Rig, member: { id: string; email: string }, token: string, passwords: string[], others: { ids: string[]; before: Awaited<ReturnType<typeof ownedBy>>; tokens: string[] }) {
  const deleted = await rows(rig);
  const deletedUser = deleted.users.find((row: any) => row.id === member.id);
  expect(deletedUser).toMatchObject({ status: "deleted", email: `deleted-${member.id}@invalid`, name: "", image: null });
  expect(deleted.verifications.some((row: any) => row.identifier === `reset-password:${token}`)).toBe(false);
  const revived = "revived-password-123";
  const attempt = await rig.call("POST", "/api/auth/reset-password", { body: { token, newPassword: revived } });
  expect([attempt.status, attempt.json?.code]).toEqual([400, "INVALID_TOKEN"]);
  const after = await rows(rig);
  expect(after.accounts.filter((row: any) => row.userId === member.id).length, "삭제 회원 credential 수").toBe(0);
  expect(after.sessions.filter((row: any) => row.userId === member.id).length, "삭제 회원 세션 수").toBe(0);
  expect(after.users.find((row: any) => row.id === member.id)).toEqual(deletedUser);
  // 실패한 재설정은 어느 회원의 user·account·session·verification 행도 쓰지 않는다.
  for (const table of TABLES) expect(digest(after[table]), `재설정 실패 뒤 ${table} 행 해시`).toEqual(digest(deleted[table]));
  // 옛 이메일로는 삭제 전 비밀번호든 되살리려던 새 비밀번호든 로그인되지 않는다.
  for (const password of [...passwords, revived]) {
    const signIn = await rig.call("POST", "/api/auth/sign-in/email", { body: { email: member.email, password } });
    expect(signIn.status, "삭제 회원 옛 이메일 로그인").toBe(401);
  }
  expect((await rows(rig)).sessions.filter((row: any) => row.userId === member.id).length, "로그인 시도 뒤 삭제 회원 세션 수").toBe(0);
  // 대상 밖 회원은 삭제 전 값 그대로이고, 그 회원이 받아 둔 재설정 토큰도 지워지지 않았다.
  const othersAfter = await ownedBy(rig, others.ids);
  for (const table of TABLES) expect(digest(othersAfter[table]), `대상 밖 회원 ${table} 행 해시`).toEqual(digest(others.before[table]));
  for (const kept of others.tokens) expect(after.verifications.some((row: any) => row.identifier === `reset-password:${kept}`), "대상 밖 회원 재설정 토큰 행").toBe(true);
}

/** TC-M4.T2.d 를 네 DB 에서 단독으로 돌린다. 키가 없는 회원이라 관리 API 를 부르지 않는다 (sync none) */
export async function tcM4T2dResetAfterDelete(rig: Rig) {
  await installed(rig);
  const admin = await login(rig, "admin");
  const member = await realMember(rig, "t2d-member");
  const other = await realMember(rig, "t2d-other");
  const token = await resetToken(rig, member.email);
  const otherToken = await resetToken(rig, other.email);
  const issued = await rows(rig);
  expect(issued.verifications.some((row: any) => row.identifier === `reset-password:${token}` && row.value === member.id)).toBe(true);
  expect(issued.verifications.some((row: any) => row.identifier === `reset-password:${otherToken}` && row.value === other.id)).toBe(true);
  expect(issued.accounts.filter((row: any) => row.userId === member.id).length, "삭제 전 회원 credential 수").toBe(1);
  const othersBefore = await ownedBy(rig, [other.id]);
  expect(othersBefore.users.length, "대상 밖 회원 수").toBe(1);
  expect(othersBefore.accounts.length, "대상 밖 회원 credential 수").toBe(1);
  expect(othersBefore.sessions.length).toBeGreaterThan(0);
  const app = mount(rig, null);
  const deleted = await call(app, "DELETE", `/api/admin/users/${member.id}`, { cookie: admin.cookie });
  expect({ status: deleted.status, json: deleted.json }).toEqual({ status: 200, json: { deleted: true, sync: "none" } });
  await resetAfterDelete(rig, member, token, [PASSWORD], { ids: [other.id], before: othersBefore, tokens: [otherToken] });
  // 양성 대조: 같은 경로에서 대상 밖 회원의 삭제 전 토큰은 그대로 쓸 수 있다. 400 이 경로 자체의 고장이 아님을 보인다.
  const otherReset = await rig.call("POST", "/api/auth/reset-password", { body: { token: otherToken, newPassword: "other-replacement-123" } });
  expect(otherReset.status).toBe(200);
}

export async function tcM4DeleteAndSelf(rig: Rig) {
  await installed(rig);
  const admin = await login(rig, "admin");
  const member = await realMember(rig, "delete-member");
  const other = await realMember(rig, "delete-other");
  const oldSession = member.cookie;
  const token = await resetToken(rig, member.email);
  const beforeReset = await rows(rig);
  expect(beforeReset.verifications.some((row: any) => row.identifier === `reset-password:${token}` && row.value === member.id)).toBe(true);
  const reset = await rig.call("POST", "/api/auth/reset-password", { body: { token, newPassword: "replacement-password-123" } });
  expect(reset.status).toBe(200);
  const consumed = await rig.call("POST", "/api/auth/reset-password", { body: { token, newPassword: "replacement-password-456" } });
  expect(consumed.status).toBe(400);
  const oldLogin = await rig.call("POST", "/api/auth/sign-in/email", { body: { email: member.email, password: PASSWORD }, cookie: oldSession });
  expect(oldLogin.status).toBe(401);

  const s = rig.h.schema;
  const image = "https://private.example/avatar.png";
  await rig.h.db.update(s.user).set({ image, name: "실명" }).where(eq(s.user.id, member.id));
  const keyId = crypto.randomUUID();
  const omnirouteKeyId = crypto.randomUUID();
  await rig.h.db.insert(s.apiKeys).values({ id: keyId, userId: member.id, omnirouteKeyId, keyPreview: "abcd", state: "active", createdAt: new Date() });
  await rig.h.db.insert(s.usageDaily).values({ keyId: omnirouteKeyId, day: "2026-10-13", costUsd: 1.25, updatedAt: new Date() });
  const otherVerification = crypto.randomUUID();
  await rig.h.db.insert(s.verification).values({ id: otherVerification, identifier: `reset-password:${crypto.randomUUID()}`, value: other.id, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date() });
  const unrelated = crypto.randomUUID();
  await rig.h.db.insert(s.verification).values({ id: unrelated, identifier: `other-member:${other.id}`, value: member.id, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date() });
  // TC-M4.T2.d: 삭제 전에 받아 두고 쓰지 않은 재설정 토큰. 대상 밖 회원 것도 하나 받아 지워지지 않는지 본다.
  const lateToken = await resetToken(rig, member.email);
  const otherToken = await resetToken(rig, other.email);
  expect(lateToken === token, "삭제 전 재설정 토큰이 앞서 쓴 토큰과 같다").toBe(false);
  const lateIssued = await rows(rig);
  expect(lateIssued.verifications.some((row: any) => row.identifier === `reset-password:${lateToken}` && row.value === member.id), "삭제 전 재설정 토큰 행").toBe(true);
  const othersBefore = await ownedBy(rig, [other.id]);
  expect(othersBefore.verifications.some((row: any) => row.identifier === `reset-password:${otherToken}`)).toBe(true);

  const client = { setKeyActive: vi.fn(async () => {}), deleteKey: vi.fn(async () => {}) };
  const app = mount(rig, () => client);
  const started = Date.now();
  const deleted = await call(app, "DELETE", `/api/admin/users/${member.id}`, { cookie: admin.cookie });
  expect(deleted.status).toBe(200);
  expect(deleted.json).toEqual({ deleted: true, sync: "synced" });
  expect(client.setKeyActive).toHaveBeenCalledWith(omnirouteKeyId, false);
  const after = await rows(rig);
  const anonymized = after.users.find((row: any) => row.id === member.id);
  expect(anonymized).toMatchObject({ status: "deleted", email: `deleted-${member.id}@invalid`, name: "", image: null });
  expect(anonymized.deletedAt).toBeInstanceOf(Date);
  expect(anonymized.authVersion).toBeGreaterThan(0);
  expect(JSON.stringify(after)).not.toContain(member.email);
  expect(JSON.stringify(after)).not.toContain(image);
  expect(after.accounts.filter((row: any) => row.userId === member.id)).toHaveLength(0);
  expect(after.sessions.filter((row: any) => row.userId === member.id)).toHaveLength(0);
  expect(after.verifications.filter((row: any) => row.value === member.id && String(row.identifier).startsWith("reset-password:"))).toHaveLength(0);
  expect(after.verifications.some((row: any) => row.id === otherVerification)).toBe(true);
  expect(after.verifications.some((row: any) => row.id === unrelated)).toBe(true);
  expect(after.keys.find((row: any) => row.id === keyId)).toMatchObject({ userId: member.id, state: "deleted", syncState: "synced" });
  expect(after.usage).toEqual(expect.arrayContaining([expect.objectContaining({ keyId: omnirouteKeyId, costUsd: 1.25 })]));
  const queued = after.jobs.find((row: any) => row.action === "key.delete" && row.keyId === keyId);
  expect(queued).toBeTruthy();
  expect(new Date(queued.nextRunAt).getTime() - started).toBeGreaterThanOrEqual(KEY_DELETE_DELAY_MS - 5_000);
  expect(new Date(queued.nextRunAt).getTime() - started).toBeLessThanOrEqual(KEY_DELETE_DELAY_MS + 5_000);
  expect(JSON.parse(queued.payload)).toEqual({ keyId, omnirouteKeyId });
  expect(after.audits.filter((row: any) => row.action === "member.delete" && row.target === member.id)).toHaveLength(1);
  expect(JSON.stringify(after.audits)).not.toContain(member.email);
  await resetAfterDelete(rig, member, lateToken, [PASSWORD, "replacement-password-123"], { ids: [other.id], before: othersBefore, tokens: [otherToken] });

  const wrong = await call(app, "DELETE", "/api/me", { cookie: other.cookie, body: { password: "wrong-password-123" } });
  expect(wrong.status).toBe(403);
  expect((await rows(rig)).users.find((row: any) => row.id === other.id).status).toBe("active");
  const correct = await call(app, "DELETE", "/api/me", { cookie: other.cookie, body: { password: "replacement-password-123" } });
  expect(correct.status).toBe(403);
  const self = await call(app, "DELETE", "/api/me", { cookie: other.cookie, body: { password: PASSWORD } });
  expect(self.status).toBe(200);
  expect((await rows(rig)).users.find((row: any) => row.id === other.id)).toMatchObject({ status: "deleted", email: `deleted-${other.id}@invalid`, name: "", image: null });

  const origin = await call(app, "DELETE", "/api/me", { cookie: admin.cookie, origin: "https://evil.example", body: { password: PASSWORD } });
  expect(origin.status).toBe(403);
  const foreign = await call(app, "DELETE", `/api/admin/users/${admin.id}`, { cookie: other.cookie });
  expect(foreign.status).toBe(401);
  await rig.h.db.update(s.user).set({ isBootstrapAdmin: true }).where(eq(s.user.id, admin.id));
  // 관리자 탈퇴는 작업에 묶인 step-up proof 가 필요하다 (A1). proof 를 실은 요청이 bootstrap 판정에 닿는다
  expect((await call(app, "DELETE", "/api/me", { cookie: admin.cookie, body: { password: PASSWORD } })).status).toBe(403);
  expect((await call(app, "DELETE", "/api/me", { cookie: admin.cookie, body: { password: PASSWORD }, headers: await proofHeader(rig, admin.cookie, "admin.delete", admin.id) })).status).toBe(409);
  await rig.h.db.update(s.user).set({ isBootstrapAdmin: false }).where(eq(s.user.id, admin.id));
  // 관리자 API 로 자기 계정을 지우지 못한다. 다른 활성 관리자가 있어도 409 self 이고 아무것도 쓰지 않는다 (M4 보안 리뷰 M1, 자기 탈퇴는 /api/me 뿐)
  const selfBefore = await rows(rig);
  const selfAdmin = await call(app, "DELETE", `/api/admin/users/${admin.id}`, { cookie: admin.cookie });
  expect({ status: selfAdmin.status, json: selfAdmin.json }).toEqual({ status: 409, json: { error: "self" } });
  const selfAfter = await rows(rig);
  expect(selfAfter.users.find((row: any) => row.id === admin.id)).toEqual(selfBefore.users.find((row: any) => row.id === admin.id));
  expect([selfAfter.sessions.length, selfAfter.audits.length, selfAfter.jobs.length]).toEqual([selfBefore.sessions.length, selfBefore.audits.length, selfBefore.jobs.length]);
  // installed()의 설치 관리자와 login()의 관리자 둘이 활성이다. 나머지를 잠시 정지해 마지막 활성 관리자로 만들면 자기 탈퇴(/api/me)도 409 last_admin 이다.
  const otherAdmins = (await rows(rig)).users.filter((row: any) => row.role === "admin" && row.status === "active" && row.id !== admin.id).map((row: any) => row.id as string);
  expect(otherAdmins.length).toBeGreaterThan(0);
  for (const id of otherAdmins) await rig.h.db.update(s.user).set({ status: "suspended" }).where(eq(s.user.id, id));
  const lastAdmin = await call(app, "DELETE", "/api/me", { cookie: admin.cookie, body: { password: PASSWORD }, headers: await proofHeader(rig, admin.cookie, "admin.delete", admin.id) });
  expect({ status: lastAdmin.status, json: lastAdmin.json }).toEqual({ status: 409, json: { error: "last_admin" } });
  expect((await rows(rig)).users.find((row: any) => row.id === admin.id)).toMatchObject({ role: "admin", status: "active" });
  for (const id of otherAdmins) await rig.h.db.update(s.user).set({ status: "active" }).where(eq(s.user.id, id));

  const pending = await realMember(rig, "delete-pending-proof");
  const oldVersion = (await rows(rig)).users.find((row: any) => row.id === pending.id).authVersion as number;
  await rig.h.db.update(s.user).set({ authVersion: oldVersion + 1 }).where(and(eq(s.user.id, pending.id), eq(s.user.authVersion, oldVersion)));
  const staleSession = await call(app, "DELETE", "/api/me", { cookie: pending.cookie, body: { password: PASSWORD } });
  expect(staleSession.status).toBe(401);
  await rig.h.db.update(s.user).set({ authVersion: oldVersion }).where(eq(s.user.id, pending.id));
  const nullMember = await realMember(rig, "delete-null-fingerprint");
  await rig.h.db.update(s.session).set({ credentialFingerprint: null }).where(eq(s.session.userId, nullMember.id));
  const stringMember = await realMember(rig, "delete-string-fingerprint");
  const nullDelete = await call(app, "DELETE", "/api/me", { cookie: nullMember.cookie, body: { password: PASSWORD } });
  expect(nullDelete.status).toBe(200);
  const stringDelete = await call(app, "DELETE", "/api/me", { cookie: stringMember.cookie, body: { password: PASSWORD } });
  expect(stringDelete.status).toBe(200);
  expect((await rows(rig)).users.filter((row: any) => [nullMember.id, stringMember.id].includes(row.id)).map((row: any) => row.status)).toEqual(["deleted", "deleted"]);
  const raced = await realMember(rig, "delete-proof-race");
  const racedVersion = (await rows(rig)).users.find((row: any) => row.id === raced.id).authVersion as number;
  let raceBaseline: Awaited<ReturnType<typeof rows>> | undefined;
  beforeVerifiedCommit = async (current, userId) => {
    if (userId !== raced.id) return;
    await current.h.db.update(current.h.schema.user).set({ authVersion: racedVersion + 1 }).where(eq(current.h.schema.user.id, userId));
    await current.h.db.update(current.h.schema.account).set({ password: "replaced-hash" }).where(eq(current.h.schema.account.userId, userId));
    raceBaseline = await rows(current);
  };
  const resumed = await call(app, "DELETE", "/api/me", { cookie: raced.cookie, body: { password: PASSWORD } });
  expect(resumed.status).toBe(409);
  const afterRace = await rows(rig);
  expect(afterRace.users.find((row: any) => row.id === raced.id)).toMatchObject({ status: "active", email: raced.email, authVersion: racedVersion + 1 });
  expect(afterRace.accounts.find((row: any) => row.userId === raced.id).password).toBe("replaced-hash");
  expect(afterRace.audits.filter((row: any) => row.action === "member.delete" && row.target === raced.id)).toHaveLength(0);
  expect(raceBaseline).toBeDefined();
  expect(afterRace).toEqual(raceBaseline);
  const unchanged = afterRace.users.find((row: any) => row.id === pending.id);
  expect(unchanged).toMatchObject({ status: "active", email: pending.email, authVersion: oldVersion });
  expect((await rows(rig)).audits.filter((row: any) => row.action === "member.delete" && row.target === pending.id)).toHaveLength(0);

  const durable = await realMember(rig, "delete-durable");
  const durableKey = crypto.randomUUID();
  await rig.h.db.insert(s.apiKeys).values({ id: durableKey, userId: durable.id, omnirouteKeyId: crypto.randomUUID(), keyPreview: "wxyz", state: "active", createdAt: new Date() });
  const failing = mount(rig, () => { throw new Error("management client unavailable"); });
  const delayed = await call(failing, "DELETE", `/api/admin/users/${durable.id}`, { cookie: admin.cookie });
  expect(memberDeletion.deleteMember).toHaveBeenCalledTimes(1);
  expect(vi.mocked(memberDeletion.deleteMember).mock.results[0]?.type).toBe("return");
  expect(await vi.mocked(memberDeletion.deleteMember).mock.results[0]?.value).toEqual({ deleted: true, sync: "pending" });
  expect(delayed.json).toEqual({ deleted: true, sync: "pending" });
  const durableRows = await rows(rig);
  expect(durableRows.keys.find((row: any) => row.id === durableKey)).toMatchObject({ syncState: "pending", userId: durable.id });
  expect(durableRows.jobs.some((row: any) => row.keyId === durableKey && row.action === "key.apply_state")).toBe(true);
  expect(durableRows.verifications.some((row: any) => row.identifier === `reset-password:${token}`)).toBe(false);
}
