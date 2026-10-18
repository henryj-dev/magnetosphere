// M5 Workers + D1: SMTP 저장은 명시적으로 거부한다. 기존 시험 Worker 를 쓰고 배포 설정은 바꾸지 않는다.
// 실패 출력에 비밀 값·암호문·응답 원문이 찍히지 않도록 비밀 비교는 boolean 으로 하고 expect 메시지는 고정 문구만 쓴다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PASSWORD } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { ADMIN, TEST_ENCRYPTION_KEY, TEST_SECRET } from "../helpers.ts";
import { callRes, type CallOpts } from "../signup/checks.ts";
import { startWranglerDev, wrangler, type WranglerDev } from "../wrangler-dev.mjs";

const CONFIG = "test/signup/wrangler.jsonc";
const SETUP_TOKEN = "m5-fixed-test-setup-token-0123456789";
const SMTP = { provider: "smtp", host: "mailpit", port: 1025, secure: false, requireTLS: false, user: "mg", password: "mgpass-fixed-test", from: "no-reply@mg.test" };
let persistTo: string;
let d: WranglerDev;
beforeEach(async () => {
  persistTo = mkdtempSync(path.join(tmpdir(), "mg-smtp-d1-"));
  const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
  expect(mig.code, `${mig.out}${mig.err}`).toBe(0);
  d = await startWranglerDev({ config: CONFIG, persistTo, vars: { BETTER_AUTH_SECRET: TEST_SECRET, APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, SETUP_TOKEN } });
});
afterEach(async () => { await d?.close(); if (persistTo) rmSync(persistTo, { recursive: true, force: true }); });
const call = async (method: string, p: string, o: CallOpts = {}) => callRes(await fetch(`${d.baseUrl}${p}`, {
  method, redirect: "manual",
  headers: { "x-test-ip": `198.18.0.${Math.floor(Math.random() * 200) + 1}`, ...(o.origin === null ? {} : { origin: o.origin ?? d.baseUrl }),
    ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body === undefined ? {} : { "content-type": "application/json" }) },
  body: o.body === undefined ? undefined : JSON.stringify(o.body),
}));
const op = async (name: string, ...args: unknown[]) => {
  const r = await fetch(`${d.baseUrl}/__test/db`, { method: "POST", body: JSON.stringify({ op: name, args }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { result: unknown }).result;
};
/** 비밀 값이 들어 있는지만 본다. 실패해도 원문은 출력하지 않는다 */
const leaks = (value: string, ...secrets: string[]) => secrets.some((x) => value.includes(x));
async function login(role: "admin" | "member", tag: string) {
  const email = `m5-${role}-${tag}@example.test`;
  const id = (await op("addPasswordUser", email, PASSWORD, role, "active")) as string;
  const r = await call("POST", "/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
  expect(r.status, "로그인 응답").toBe(200);
  return { id, email, cookie: r.setCookie.map((c) => c.split(";")[0]).join("; ") };
}
function mailRows() {
  const r = wrangler(["d1", "execute", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo, "--json", "--command", "SELECT value FROM app_settings WHERE key = 'mail_settings'"]);
  expect(r.code, "메일 설정 행 조회").toBe(0);
  return JSON.parse(r.out)[0].results as { value: string }[];
}

it("TC-M5.T0.i Workers SMTP 설정은 400 smtp_unsupported·설정과 감사 기록 그대로·Resend 대조", async () => {
  const { cookie } = await login("admin", "i");
  const r = await call("PUT", "/api/admin/settings/mail", { cookie, body: SMTP });
  expect([r.status, r.json.error]).toEqual([400, "smtp_unsupported"]);
  expect(leaks(r.body, SMTP.password), "거부 응답 비밀번호").toBe(false);
  expect(mailRows().length, "메일 설정 행 수").toBe(0);
  expect(await op("audits", "settings.update")).toBe(0);
  const resend = await call("PUT", "/api/admin/settings/mail", { cookie, body: { provider: "resend", apiKey: "m5-fixed-test-resend-key", from: SMTP.from } });
  expect(resend.status, "Resend 저장 응답").toBe(200);
  const before = mailRows();
  expect(before.length, "메일 설정 행 수").toBe(1);
  expect(leaks(before[0].value, "m5-fixed-test-resend-key"), "저장 행 평문 API 키").toBe(false);
  expect((await call("PUT", "/api/admin/settings/mail", { cookie, body: SMTP })).json.error).toBe("smtp_unsupported");
  expect(JSON.stringify(mailRows()) === JSON.stringify(before), "저장 행").toBe(true);
  expect(await op("audits", "settings.update")).toBe(1);
  const get = await call("GET", "/api/admin/settings/signup", { cookie });
  expect(get.json.mailConfigured).toBe(true);
  expect(leaks(get.body, "m5-fixed-test-resend-key", SMTP.password), "GET 응답 비밀 값").toBe(false);
  expect(leaks(d.output(), "m5-fixed-test-resend-key", SMTP.password), "Worker 출력 비밀 값").toBe(false);
});

it("TC-M5.T0.j Workers SMTP 도 권한·Origin 검사가 지원 여부 검사보다 먼저다", async () => {
  const admin = await login("admin", "j");
  const member = await login("member", "j");
  // 정지는 운영 정지 API 로 한다. 정지 전 쿠키는 세션이 지워져 기존 계약대로 401 이다 (signup/policy.test.ts).
  const suspended = await login("admin", "j-suspended");
  const stopped = await call("POST", `/api/admin/users/${suspended.id}/suspend`, { cookie: admin.cookie });
  expect(stopped.status, "관리자 정지 응답").toBe(200);
  expect(await op("user", suspended.email)).toMatchObject({ role: "admin", status: "suspended" });
  expect(await op("sessionsOf", suspended.email)).toBe(0);
  for (const [o, status, error] of [[{}, 401, "unauthorized"], [{ cookie: member.cookie }, 403, "forbidden"], [{ cookie: suspended.cookie }, 401, "unauthorized"],
    [{ cookie: admin.cookie, origin: "https://outside.test" }, 403, "forbidden_origin"], [{ cookie: admin.cookie, origin: null }, 403, "forbidden_origin"]] as const) {
    const r = await call("PUT", "/api/admin/settings/mail", { ...o, body: SMTP });
    expect([r.status, r.json?.error]).toEqual([status, error]);
    expect(leaks(r.body, SMTP.password), "거부 응답 비밀번호").toBe(false);
  }
  expect(mailRows().length, "메일 설정 행 수").toBe(0);
  expect(await op("audits", "settings.update")).toBe(0);
});

it("TC-M5.T0.k Workers setup SMTP 는 400·관리자 미생성·토큰 미소비, 같은 토큰으로 설치 가능", async () => {
  const body = { ...ADMIN, token: SETUP_TOKEN, mail: SMTP };
  const wrong = await call("POST", "/api/setup", { body: { ...body, token: "wrong" } });
  expect([wrong.status, wrong.json.error]).toEqual([401, "invalid_token"]);
  const r = await call("POST", "/api/setup", { body });
  expect([r.status, r.json.error]).toEqual([400, "smtp_unsupported"]);
  expect(leaks(r.body, SMTP.password), "거부 응답 비밀번호").toBe(false);
  expect(mailRows().length, "메일 설정 행 수").toBe(0);
  expect(await op("userCount")).toBe(0);
  const ok = await call("POST", "/api/setup", { body: { ...ADMIN, token: SETUP_TOKEN } });
  expect(ok.status, "설치 응답").toBe(201);
  expect(leaks(d.output(), SMTP.password, SETUP_TOKEN), "Worker 출력 비밀 값").toBe(false);
});
