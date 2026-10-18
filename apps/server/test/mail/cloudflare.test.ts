// M5 Cloudflare Email Service: 기본 Node 시험. Node 진입점은 send_email 바인딩을 주입하지 않으므로 저장을 거부한다.
// 바인딩이 있을 때의 저장·전송 계약은 가짜 바인딩 하나로 본다 (실제 send_email 은 Workers 진입점과 E2E 가 맡는다).
// 실패 출력에 주소·공급자 원문이 찍히지 않도록 누출 비교는 boolean 으로 하고 expect 메시지는 고정 문구만 쓴다.
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SendEmailBinding } from "@magnetosphere/auth/mail";
import { buildServices } from "../../src/config.ts";
import { mailConfigured } from "../../src/settings/index.ts";
import { ensureSetupToken, SETUP_TOKEN_KEY } from "../../src/setup/index.ts";
import { MAIL_SETTINGS_KEY, settingsMailer } from "../../src/setup/mail.ts";
import { makeTestEnv, ADMIN, type TestEnv } from "../helpers.ts";
import { login } from "../signup/checks.ts";
import { serverRig, type ServerRig } from "../signup/env.ts";

const FROM = "no-reply@mg.test";
const CLOUDFLARE = { provider: "cloudflare", from: FROM } as const;
type Sent = Parameters<SendEmailBinding["send"]>[0];
let t: TestEnv;
let rig: ServerRig;
let sent: Sent[];
let failure: unknown;
const binding: SendEmailBinding = { send: async (m) => { if (failure) throw failure; sent.push(m); return { messageId: "m5-fixed-message-id" }; } };
/** Node 진입점과 같은 서비스(바인딩 없음) 또는 Workers 진입점처럼 바인딩을 넘긴 서비스로 바꾼다 */
const useServices = async (cloudflareEmail?: SendEmailBinding) => Object.assign(rig.services, await buildServices({
  db: async () => rig.h, secret: (name) => t.env[name], clientIp: () => "198.18.0.2",
  schedule() {}, rateLimitStore: () => ({ storage: "database" }), close: async () => {},
}, { waitUntil: (p) => void p, cloudflareEmail }));
beforeEach(async () => {
  t = await makeTestEnv();
  rig = await serverRig("Cloudflare 메일 SQLite", { url: t.env.DATABASE_URL });
  sent = [];
  failure = undefined;
});
afterEach(async () => { vi.restoreAllMocks(); await rig?.close(); t?.cleanup(); });
const settings = async (key = MAIL_SETTINGS_KEY) => {
  const s = rig.h.schema.appSettings;
  return (await rig.h.db.select().from(s).where(eq(s.key, key)))[0];
};
/** 값이 들어 있는지만 본다. 실패해도 원문은 출력하지 않는다 */
const leaks = (value: string, ...secrets: string[]) => secrets.some((x) => value.includes(x));
/** 저장 행이 정확히 { provider: "cloudflare", from } 인가. 다르면 원문 대신 false 만 낸다 */
const storedCloudflare = (value: string) => {
  const s = JSON.parse(value) as Record<string, unknown>;
  return Object.keys(s).sort().join(",") === "from,provider" && s.provider === "cloudflare" && s.from === FROM;
};

it("TC-M5.T0.cloudflare.a Node 기본은 Cloudflare 저장 400 cloudflare_unsupported·권한과 Origin 검사가 먼저·설정과 감사 기록 그대로", async () => {
  await useServices();
  expect(rig.services.mailCapabilities).toEqual({ smtp: false, cloudflare: false });
  const admin = await login(rig, "admin");
  const member = await login(rig, "member");
  for (const [o, status, error] of [[{}, 401, "unauthorized"], [{ cookie: member.cookie }, 403, "forbidden"],
    [{ cookie: admin.cookie, origin: "https://outside.test" }, 403, "forbidden_origin"], [{ cookie: admin.cookie, origin: null }, 403, "forbidden_origin"],
    [{ cookie: admin.cookie }, 400, "cloudflare_unsupported"]] as const) {
    const r = await rig.call("PUT", "/api/admin/settings/mail", { ...o, body: CLOUDFLARE });
    expect([r.status, r.json?.error]).toEqual([status, error]);
  }
  // 입력이 잘못돼도 지원 여부를 먼저 알린다 (SMTP 와 같은 순서)
  const bad = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: { provider: "cloudflare", from: "not-an-address" } });
  expect([bad.status, bad.json?.error]).toEqual([400, "cloudflare_unsupported"]);
  expect(await settings()).toBeUndefined();
  expect(await rig.op("audits", "settings.update")).toBe(0);
  const get = await rig.call("GET", "/api/admin/settings/signup", { cookie: admin.cookie });
  expect(get.json.mailConfigured).toBe(false);
});

