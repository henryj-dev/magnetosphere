// S3.T2: 메일 어댑터와 인증·비밀번호 재설정 메일 연결. SMTP 는 test/smtp.test.ts (pnpm test:smtp).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cloudflareBindingMailer, cloudflareRestMailer, consoleMailer, MailError, resendMailer, VERIFY_SUBJECT, RESET_SUBJECT } from "../src/mail/index.ts";
import { client, email, PASSWORD } from "./client.ts";
import { OPEN, type TestDb } from "./db.ts";
import { linkIn, makeAuth, markVerified, userRow } from "./helpers.ts";

const MSG = { to: "member@example.test", subject: "제목", text: "본문", html: "<p>본문</p>" };

/** fetch 가로채기. 받은 요청을 모으고 정해 둔 응답을 돌려준다 */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit; json: any }[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, json: JSON.parse(String(init.body)) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fn };
}
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe("인증·재설정 메일 (SQLite)", () => {
  let h: TestDb;
  beforeAll(async () => {
    h = await OPEN.sqlite();
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-S3.T2.a 콘솔 어댑터로 받은 인증 링크가 실제로 인증을 끝낸다", async () => {
    const lines: string[] = [];
    // 운영처럼 공개 주소(BETTER_AUTH_URL)를 따로 둔다. 링크가 이 주소로 만들어져야 한다.
    const baseURL = "https://members.example.test";
    const app = makeAuth(h, { baseURL, mailer: consoleMailer({ write: (l) => lines.push(l) }) });
    const e = email("verify");
    const c = client(app.handler);
    expect((await c.post("/sign-up/email", { email: e, password: PASSWORD, name: "x" })).status).toBe(200);
    await app.settle();
    expect(lines.join("\n")).toContain(VERIFY_SUBJECT);
    const url = linkIn(lines.join("\n"));
    expect(url, "콘솔 출력에 링크 없음").toBeDefined();
    expect(url!.startsWith(`${baseURL}/api/auth/verify-email?token=`), url).toBe(true);
    expect((await c.post("/sign-in/email", { email: e, password: PASSWORD })).status, "인증 전").toBe(403);
    const v = await c.get(url!);
    expect([200, 302]).toContain(v.status);
    expect(Boolean((await userRow(h, e)).emailVerified)).toBe(true);
    expect((await c.post("/sign-in/email", { email: e, password: PASSWORD })).status).toBe(200);
  });

  test("TC-S3.T2.d 비밀번호 재설정 메일의 토큰은 한 번만 쓰인다", async () => {
    const app = makeAuth(h);
    const e = email("reset");
    const c = client(app.handler);
    await c.post("/sign-up/email", { email: e, password: PASSWORD, name: "x" });
    await markVerified(h, e);
    app.outbox.length = 0;
    expect((await c.post("/request-password-reset", { email: e, redirectTo: "/reset" })).status).toBe(200);
    await app.settle();
    const mail = app.outbox.find((m) => m.subject === RESET_SUBJECT && m.to === e.toLowerCase());
    expect(mail, "재설정 메일 없음").toBeDefined();
    const link = linkIn(mail!.text)!;
    const open = await c.get(link);
    expect(open.status).toBe(302);
    const token = new URL(open.location!, "http://x").searchParams.get("token");
    expect(token).toBeTruthy();
    const first = await c.post("/reset-password", { newPassword: "new-password-1234", token });
    expect(first.status).toBe(200);
    const again = await c.post("/reset-password", { newPassword: "attacker-password-99", token });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
    // 링크를 다시 열어도 토큰을 주지 않는다
    const reopen = await c.get(link);
    expect(new URL(reopen.location ?? "/", "http://x").searchParams.get("token")).toBeNull();
    expect((await c.post("/sign-in/email", { email: e, password: "new-password-1234" })).status).toBe(200);
    expect((await client(app.handler).post("/sign-in/email", { email: e, password: "attacker-password-99" })).status).toBe(401);
  });
});

