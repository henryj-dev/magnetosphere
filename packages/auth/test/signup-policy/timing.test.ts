// TC-M2.T4.a 가입 응답 시간이 있는 계정·없는 계정에서 같다 (M2.T4, S7 에서 찾은 노출 — CI 에서 새 가입의 DB 쓰기만큼 108ms 차이).
// 서버 앱 전체(app.ts → Better Auth)로 open 정책 공개 가입을 보낸다. 메일 지연은 없다 (메일 몫은 mail-timing.test.ts TC-S3.T2.e).
// 서버 Rig 는 apps/server/test/signup/env.ts 다 (packages/auth 는 서버에 기대지 않으므로 상대 경로로 가져온다).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serverRig, type ServerRig } from "../../../../apps/server/test/signup/env.ts";
import { createTestDb, type TestDb } from "../../../runtime/test/dbs.ts";
import { body, mail } from "./rig.ts";

const ROUNDS = 7;
/** 있는 계정·없는 계정 중앙값 차이의 상한 */
const GAP_MS = 30;
/** 모든 가입 응답의 최소 시간 (apps/server/src/signup/timing.ts SIGNUP_MIN_MS) */
const MIN_MS = 400;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe("TC-M2.T4.a 가입 응답 시간", () => {
  let t: TestDb;
  let rig: ServerRig;
  beforeAll(async () => {
    t = await createTestDb("sqlite");
    rig = await serverRig("SQLite", { url: t.url });
    await rig.op("addAdmin");
    await rig.op("setMail", true);
    await rig.op("setSetting", "signup_mode", "open");
    await rig.op("setSetting", "signup_requires_approval", true);
    await rig.op("setSetting", "daily_signup_cap", null);
  });
  afterAll(async () => {
    await rig?.close();
    await t?.drop();
  });

  test(`TC-M2.T4.a open 정책, 있는 이메일·없는 이메일 공개 가입 각 ${ROUNDS}번 → 중앙값 차이 < ${GAP_MS}ms, 모든 응답 ≥ ${MIN_MS}ms`, async () => {
    const existing = mail("t4a-known");
    expect((await rig.signUp(body(existing))).status).toBe(200);
    const timed = async (e: string) => {
      const t0 = performance.now();
      const r = await rig.signUp(body(e));
      const ms = performance.now() - t0;
      expect(r.status, r.body).toBe(200);
      return ms;
    };
    // 첫 요청의 준비 비용을 빼려고 한 번씩 버린다
    await timed(existing);
    await timed(mail("t4a-warm"));
    const known: number[] = [];
    const fresh: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      known.push(await timed(existing));
      fresh.push(await timed(mail(`t4a-new-${i}`)));
    }
    const gap = Math.abs(median(fresh) - median(known));
    console.info(`[TC-M2.T4.a] 있는 이메일 중앙값 ${median(known).toFixed(1)}ms · 없는 이메일 ${median(fresh).toFixed(1)}ms · 차이 ${gap.toFixed(1)}ms · 가장 짧은 응답 ${Math.min(...known, ...fresh).toFixed(1)}ms`);
    expect(Math.min(...known, ...fresh)).toBeGreaterThanOrEqual(MIN_MS);
    expect(gap).toBeLessThan(GAP_MS);
  });
});
