// TC-S3.T2.e: 메일 전송을 응답과 떼어 내 응답 시간으로 계정 존재 여부가 드러나지 않는다 (S3 보안 리뷰 M1).
// 메일을 보내는 쪽(있는 계정의 재설정, 없는 계정의 가입)만 느려지는지 본다. 있는 계정·없는 계정의 응답 시간 차이를
// 1초 걸리는 가짜 메일러와 바로 끝나는 메일러로 각각 재고(중앙값), 메일 지연이 그 차이에 더한 몫이 상한보다 작아야 한다.
// 메일 지연과 무관한 차이(없는 계정 가입의 DB 쓰기 등)는 두 측정에 같이 들어가 빠진다. 이 차이는 CI 러너의 디스크에서
// 100ms 를 넘기도 해(S7 CI) 차이 자체를 고정 상한과 비교하면 환경에 따라 실패한다.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { MailMessage } from "../src/index.ts";
import { client, email, PASSWORD } from "./client.ts";
import { OPEN, type TestDb } from "./db.ts";
import { makeAuth, markVerified } from "./helpers.ts";

const MAIL_DELAY_MS = 1000;
const ROUNDS = 7;
const LIMIT_MS = 250;

const slowMailer = { send: (_m: MailMessage) => new Promise<void>((r) => setTimeout(r, MAIL_DELAY_MS)) };
const fastMailer = { send: async (_m: MailMessage) => {} };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function timed(fn: () => Promise<{ status: number }>) {
  const t = performance.now();
  const r = await fn();
  expect(r.status).toBe(200);
  return performance.now() - t;
}

/** 메일을 안 보내는 요청과 보내는 요청을 번갈아 재 중앙값 차이(보내는 쪽 - 안 보내는 쪽) */
async function gap(noMail: () => Promise<{ status: number }>, mail: () => Promise<{ status: number }>) {
  await timed(mail); // 첫 요청의 준비 비용을 빼려고 한 번 버린다
  const n: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    n.push(await timed(noMail));
    m.push(await timed(mail));
  }
  return { noMail: median(n), mail: median(m), gap: median(m) - median(n) };
}

const fmt = (r: { noMail: number; mail: number }) => `안 보냄 ${r.noMail.toFixed(1)}ms · 보냄 ${r.mail.toFixed(1)}ms`;

describe("TC-S3.T2.e 메일 전송 시간", () => {
  let h: TestDb;
  beforeAll(async () => {
    h = await OPEN.sqlite();
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-S3.T2.e /request-password-reset 메일 지연이 있는 계정·없는 계정 응답 시간 차이에 더하는 몫 < 250ms", async () => {
    const measure = async (mailer: typeof slowMailer) => {
      const app = makeAuth(h, { mailer });
      const known = email("known");
      await client(app.handler).post("/sign-up/email", { email: known, password: PASSWORD, name: "x" });
      await markVerified(h, known);
      await app.settle();
      const c = client(app.handler);
      const reset = (e: () => string) => () => c.post("/request-password-reset", { email: e(), redirectTo: "/reset" });
      // 재설정은 있는 계정에만 메일을 보낸다. 없는 계정은 요청마다 새 주소다
      const r = await gap(reset(() => email("ghost")), reset(() => known));
      await app.settle();
      return r;
    };
    const slow = await measure(slowMailer);
    const fast = await measure(fastMailer);
    console.info(`[TC-S3.T2.e] reset 느린 메일 ${fmt(slow)} / 빠른 메일 ${fmt(fast)}`);
    expect(slow.gap - fast.gap).toBeLessThan(LIMIT_MS);
  });

  test("TC-S3.T2.e /sign-up/email 메일 지연이 있는 계정·없는 계정 응답 시간 차이에 더하는 몫 < 250ms", async () => {
    const measure = async (mailer: typeof slowMailer) => {
      const app = makeAuth(h, { mailer });
      const known = email("dup");
      await client(app.handler).post("/sign-up/email", { email: known, password: PASSWORD, name: "x" });
      await app.settle();
      const c = client(app.handler);
      const signUp = (e: () => string) => () => c.post("/sign-up/email", { email: e(), password: PASSWORD, name: "x" });
      // 가입은 없는 계정(새 가입)에만 메일을 보낸다. 새 주소는 요청마다 만든다
      const r = await gap(signUp(() => known), signUp(() => email("fresh")));
      await app.settle();
      return r;
    };
    const slow = await measure(slowMailer);
    const fast = await measure(fastMailer);
    console.info(`[TC-S3.T2.e] sign-up 느린 메일 ${fmt(slow)} / 빠른 메일 ${fmt(fast)}`);
    expect(slow.gap - fast.gap).toBeLessThan(LIMIT_MS);
  });

  test("TC-S3.T2.e 메일 전송 실패는 onMailError 로 넘어간다", async () => {
    const boom = new Error("smtp down");
    const app = makeAuth(h, { mailer: { send: async () => Promise.reject(boom) } });
    const e = email("fail");
    expect((await client(app.handler).post("/sign-up/email", { email: e, password: PASSWORD, name: "x" })).status).toBe(200);
    await app.settle();
    expect(app.mailErrors).toEqual([boom]);
  });
});