describe("TC-S3.T2.f 콘솔 어댑터", () => {
  test("TC-S3.T2.f NODE_ENV=production 이면 콘솔 어댑터를 만들지 않는다", () => {
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => consoleMailer()).toThrow(/production/);
      process.env.NODE_ENV = "development";
      expect(() => consoleMailer()).not.toThrow();
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe("TC-S3.T2.c Resend·Cloudflare 어댑터 요청", () => {
  test("TC-S3.T2.c Resend: 엔드포인트·인증 헤더·수신자", async () => {
    const f = fakeFetch(200, { id: "re_1" });
    await resendMailer({ apiKey: "re_key", from: "Magnetosphere <no-reply@mg.test>", fetch: f.fn }).send(MSG);
    expect(f.calls).toHaveLength(1);
    const [call] = f.calls;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.init.method).toBe("POST");
    expect(header(call.init, "authorization")).toBe("Bearer re_key");
    expect(call.json).toEqual({ from: "Magnetosphere <no-reply@mg.test>", to: ["member@example.test"], subject: "제목", text: "본문", html: "<p>본문</p>" });
  });

  test("TC-S3.T2.c Resend: 비 2xx 응답이면 예외", async () => {
    for (const status of [401, 422, 500]) {
      const f = fakeFetch(status, { message: "nope" });
      await expect(resendMailer({ apiKey: "k", from: "a@mg.test", fetch: f.fn }).send(MSG), String(status)).rejects.toBeInstanceOf(MailError);
    }
  });

  test("TC-S3.T2.c Cloudflare REST: 엔드포인트·인증 헤더·수신자", async () => {
    const f = fakeFetch(200, { success: true, errors: [], result: { delivered: ["member@example.test"], permanent_bounces: [], queued: [] } });
    await cloudflareRestMailer({ accountId: "acc123", apiToken: "cf_tok", from: { email: "no-reply@mg.test", name: "Magnetosphere" }, fetch: f.fn }).send(MSG);
    const [call] = f.calls;
    expect(call.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send");
    expect(call.init.method).toBe("POST");
    expect(header(call.init, "authorization")).toBe("Bearer cf_tok");
    expect(call.json).toEqual({ to: "member@example.test", from: { address: "no-reply@mg.test", name: "Magnetosphere" }, subject: "제목", text: "본문", html: "<p>본문</p>" });
  });

  test("TC-S3.T2.c Cloudflare REST: 비 2xx·success false·영구 반송이면 예외", async () => {
    const cases = [
      fakeFetch(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }),
      fakeFetch(200, { success: false, errors: [{ code: 1, message: "x" }] }),
      fakeFetch(200, { success: true, errors: [], result: { delivered: [], permanent_bounces: ["member@example.test"], queued: [] } }),
    ];
    for (const f of cases) {
      await expect(cloudflareRestMailer({ accountId: "a", apiToken: "t", from: { email: "n@mg.test" }, fetch: f.fn }).send(MSG)).rejects.toBeInstanceOf(MailError);
    }
  });

  test("TC-S3.T2.c Cloudflare 바인딩: 메시지 모양과 실패 전달", async () => {
    const sent: unknown[] = [];
    await cloudflareBindingMailer({ binding: { send: async (m) => void sent.push(m) }, from: { email: "no-reply@mg.test" } }).send(MSG);
    expect(sent).toEqual([{ to: "member@example.test", from: { email: "no-reply@mg.test" }, subject: "제목", text: "본문", html: "<p>본문</p>" }]);
    const failing = { send: async () => Promise.reject(Object.assign(new Error("sender not verified"), { code: "E_SENDER_NOT_VERIFIED" })) };
    await expect(cloudflareBindingMailer({ binding: failing, from: { email: "x@mg.test" } }).send(MSG)).rejects.toThrow(/E_SENDER_NOT_VERIFIED/);
  });
});