it("TC-M5.T0.cloudflare.b Node setup Cloudflare 는 토큰·Origin 검사 뒤 400·관리자 미생성·토큰 미소비, 같은 토큰으로 설치 가능", async () => {
  await useServices();
  const token = await ensureSetupToken(rig.h, { rotate: false, log: () => {} });
  const body = { ...ADMIN, token, mail: CLOUDFLARE };
  const wrong = await rig.call("POST", "/api/setup", { body: { ...body, token: "wrong" } });
  expect([wrong.status, wrong.json?.error]).toEqual([401, "invalid_token"]);
  expect((await rig.call("POST", "/api/setup", { body, origin: "https://outside.test" })).status).toBe(403);
  const r = await rig.call("POST", "/api/setup", { body });
  expect([r.status, r.json?.error]).toEqual([400, "cloudflare_unsupported"]);
  expect(await settings()).toBeUndefined();
  expect(await settings(SETUP_TOKEN_KEY)).toBeDefined();
  expect(await rig.op("userCount")).toBe(0);
  const ok = await rig.call("POST", "/api/setup", { body: { ...ADMIN, token } });
  expect(ok.status, "설치 응답").toBe(201);
});

it("TC-M5.T0.cloudflare.c 바인딩이 있으면 비밀 값 없이 저장·감사 기록 한 번에·mailConfigured 로 open 허용·전송 옵션", async () => {
  await useServices(binding);
  expect(rig.services.mailCapabilities).toEqual({ smtp: false, cloudflare: true });
  const admin = await login(rig, "admin");
  // Resend 에서 바꿔도 이전 API 키 암호문이 행에 남지 않는다
  expect((await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: { provider: "resend", apiKey: "m5-fixed-test-resend-key", from: FROM } })).status).toBe(200);
  const r = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: { provider: "cloudflare", from: ` ${FROM} ` } });
  expect(r.status, "Cloudflare 저장 응답").toBe(200);
  const keys = Object.keys(r.json ?? {}).sort().join(",");
  expect(keys === "from,mailConfigured,provider" && r.json.mailConfigured === true && r.json.provider === "cloudflare" && r.json.from === FROM, "Cloudflare 저장 응답 본문").toBe(true);
  const row = await settings();
  expect(storedCloudflare(row.value), "저장 행 모양").toBe(true);
  expect(leaks(row.value, "m5-fixed-test-resend-key", "v1:"), "저장 행 비밀 값·암호문").toBe(false);
  // 설정 쓰기와 감사 기록은 같은 커밋이다. 감사 기록에는 보내는 주소를 넣지 않는다 (Q17)
  const rows: { action: string; detail: unknown }[] = await rig.h.db.select().from(rig.h.schema.auditLog);
  const audits = rows.filter((a) => a.action === "settings.update");
  expect(audits.length).toBe(2);
  expect(audits.some((a) => JSON.stringify(a.detail ?? "").includes("cloudflare")), "Cloudflare 감사 기록").toBe(true);
  expect(leaks(JSON.stringify(audits), FROM, "m5-fixed-test-resend-key"), "감사 기록 주소·비밀 값").toBe(false);
  const get = await rig.call("GET", "/api/admin/settings/signup", { cookie: admin.cookie });
  expect(get.json.mailConfigured).toBe(true);
  const open = await rig.call("PATCH", "/api/admin/settings/signup", { cookie: admin.cookie, body: { signupMode: "open", updatedAt: { signupMode: get.json.updatedAt.signupMode } } });
  expect(open.status, "open 전환 응답").toBe(200);
  const test = await rig.call("POST", "/api/admin/settings/mail/test", { cookie: admin.cookie });
  expect([test.status, test.json?.sent]).toEqual([200, true]);
  expect(sent.length).toBe(1);
  expect(Object.keys(sent[0]).sort()).toEqual(["from", "html", "subject", "text", "to"]);
  expect(sent[0].to === admin.email, "받는 주소").toBe(true);
  expect(JSON.stringify(sent[0].from) === JSON.stringify({ email: FROM }), "보내는 주소").toBe(true);
  expect([typeof sent[0].subject, typeof sent[0].text, typeof sent[0].html]).toEqual(["string", "string", "string"]);
});

it("TC-M5.T0.cloudflare.d Cloudflare 잘못된 from·남는 키는 400 invalid_mail, 저장·감사 기록 그대로", async () => {
  await useServices(binding);
  const admin = await login(rig, "admin");
  expect((await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: CLOUDFLARE })).status).toBe(200);
  const before = (await settings()).value;
  const invalid: unknown[] = [{ provider: "cloudflare" }, ...[
    { from: "" }, { from: " " }, { from: 1 }, { from: null }, { from: "Name <a@example.com>" }, { from: "a@example.com,b@example.com" },
    { from: "a@localhost" }, { from: "a@exa\nmple.com" }, { from: `${"a".repeat(250)}@mg.test` },
    { name: "Magnetosphere" }, { apiKey: "wrong-secret-field" }, { password: "wrong-secret-field" }, { binding: "EMAIL" }, { accountId: "x" },
  ].map((patch) => ({ ...CLOUDFLARE, ...patch }))];
  for (const [i, body] of invalid.entries()) {
    const r = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body });
    expect([r.status, r.json?.error], `잘못된 메일 입력 #${i}`).toEqual([400, "invalid_mail"]);
    expect((await settings()).value === before, `잘못된 메일 입력 #${i} 저장 행`).toBe(true);
  }
  expect(await rig.op("audits", "settings.update")).toBe(1);
});

