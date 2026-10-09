// TC-S3.T2.e: 메일 전송을 응답과 떼어 내 응답 시간으로 계정 존재 여부가 드러나지 않는다 (S3 보안 리뷰 M1).
// 300ms 걸리는 가짜 메일러로 있는 계정·없는 계정의 응답 시간을 여러 번 재 중앙값을 비교한다.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { MailMessage } from "../src/index.ts";
import { client, email, PASSWORD } from "./client.ts";
import { OPEN, type TestDb } from "./db.ts";
import { makeAuth, markVerified } from "./helpers.ts";

const MAIL_DELAY_MS = 300;
const ROUNDS = 7;
const LIMIT_MS = 50;

const slowMailer = { send: (_m: MailMessage) => new Promise<void>((r) => setTimeout(r, MAIL_DELAY_MS)) };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function timed(fn: () => Promise<{ status: number }>) {
  const t = performance.now();
  const r = await fn();
  expect(r.status).toBe(200);
  return performance.now() - t;
}

describe("TC-S3.T2.e 메일 전송 시간", () => {
  let h: TestDb;
  beforeAll(async () => {
    h = await OPEN.sqlite();
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-S3.T2.e /request-password-reset 있는 계정·없는 계정 응답 시간 차이 < 50ms", async () => {
    const app = makeAuth(h, { mailer: slowMailer });
    const known = email("known");
    await client(app.handler).post("/sign-up/email", { email: known, password: PASSWORD, name: "x" });
    await markVerified(h, known);
    await app.settle();
    const c = client(app.handler);
    const reset = (e: string) => () => c.post("/request-password-reset", { email: e, redirectTo: "/reset" });
    await timed(reset(email("warm"))); // 첫 요청의 준비 비용을 빼려고 한 번 버린다
    const hit: number[] = [];
    const miss: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      hit.push(await timed(reset(known)));
      miss.push(await timed(reset(email("ghost"))));
    }
    console.info(`[TC-S3.T2.e] reset 중앙값 있는 ${median(hit).toFixed(1)}ms · 없는 ${median(miss).toFixed(1)}ms`);
    expect(Math.abs(median(hit) - median(miss))).toBeLessThan(LIMIT_MS);
    await app.settle();
  });

  test("TC-S3.T2.e /sign-up/email 있는 계정·없는 계정 응답 시간 차이 < 50ms", async () => {
    const app = makeAuth(h, { mailer: slowMailer });
    const known = email("dup");
    await client(app.handler).post("/sign-up/email", { email: known, password: PASSWORD, name: "x" });
    await app.settle();
    const c = client(app.handler);
    const signUp = (e: string) => () => c.post("/sign-up/email", { email: e, password: PASSWORD, name: "x" });
    await timed(signUp(email("warm")));
    const hit: number[] = [];
    const miss: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      hit.push(await timed(signUp(known)));
      miss.push(await timed(signUp(email("fresh"))));
    }
    console.info(`[TC-S3.T2.e] sign-up 중앙값 있는 ${median(hit).toFixed(1)}ms · 없는 ${median(miss).toFixed(1)}ms`);
    expect(Math.abs(median(hit) - median(miss))).toBeLessThan(LIMIT_MS);
    await app.settle();
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
