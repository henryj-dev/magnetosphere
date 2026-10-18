// M5 SMTP: 기본 Node 시험. 네트워크 전송은 주입 계약으로 관찰하고 실제 smtpMailer 연결은 auth 의 mailpit 시험이 맡는다.
// 실패 출력에 비밀 값·암호문·응답 원문이 찍히지 않도록 비밀 비교는 boolean 으로 하고 expect 메시지는 고정 문구만 쓴다.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildServices } from "../../src/config.ts";
import { ensureSetupToken, SETUP_TOKEN_KEY } from "../../src/setup/index.ts";
import { MAIL_API_KEY_AAD, MAIL_SETTINGS_KEY, settingsMailer, SMTP_PASSWORD_AAD, type SmtpFactory } from "../../src/setup/mail.ts";
import { makeTestEnv, ADMIN, type TestEnv } from "../helpers.ts";
import { login } from "../signup/checks.ts";
import { serverRig, type ServerRig } from "../signup/env.ts";

const SMTP = { provider: "smtp", host: "127.0.0.1", port: 1025, secure: false, user: "mg", password: "mgpass-fixed-test", from: "no-reply@mg.test" } as const;
let t: TestEnv;
let rig: ServerRig;
let options: Parameters<SmtpFactory>[0][];
let sends: number;
let failure: Error | undefined;
beforeEach(async () => {
  t = await makeTestEnv();
  rig = await serverRig("SMTP SQLite", { url: t.env.DATABASE_URL });
  options = [];
  sends = 0;
  failure = undefined;
  const services = await buildServices({
    db: async () => rig.h, secret: (name) => t.env[name], clientIp: () => "198.18.0.1",
    schedule() {}, rateLimitStore: () => ({ storage: "database" }), close: async () => {},
  }, { waitUntil: (p) => void p, smtp: (o) => { options.push(o); return { send: async () => { if (failure) throw failure; sends++; } }; } });
  Object.assign(rig.services, services);
});
afterEach(async () => { vi.restoreAllMocks(); await rig?.close(); t?.cleanup(); });
const settings = async (key = MAIL_SETTINGS_KEY) => {
  const s = rig.h.schema.appSettings;
  return (await rig.h.db.select().from(s).where(eq(s.key, key)))[0];
};
/** 비밀 값이 들어 있는지만 본다. 실패해도 원문은 출력하지 않는다 */
const leaks = (value: string, ...secrets: string[]) => secrets.some((x) => value.includes(x));
/** 복호화 결과를 원문 대신 일치 여부로만 돌려준다. 복호화가 거부되면 "rejected" */
const decrypts = (ct: string, aad: string, want: string) => rig.services.cipher.decrypt(ct, aad).then((v) => v === want, () => "rejected" as const);
/** 전송 옵션에서 pass 를 뺀 값과 pass 일치 여부 */
const sent = (o: Parameters<SmtpFactory>[0], pass: string | undefined) => {
  const { pass: actual, ...rest } = o;
  return { ...rest, passMatches: actual === pass };
};