it("TC-M5.T0.cloudflare.e 바인딩 오류 응답·인증 메일 오류 로그에는 주소·오류 코드·공급자 원문이 없다", async () => {
  await useServices(binding);
  const admin = await login(rig, "admin");
  expect((await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: CLOUDFLARE })).status).toBe(200);
  // 공식 바인딩은 E_* code 가 달린 Error 를 던진다
  failure = Object.assign(new Error(`provider-raw-error ${FROM} ${admin.email}`), { code: "E_SENDER_NOT_VERIFIED" });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const only = (line: string) => (call: unknown[]) => call.length === 1 && call[0] === line;
  const test = await rig.call("POST", "/api/admin/settings/mail/test", { cookie: admin.cookie });
  expect([test.status, test.json?.error]).toEqual([502, "mail_failed"]);
  expect(log.mock.calls.length === 1 && only("[mail] 테스트 메일을 보내지 못했다")(log.mock.calls[0]), "테스트 메일 실패 로그").toBe(true);
  const reset = await rig.call("POST", "/api/auth/request-password-reset", { body: { email: admin.email, redirectTo: "/reset" } });
  expect(reset.status, "비밀번호 재설정 요청 응답").toBe(200);
  await vi.waitFor(() => expect(log.mock.calls.some(only("[mail] 메일을 보내지 못했다")), "인증 메일 실패 로그").toBe(true));
  for (const value of [test.body, reset.body, JSON.stringify(log.mock.calls)]) {
    expect(leaks(value, FROM, admin.email, "provider-raw-error", "E_SENDER_NOT_VERIFIED"), "응답·로그 주소·공급자 원문").toBe(false);
  }
  expect(sent.length).toBe(0);
});

it("TC-M5.T0.cloudflare.f 저장된 Cloudflare 설정은 바인딩 없는 런타임에서 fallback 하지 않고 실패한다·Workers 진입점만 env.EMAIL 을 넘긴다", async () => {
  await useServices(binding);
  const admin = await login(rig, "admin");
  expect((await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: CLOUDFLARE })).status).toBe(200);
  let fallback = 0;
  const msg = { to: admin.email, subject: "test", text: "test", html: "<p>test</p>" };
  for (const smtp of [undefined, () => ({ send: async () => { fallback++; } })]) {
    const mailer = settingsMailer(async () => rig.h, async () => rig.services.cipher, { send: async () => { fallback++; } }, smtp);
    await expect(mailer.send(msg)).rejects.toThrow("[mail:cloudflare]");
  }
  expect([fallback, sent.length]).toEqual([0, 0]);
  await settingsMailer(async () => rig.h, async () => rig.services.cipher, { send: async () => { fallback++; } }, undefined, binding).send(msg);
  expect([fallback, sent.length]).toEqual([0, 1]);
  // Node 진입점은 바인딩을 넘기지 않고, Workers 진입점은 env.EMAIL 이 함수 send 를 가질 때만 넘긴다
  const source = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  expect(source("../../src/node.ts").includes("cloudflareEmail")).toBe(false);
  expect(source("../../src/workers.ts").match(/buildServices\(runtime, \{ waitUntil, cloudflareEmail \}\)/g)?.length).toBe(2);
});

it("TC-M5.T0.cloudflare.g setup Cloudflare 는 바인딩이 있으면 토큰·Origin·입력을 검사한 뒤 비밀 값 없이 저장한다", async () => {
  await useServices(binding);
  const token = await ensureSetupToken(rig.h, { rotate: false, log: () => {} });
  const body = { ...ADMIN, token, mail: { provider: "cloudflare", from: ` ${FROM} ` } };
  expect((await rig.call("POST", "/api/setup", { body: { ...body, token: "wrong" } })).status).toBe(401);
  expect((await rig.call("POST", "/api/setup", { body, origin: "https://outside.test" })).status).toBe(403);
  const bad = await rig.call("POST", "/api/setup", { body: { ...body, mail: { ...CLOUDFLARE, apiKey: "wrong-secret-field" } } });
  expect([bad.status, bad.json?.error]).toEqual([400, "invalid_mail"]);
  expect(await settings(SETUP_TOKEN_KEY)).toBeDefined();
  expect(await rig.op("userCount")).toBe(0);
  const r = await rig.call("POST", "/api/setup", { body });
  expect(r.status, "설치 응답").toBe(201);
  expect(storedCloudflare((await settings()).value), "저장 행 모양").toBe(true);
  expect(await mailConfigured(rig.h)).toBe(true);
  await rig.services.mailer!.send({ to: ADMIN.email, subject: "test", text: "test", html: "<p>test</p>" });
  expect(JSON.stringify(sent.map((m) => m.from)) === JSON.stringify([{ email: FROM }]), "보내는 주소").toBe(true);
});
