// TC-M4.T2·T4 삭제·자기 탈퇴 단언. 작성만 승인됐고 실행하지 않는다.
// 가입·로그인·재설정은 설치된 Better Auth handler 를 그대로 쓰고, 삭제 라우트만 독립 Hono 에서 확인한다.
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { expect, vi } from "vitest";
import * as memberDeletion from "../../src/admin/delete.ts";
import { memberAdminRoutes } from "../../src/admin/members.ts";
import { selfDeleteRoutes } from "../../src/admin/self-delete.ts";
import { KEY_DELETE_DELAY_MS } from "../../src/queue/index.ts";
import { sameOrigin } from "../../src/routes/guard.ts";
import { installed, login, type CallOpts, type HttpRig } from "../signup/checks.ts";
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
  expect((await call(app, "DELETE", "/api/me", { cookie: admin.cookie, body: { password: PASSWORD } })).status).toBe(409);
  await rig.h.db.update(s.user).set({ isBootstrapAdmin: false }).where(eq(s.user.id, admin.id));
  expect((await call(app, "DELETE", `/api/admin/users/${admin.id}`, { cookie: admin.cookie })).json.error).toBe("last_admin");

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