it("TC-M5.T0.a Node SMTP 저장·AAD 암호화·GET 및 감사 기록 비밀 미노출·전송 옵션", async () => {
  const admin = await login(rig, "admin");
  const r = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: SMTP });
  expect(r.status, "SMTP 저장 응답").toBe(200);
  expect(r.json).toEqual({ mailConfigured: true, provider: "smtp", from: SMTP.from });
  const row = await settings();
  const stored = JSON.parse(row.value);
  expect(/^v1:/.test(stored.password), "암호문 형식").toBe(true);
  expect(leaks(row.value, SMTP.password), "저장 행 평문 비밀번호").toBe(false);
  expect(await decrypts(stored.password, SMTP_PASSWORD_AAD, SMTP.password), "SMTP AAD 복호화").toBe(true);
  expect(await decrypts(stored.password, MAIL_API_KEY_AAD, SMTP.password), "다른 AAD 복호화").toBe("rejected");
  const get = await rig.call("GET", "/api/admin/settings/signup", { cookie: admin.cookie });
  expect(get.json.mailConfigured).toBe(true);
  for (const value of [r.body, get.body, JSON.stringify(await rig.h.db.select().from(rig.h.schema.auditLog))]) {
    expect(leaks(value, SMTP.password, stored.password), "응답·감사 기록 비밀 값").toBe(false);
  }
  expect(await rig.op("audits", "settings.update")).toBe(1);
  expect((await rig.call("POST", "/api/admin/settings/mail/test", { cookie: admin.cookie })).status).toBe(200);
  expect(sends).toBe(1);
  expect(options.map((o) => sent(o, SMTP.password))).toEqual([{ host: SMTP.host, port: 1025, secure: false, requireTLS: true, user: "mg", from: SMTP.from, passMatches: true }]);
});

it("TC-M5.T0.b SMTP 잘못된 필드·옵션·설정 지우기 시도는 400, 저장·감사 기록 그대로", async () => {
  const admin = await login(rig, "admin");
  expect((await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: SMTP })).status).toBe(200);
  const before = (await settings()).value;
  const invalid: unknown[] = [null, {}, { provider: "none" }, ...[
    { host: "" }, { host: "smtp://mailpit" }, { host: "mailpit:1025" }, { host: "a/b" }, { host: "a\r\nb" },
    { host: "-relay" }, { host: "a".repeat(64) }, { host: "256.1.1.1" }, { host: "::1" },
    { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: "1025" }, { secure: "false" }, { secure: undefined },
    { requireTLS: "false" }, { secure: true, requireTLS: false }, { user: "" }, { user: "mg\r\n" },
    { password: undefined }, { password: "" }, { password: "x".repeat(513) }, { password: "a\nb" }, { user: undefined },
    { from: "Name <a@example.com>" }, { from: "a@example.com,b@example.com" }, { from: "a@localhost" },
    { tls: { rejectUnauthorized: false } }, { ignoreTLS: true }, { apiKey: "wrong-secret-field" },
  ].map((patch) => ({ ...SMTP, ...patch }))];
  for (const [i, body] of invalid.entries()) {
    const r = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body });
    expect([r.status, r.json?.error], `잘못된 메일 입력 #${i}`).toEqual([400, "invalid_mail"]);
    expect((await settings()).value === before, `잘못된 메일 입력 #${i} 저장 행`).toBe(true);
  }
  expect(await rig.op("audits", "settings.update")).toBe(1);
});

it("TC-M5.T0.c SMTP 는 활성 관리자와 같은 Origin 만 받는다", async () => {
  const admin = await login(rig, "admin");
  const member = await login(rig, "member");
  // 정지는 운영 정지 API 로 한다. 정지 전 쿠키는 세션이 지워져 기존 계약대로 401 이다 (signup/policy.test.ts).
  // 유효한 세션을 가진 정지 관리자의 403 은 sessions/member-guard.test.ts 가 가짜 인증으로 검사한다.
  const suspended = await login(rig, "admin");
  const stopped = await rig.call("POST", `/api/admin/users/${suspended.id}/suspend`, { cookie: admin.cookie });
  expect(stopped.status, "관리자 정지 응답").toBe(200);
  expect(await rig.op("user", suspended.email)).toMatchObject({ role: "admin", status: "suspended" });
  expect(await rig.op("sessionsOf", suspended.email)).toBe(0);
  for (const [o, status, error] of [[{}, 401, "unauthorized"], [{ cookie: member.cookie }, 403, "forbidden"], [{ cookie: suspended.cookie }, 401, "unauthorized"],
    [{ cookie: admin.cookie, origin: "https://outside.test" }, 403, "forbidden_origin"], [{ cookie: admin.cookie, origin: null }, 403, "forbidden_origin"]] as const) {
    const r = await rig.call("PUT", "/api/admin/settings/mail", { ...o, body: SMTP });
    expect([r.status, r.json?.error]).toEqual([status, error]);
  }
  expect(await settings()).toBeUndefined();
  expect(await rig.op("audits", "settings.update")).toBe(0);
});

