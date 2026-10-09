// TC-S3.T2.b: SMTP 어댑터가 실제 SMTP 서버(mailpit)로 보낸다. pnpm test:smtp 로만 돈다.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MailError } from "../src/mail/index.ts";
import { VERIFY_SUBJECT } from "../src/mail/messages.ts";
import { smtpMailer } from "../src/mail/smtp.ts";
import { client, email, PASSWORD } from "./client.ts";
import { OPEN, type TestDb } from "./db.ts";
import { makeAuth } from "./helpers.ts";

const API = "http://127.0.0.1:38025/api/v1";
const SMTP = { host: "127.0.0.1", port: 31025, secure: false, user: "mg", pass: "mgpass", from: "Magnetosphere <no-reply@mg.test>" };

async function received(to: string) {
  const res = await fetch(`${API}/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  expect(res.ok, "mailpit API").toBe(true);
  return ((await res.json()) as { messages: { Subject: string; To: { Address: string }[] }[] }).messages;
}

describe("SMTP (mailpit)", () => {
  let h: TestDb;
  beforeAll(async () => {
    h = await OPEN.sqlite();
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-S3.T2.b 가입하면 mailpit 에 인증 메일 1건", async () => {
    const app = makeAuth(h, { mailer: smtpMailer(SMTP) });
    const e = email("smtp").toLowerCase();
    expect((await client(app.handler).post("/sign-up/email", { email: e, password: PASSWORD, name: "x" })).status).toBe(200);
    await app.settle();
    expect(app.mailErrors).toEqual([]);
    const msgs = await received(e);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].Subject).toBe(VERIFY_SUBJECT);
    expect(msgs[0].To.map((t) => t.Address)).toEqual([e]);
  });

  test("TC-S3.T2.b 서버가 STARTTLS 를 내지 않는데 requireTLS 면 보내지 않고 예외", async () => {
    const e = email("smtp-tls").toLowerCase();
    await expect(smtpMailer({ ...SMTP, requireTLS: true }).send({ to: e, subject: "x", text: "x", html: "x" })).rejects.toBeInstanceOf(MailError);
    expect(await received(e)).toHaveLength(0);
  });
});
