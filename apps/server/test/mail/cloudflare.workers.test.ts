// M5 Workers + D1: send_email 바인딩(EMAIL)이 없는 Worker 는 Cloudflare 메일 설정을 거부한다. 기존 시험 Worker 를 쓰고 배포 설정은 바꾸지 않는다.
// 바인딩이 없어도 Worker 는 그대로 뜨고 다른 API 가 돈다 (메일은 선택 기능). 실패 출력에는 고정 문구만 쓴다.
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
const CLOUDFLARE = { provider: "cloudflare", from: "no-reply@mg.test" };
let persistTo: string;
let d: WranglerDev;
beforeEach(async () => {
  persistTo = mkdtempSync(path.join(tmpdir(), "mg-cloudflare-d1-"));
  const mig = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", persistTo]);
  expect(mig.code, `${mig.out}${mig.err}`).toBe(0);
  d = await startWranglerDev({ config: CONFIG, persistTo, vars: { BETTER_AUTH_SECRET: TEST_SECRET, APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, SETUP_TOKEN } });
});
afterEach(async () => { await d?.close(); if (persistTo) rmSync(persistTo, { recursive: true, force: true }); });
const call = async (method: string, p: string, o: CallOpts = {}) => callRes(await fetch(`${d.baseUrl}${p}`, {
  method, redirect: "manual",
  headers: { "x-test-ip": `198.18.1.${Math.floor(Math.random() * 200) + 1}`, ...(o.origin === null ? {} : { origin: o.origin ?? d.baseUrl }),
    ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body === undefined ? {} : { "content-type": "application/json" }) },
  body: o.body === undefined ? undefined : JSON.stringify(o.body),
}));
const op = async (name: string, ...args: unknown[]) => {
  const r = await fetch(`${d.baseUrl}/__test/db`, { method: "POST", body: JSON.stringify({ op: name, args }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { result: unknown }).result;
};
/** 값이 들어 있는지만 본다. 실패해도 원문은 출력하지 않는다 */
const leaks = (value: string, ...secrets: string[]) => secrets.some((x) => value.includes(x));
async function login(role: "admin" | "member", tag: string) {
  const email = `m5-cf-${role}-${tag}@example.test`;
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

it("TC-M5.T0.cloudflare.h 바인딩 없는 Workers 는 Cloudflare 저장 400 cloudflare_unsupported·권한과 Origin 검사가 먼저·Resend 대조", async () => {
  const admin = await login("admin", "h");
  const member = await login("member", "h");
  for (const [o, status, error] of [[{}, 401, "unauthorized"], [{ cookie: member.cookie }, 403, "forbidden"],
    [{ cookie: admin.cookie, origin: "https://outside.test" }, 403, "forbidden_origin"], [{ cookie: admin.cookie, origin: null }, 403, "forbidden_origin"],
    [{ cookie: admin.cookie }, 400, "cloudflare_unsupported"]] as const) {
    const r = await call("PUT", "/api/admin/settings/mail", { ...o, body: CLOUDFLARE });
    expect([r.status, r.json?.error]).toEqual([status, error]);
  }
  expect(mailRows().length, "메일 설정 행 수").toBe(0);
  expect(await op("audits", "settings.update")).toBe(0);
  // 바인딩이 없어도 다른 메일 설정은 그대로 받는다. 그 뒤의 Cloudflare 거부는 저장 행을 바꾸지 않는다
  const resend = await call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: { provider: "resend", apiKey: "m5-fixed-test-resend-key", from: CLOUDFLARE.from } });
  expect(resend.status, "Resend 저장 응답").toBe(200);
  const before = mailRows();
  expect((await call("PUT", "/api/admin/settings/mail", { cookie: admin.cookie, body: CLOUDFLARE })).json?.error).toBe("cloudflare_unsupported");
  expect(JSON.stringify(mailRows()) === JSON.stringify(before), "저장 행").toBe(true);
  expect(await op("audits", "settings.update")).toBe(1);
  expect(leaks(d.output(), "m5-fixed-test-resend-key", admin.email), "Worker 출력 비밀 값·주소").toBe(false);
});

it("TC-M5.T0.cloudflare.i 바인딩 없는 Workers setup Cloudflare 는 400·관리자 미생성·토큰 미소비, 같은 토큰으로 설치 가능", async () => {
  const body = { ...ADMIN, token: SETUP_TOKEN, mail: CLOUDFLARE };
  const wrong = await call("POST", "/api/setup", { body: { ...body, token: "wrong" } });
  expect([wrong.status, wrong.json?.error]).toEqual([401, "invalid_token"]);
  expect((await call("POST", "/api/setup", { body, origin: "https://outside.test" })).status).toBe(403);
  const r = await call("POST", "/api/setup", { body });
  expect([r.status, r.json?.error]).toEqual([400, "cloudflare_unsupported"]);
  expect(mailRows().length, "메일 설정 행 수").toBe(0);
  expect(await op("userCount")).toBe(0);
  const ok = await call("POST", "/api/setup", { body: { ...ADMIN, token: SETUP_TOKEN } });
  expect(ok.status, "설치 응답").toBe(201);
  expect(leaks(d.output(), SETUP_TOKEN), "Worker 출력 설치 토큰").toBe(false);
});