it("TC-M5.T0.d setup SMTP 는 토큰·Origin·입력을 검사한 뒤 저장한다", async () => {
  const token = await ensureSetupToken(rig.h, { rotate: false, log: () => {} });
  const body = { ...ADMIN, token, mail: { ...SMTP, requireTLS: false } };
  expect((await rig.call("POST", "/api/setup", { body: { ...body, token: "wrong" } })).status).toBe(401);
  expect((await rig.call("POST", "/api/setup", { body, origin: "https://outside.test" })).status).toBe(403);
  const bad = await rig.call("POST", "/api/setup", { body: { ...body, mail: { ...SMTP, port: 0 } } });
  expect([bad.status, bad.json.error]).toEqual([400, "invalid_mail"]);
  expect(await settings(SETUP_TOKEN_KEY)).toBeDefined();
  expect(await rig.op("userCount")).toBe(0);
  const r = await rig.call("POST", "/api/setup", { body });
  expect(r.status, "설치 응답").toBe(201);
  expect(leaks(r.body, SMTP.password), "설치 응답 비밀번호").toBe(false);
  const stored = JSON.parse((await settings()).value);
  expect(stored.requireTLS).toBe(false);
  expect(await decrypts(stored.password, SMTP_PASSWORD_AAD, SMTP.password), "SMTP AAD 복호화").toBe(true);
  await rig.services.mailer!.send({ to: "admin@example.com", subject: "test", text: "test", html: "<p>test</p>" });
  expect(options[0].requireTLS).toBe(false);
});

it("TC-M5.T0.e SMTP 인증 생략·TLS 기본값·비밀번호 공백 보존", async () => {
  const admin = await login(rig, "admin");
  for (const body of [{ ...SMTP, user: undefined, password: undefined, secure: true, port: 465 },
    { ...SMTP, user: " mg ", password: " fixed-test-pass " }]) {
    const r = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body });
    expect(r.status, "SMTP 저장 응답").toBe(200);
    await rig.services.mailer!.send({ to: admin.email, subject: "test", text: "test", html: "<p>test</p>" });
  }
  expect(sent(options[0], undefined)).toMatchObject({ secure: true, requireTLS: false, user: undefined, passMatches: true });
  expect(sent(options[1], " fixed-test-pass ")).toMatchObject({ secure: false, requireTLS: true, user: "mg", passMatches: true });
});

it("TC-M5.T0.f Node SMTP 비활성 런타임은 저장 거부·기존 SMTP 전송도 fallback 하지 않는다", async () => {
  const admin = await login(rig, "admin");
  expect((await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: SMTP })).status).toBe(200);
  const before = (await settings()).value;
  rig.services.mailCapabilities = { smtp: false, cloudflare: false };
  const r = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: SMTP });
  expect([r.status, r.json.error]).toEqual([400, "smtp_unsupported"]);
  expect((await settings()).value === before, "저장 행").toBe(true);
  const { settingsMailer } = await import("../../src/setup/mail.ts");
  let fallback = 0;
  const mailer = settingsMailer(async () => rig.h, async () => rig.services.cipher, { send: async () => { fallback++; } });
  await expect(mailer.send({ to: admin.email, subject: "test", text: "test", html: "<p>test</p>" })).rejects.toThrow("SMTP");
  expect(fallback).toBe(0);
});

