// TC-M5.T0.smtp-timeout: SMTP 어댑터가 멈춘 서버에서 무한히 기다리지 않는다 (M5 리뷰 MEDIUM).
// nodemailer 를 가짜로 바꿔 mailpit 없이 돈다. 실제 서버를 쓰는 TC-S3.T2.b 는 smtp.test.ts 에 그대로 있다.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MailError } from "../src/mail/index.ts";
import { smtpMailer } from "../src/mail/smtp.ts";

type Fake = { sendMail: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
const nm = vi.hoisted(() => ({
  opts: [] as Record<string, unknown>[],
  made: [] as Fake[],
  next: null as null | (() => Promise<unknown>),
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (o: Record<string, unknown>) => {
      nm.opts.push(o);
      const impl = nm.next ?? (async () => ({}));
      nm.next = null;
      const fake: Fake = { sendMail: vi.fn(impl), close: vi.fn() };
      nm.made.push(fake);
      return fake;
    },
  },
}));

const HANG = () => new Promise<never>(() => {});
const MSG = { to: "a@mg.test", subject: "s", text: "t", html: "<p>t</p>" };
const BASE = { host: "smtp.mg.test", port: 587, secure: false, user: "u", pass: "p", from: "no-reply@mg.test" };

beforeEach(() => {
  nm.opts.length = 0;
  nm.made.length = 0;
  nm.next = null;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SMTP 시간 제한", () => {
  test("TC-M5.T0.smtp-timeout.a 연결·인사·소켓 시간 제한을 고정값으로 건다", async () => {
    await smtpMailer(BASE).send(MSG);
    expect(nm.opts[0]).toMatchObject({
      host: "smtp.mg.test",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "u", pass: "p" },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    });
  });

  test("TC-M5.T0.smtp-timeout.b 멈춘 서버는 15초에 고정 문구 MailError 로 끝나고 타이머·transport 를 치운다", async () => {
    nm.next = HANG;
    const p = expect(smtpMailer(BASE).send(MSG)).rejects.toSatisfy(
      (e: unknown) => e instanceof MailError && e.provider === "smtp" && e.status === null && e.message === "[mail:smtp] 보내지 못했다: SMTP 서버 응답 시간 초과",
    );
    await vi.advanceTimersByTimeAsync(14_999);
    expect(nm.made[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(nm.made[0].close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("TC-M5.T0.smtp-timeout.c 성공하면 15초 타이머를 지우고 transport 를 닫는다", async () => {
    await smtpMailer(BASE).send(MSG);
    expect(nm.made[0].sendMail).toHaveBeenCalledTimes(1);
    expect(nm.made[0].close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("TC-M5.T0.smtp-timeout.d 보낼 때마다 transport 를 따로 만들어, 멈춘 전송이 다른 전송을 끊지 않는다", async () => {
    const mailer = smtpMailer(BASE);
    nm.next = HANG;
    const hung = expect(mailer.send(MSG)).rejects.toBeInstanceOf(MailError);
    await mailer.send({ ...MSG, to: "b@mg.test" });
    expect(nm.made).toHaveLength(2);
    expect(nm.made[1].close).toHaveBeenCalledTimes(1);
    expect(nm.made[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    await hung;
    expect(nm.made[0].close).toHaveBeenCalledTimes(1);
    expect(nm.made[1].close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("TC-M5.T0.smtp-timeout.e 라이브러리 시간 초과(ETIMEDOUT) 원문은 API·로그로 나가지 않는다", async () => {
    nm.next = async () => {
      throw Object.assign(new Error("Connection timeout to smtp.mg.test:587 user=u secret=hunter2"), { code: "ETIMEDOUT" });
    };
    const err = await smtpMailer(BASE).send(MSG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).message).toBe("[mail:smtp] 보내지 못했다: SMTP 서버 응답 시간 초과");
    expect(JSON.stringify(err) + String(err)).not.toMatch(/hunter2|smtp\.mg\.test/);
    expect(nm.made[0].close).toHaveBeenCalledTimes(1);
  });

  test("TC-M5.T0.smtp-timeout.f 시간 초과가 아닌 오류는 기존대로 MailError 에 원문을 담고 transport 를 닫는다", async () => {
    nm.next = async () => {
      throw new Error("535 Authentication failed");
    };
    const err = await smtpMailer(BASE).send(MSG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).message).toBe("[mail:smtp] 보내지 못했다: 535 Authentication failed");
    expect((err as MailError).status).toBeNull();
    expect(nm.made[0].close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
