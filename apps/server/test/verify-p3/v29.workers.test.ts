// V29 가입을 막는 자리와 초대 문맥 통로 — Workers + D1 (M0, pnpm -C apps/server test:workers -t "TC-M0.T2"). 시험 Worker(verify-p3/wrangler.jsonc)를 wrangler dev 로 띄워
// Node 네 DB 시험(packages/auth/test/verify-p3/v29.test.ts)과 같은 단언(checks.ts)을 로컬 D1 에서 돈다.
// D1 은 대화형 트랜잭션이 없어 Better Auth 를 transaction: false 로 올린다. 지금 구성(transaction: true)의 가입은 TC-M0.T2.b 가 따로 본다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// M0 봉인 재검이 packages/auth/test/verify-p3/ 에 의존한다 (측정·단언·시험 구성을 상대 경로로 가져온다). 그 폴더를 옮기거나 지우면 M0 봉인 커밋 재검이 깨진다.
import { tcM0T2a, tcM0T2b, tcM0T2c, tcM0T2d } from "../../../../packages/auth/test/verify-p3/checks.ts";
import { signUpOnce } from "../../../../packages/auth/test/verify-p3/measure.ts";
import { answerOf, startVerifyWorker } from "./rig.ts";

const A = answerOf("V29");
let w: Awaited<ReturnType<typeof startVerifyWorker>>;
beforeAll(async () => {
  w = await startVerifyWorker();
});
afterAll(async () => {
  await w?.close();
});

describe("V29 가입을 막는 자리와 초대 문맥 통로 — Workers + D1", () => {
  it("TC-M0.T2.a Workers + D1: 앞 판정 거부는 이메일 존재와 무관하고 행·메일을 남기지 않는다 (V29 의존)", () => tcM0T2a(w.rig, A));
  it("TC-M0.T2.b Workers + D1: 뒷받침 훅 거부는 행을 남기지 않고 응답을 숨긴다 (400 은 숨기지 않는다), 지금 구성(transaction: true)의 가입은 500·행 0 (V29 의존)", async () => {
    expect(await signUpOnce(w.currentConfig)).toEqual(A.d1Transaction.currentConfig);
    await tcM0T2b(w.rig, A);
  });
  it("TC-M0.T2.c Workers + D1: 훅 데이터가 가입 기본값을 덮고 발송기가 그 값을 본다 (V29 의존)", () => tcM0T2c(w.rig, A));
  it("TC-M0.T2.d Workers + D1: 앱 ALS 의 초대 문맥은 서버 호출의 두 훅에서만 보이고 위조할 수 없다, create.after 는 커밋 뒤 (V29 의존)", () => tcM0T2d(w.rig, A));
});