it("TC-M5.T0.smtp.corrupt 손상·변조된 메일 설정 행은 전송·fallback·네트워크 호출 없이 고정 MailError, 테스트 메일은 502", async () => {
  const admin = await login(rig, "admin");
  expect((await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: SMTP })).status).toBe(200);
  const valid = JSON.parse((await settings()).value) as Record<string, unknown>;
  const cipher = rig.services.cipher;
  const apiKey = await cipher.encrypt("fixed-test-api-key", MAIL_API_KEY_AAD);
  const t0 = rig.h.schema.appSettings;
  const write = (value: string) => rig.h.db.update(t0).set({ value }).where(eq(t0.key, MAIL_SETTINGS_KEY));
  const smtpRow = (patch: Record<string, unknown>) => JSON.stringify({ ...valid, ...patch });
  const rows = [
    "{", "null", "[]", '"smtp"', JSON.stringify({ provider: "smtp" }), JSON.stringify({ provider: "none", from: SMTP.from }),
    smtpRow({ password: SMTP.password }), smtpRow({ password: "v1:not base64!" }), smtpRow({ password: 1 }), smtpRow({ user: undefined }),
    smtpRow({ requireTLS: undefined }), smtpRow({ requireTLS: "true" }), smtpRow({ secure: "true" }), smtpRow({ host: "smtp://mailpit" }),
    smtpRow({ port: "1025" }), smtpRow({ from: "Name <a@example.com>" }), smtpRow({ tls: { rejectUnauthorized: false } }), smtpRow({ apiKey }),
    JSON.stringify({ provider: "resend", from: SMTP.from, apiKey: "fixed-test-api-key" }), JSON.stringify({ provider: "resend", from: SMTP.from, apiKey, host: "mailpit" }),
    JSON.stringify({ provider: "cloudflare", from: SMTP.from, apiKey }),
    // 형식은 맞지만 다른 비밀 값 자리의 AAD 로 봉인한 암호문 (바꿔 붙이기)
    smtpRow({ password: await cipher.encrypt(SMTP.password, MAIL_API_KEY_AAD) }),
    JSON.stringify({ provider: "resend", from: SMTP.from, apiKey: await cipher.encrypt("fixed-test-api-key", SMTP_PASSWORD_AAD) }),
  ];
  const net = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("network-not-allowed"); });
  let built = 0;
  let bound = 0;
  let fallback = 0;
  const mailer = settingsMailer(async () => rig.h, async () => cipher, { send: async () => { fallback++; } },
    () => { built++; return { send: async () => {} }; }, { send: async () => { bound++; return {}; } });
  const msg = { to: admin.email, subject: "test", text: "test", html: "<p>test</p>" };
  for (const [i, value] of rows.entries()) {
    await write(value);
    const err = await mailer.send(msg).then(() => null, (e: unknown) => e);
    expect(err instanceof Error && err.name === "MailError" && err.message.endsWith("저장된 메일 설정이 올바르지 않다"), `손상된 저장 행 #${i}`).toBe(true);
  }
  expect([built, bound, fallback, net.mock.calls.length], "전송·fallback·네트워크 호출 수").toEqual([0, 0, 0, 0]);
  net.mockRestore();
  // 관리자 테스트 메일도 같은 고정 실패로 끝난다
  await write(JSON.stringify({ provider: "smtp" }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const test = await rig.call("POST", "/api/admin/settings/mail/test", { cookie: admin.cookie });
  expect([test.status, test.json?.error]).toEqual([502, "mail_failed"]);
  expect(log.mock.calls.length === 1 && log.mock.calls[0].length === 1 && log.mock.calls[0][0] === "[mail] 테스트 메일을 보내지 못했다", "테스트 메일 실패 로그").toBe(true);
  expect([options.length, sends], "서비스 전송 수").toEqual([0, 0]);
  // 대조: 저장 API 가 쓴 그대로의 행은 받는다
  await write(JSON.stringify(valid));
  await mailer.send(msg);
  expect(built, "정상 행 전송").toBe(1);
});

