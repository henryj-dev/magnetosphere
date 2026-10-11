// 가입 정책 (M2) — Workers + D1 (pnpm -C apps/server test:workers). 시험 Worker(test/signup/wrangler.jsonc)를 wrangler dev 로 띄워
// Node 네 DB 시험(policy.db.test.ts·packages/auth/test/signup-policy/policy.test.ts)과 같은 단언을 로컬 D1 에서 돈다.
// D1 은 Better Auth 를 transaction: false 로 올린다 (#15). 가입의 user·account 삽입은 한 트랜잭션이 아니다 (TC-M2.T3.a (3)).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tcM2T1b, tcM2T1g, tcM2T2d } from "../../../../packages/auth/test/signup-policy/checks.ts";
import { attempt, body, mail } from "../../../../packages/auth/test/signup-policy/rig.ts";
import { answerOf } from "../verify-p3/rig.ts";
import { tcM2T1a, tcM2T3a, tcM2T5d, tcM2T5e } from "./checks.ts";
import { startSignupWorker } from "./d1-rig.ts";

let w: Awaited<ReturnType<typeof startSignupWorker>>;
beforeAll(async () => {
  w = await startSignupWorker();
});
afterAll(async () => {
  await w?.close();
});

describe("가입 정책 — Workers + D1", () => {
  // 관리자가 없는 D1 이어야 하므로 맨 앞에 둔다 (뒤의 TC 는 관리자를 넣는다)
  it("TC-M2.T7.a Workers + D1: 관리자 없는 로컬 D1, 운영 createAuth → /sign-up/email 200·user·account 각 +1·인증 메일 1통 (V29 의존, PR #15 뒤 단언)", async () => {
    expect((await w.rig.op("rows")).user).toBe(0);
    const r = await attempt(w.rig, async () => {
      const res = await w.rig.call("POST", "/__test/bare/sign-up/email", { body: body(mail("t7a")) });
      return { status: res.status, code: null, body: res.body };
    });
    expect({ status: r.status, user: r.user, account: r.account, mail: r.mail }, r.body).toEqual({ status: 200, user: 1, account: 1, mail: 1 });
  });
  it("TC-M2.T1.a Workers + D1: 정책 다섯 × 경로 둘 표 — open·domain_allowlist 만 공개 가입이 회원을 만든다, 행 수로 판정 (Q3·Q19 의존)", () => tcM2T1a(w.rig));
  it("TC-M2.T1.b Workers + D1: user 를 만드는 다른 경로는 뒷받침 훅이 막는다, 경로 목록은 V32 와 같다 (V29·V32 의존)", () => tcM2T1b(w.rig, answerOf("V32")));
  it("TC-M2.T1.g Workers + D1: 초대 문맥의 서버 호출은 signUpGate 를 지난다, 문맥 없는 호출·closed 는 403·행 0 (V29 의존)", () => tcM2T1g(w.rig));
  it("TC-M2.T2.d Workers + D1: domain_allowlist 인데 허용 도메인이 비면 공개 가입은 모두 403 domain_not_allowed·행 0 (M1 리뷰)", () => tcM2T2d(w.rig));
  it("TC-M2.T3.a Workers + D1: 상한 3 — 차례 4건 +3·4번째 403 signup_cap·알림 1행, 동시 10건은 센 값 == 생긴 공개 가입 수, 실패한 가입은 세지 않음, 초대는 상한 뒤에도 +1 (Q13 의존)", () =>
    tcM2T3a(w.rig, w.rig, { atomicSignup: false }));
  it("TC-M2.T5.d Workers + D1: 감사 기록 문장이 실패한 PATCH → 500·설정 그대로·감사 0 (batch 하나), 정상 PATCH → 설정과 감사 1행 (M1 리뷰)", () => tcM2T5d(w.rig));
  it("TC-M2.T5.e Workers + D1: 같은 updatedAt 으로 두 관리자가 같은 키 PATCH → 200 하나·409 stale_setting 하나, 다른 키는 둘 다 200 (M1 리뷰)", () => tcM2T5e(w.rig));
});