it("TC-M5.T0.g Resend 는 SMTP 도입 뒤에도 기존 AAD·응답 계약을 유지한다", async () => {
  const admin = await login(rig, "admin");
  const r = await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: { provider: "resend", apiKey: " fixed-test-api-key ", from: " no-reply@mg.test " } });
  expect(r.json).toEqual({ mailConfigured: true, provider: "resend", from: SMTP.from });
  const stored = JSON.parse((await settings()).value);
  expect(await decrypts(stored.apiKey, MAIL_API_KEY_AAD, "fixed-test-api-key"), "API 키 AAD 복호화").toBe(true);
  expect(leaks(r.body, "fixed-test-api-key"), "응답 API 키").toBe(false);
});

it("TC-M5.T0.l SMTP 실패 응답·인증 메일 오류 로그에는 비밀 값·주소·공급자 원문이 없다", async () => {
  const admin = await login(rig, "admin");
  expect((await rig.call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: SMTP })).status).toBe(200);
  failure = new Error(`provider-raw-error ${SMTP.password} ${admin.email}`);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const only = (line: string) => (call: unknown[]) => call.length === 1 && call[0] === line;
  const test = await rig.call("POST", "/api/admin/settings/mail/test", { cookie: admin.cookie });
  expect([test.status, test.json.error]).toEqual([502, "mail_failed"]);
  expect(log.mock.calls.length === 1 && only("[mail] 테스트 메일을 보내지 못했다")(log.mock.calls[0]), "테스트 메일 실패 로그").toBe(true);
  const reset = await rig.call("POST", "/api/auth/request-password-reset", { body: { email: admin.email, redirectTo: "/reset" } });
  expect(reset.status, "비밀번호 재설정 요청 응답").toBe(200);
  await vi.waitFor(() => expect(log.mock.calls.some(only("[mail] 메일을 보내지 못했다")), "인증 메일 실패 로그").toBe(true));
  for (const value of [test.body, reset.body, JSON.stringify(log.mock.calls)]) {
    expect(leaks(value, SMTP.password, admin.email, "provider-raw-error"), "응답·로그 비밀 값·주소·공급자 원문").toBe(false);
  }
});

it("TC-M5.T0.h Workers 의 로컬 import 경로에는 SMTP·nodemailer 가 없고 Node 경로에는 있다", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  function graph(entry: string) {
    const seen = new Set<string>();
    const external = new Set<string>();
    function visit(file: string) {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      const imports = [...source.matchAll(/(?:import|export)\s+(?!type\b)(?:[^;"']*?\s+from\s*)?["']([^"']+)["']/g),
        ...source.matchAll(/import\(["']([^"']+)["']\)/g)];
      for (const [, spec] of imports) {
        let target: string | undefined;
        if (spec.startsWith(".")) target = path.resolve(path.dirname(file), spec);
        else if (spec.startsWith("@magnetosphere/")) {
          const [, name, ...parts] = spec.split("/");
          const pkgDir = path.join(root, "packages", name);
          const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
          const key = parts.length ? `./${parts.join("/")}` : ".";
          const exported = pkg.exports?.[key];
          if (typeof exported === "string") target = path.join(pkgDir, exported);
          else if (parts[0] === "src") target = path.join(pkgDir, ...parts);
          else throw new Error(`해석하지 못한 workspace import: ${spec}`);
        } else external.add(spec);
        if (target) { expect(existsSync(target), target).toBe(true); visit(target); }
      }
    }
    visit(path.join(root, entry));
    return { seen: [...seen], external };
  }
  const workers = graph("apps/server/src/workers.ts");
  expect(workers.seen.some((p) => p.endsWith("/mail/smtp.ts"))).toBe(false);
  expect(workers.external.has("nodemailer")).toBe(false);
  const node = graph("apps/server/src/node.ts");
  expect(node.seen.some((p) => p.endsWith("/mail/smtp.ts"))).toBe(true);
  expect(node.external.has("nodemailer")).toBe(true);
});
