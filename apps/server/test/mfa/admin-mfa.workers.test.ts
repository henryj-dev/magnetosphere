// TC-A1.T2.f·T3.e·T4.e·T6.a 관리자 MFA — Workers + D1 (pnpm -C apps/server test:workers). 가입 정책 시험 Worker(test/signup/wrangler.jsonc)를 띄워
// Node 네 DB(admin-mfa.db.test.ts)와 같은 단언을 로컬 D1 에서 돈다. D1 은 batch + changes() guard 로 원자 단위를 만든다 (packages/auth/src/mfa/unit.ts).
import { afterAll, beforeAll, describe, it } from "vitest";
import { startSignupWorker } from "../signup/d1-rig.ts";
import { tcA1T2f, tcA1T3e, tcA1T4e, tcA1T6a } from "./checks.ts";

let w: Awaited<ReturnType<typeof startSignupWorker>>;
beforeAll(async () => {
  w = await startSignupWorker();
});
afterAll(async () => {
  await w?.close();
});

describe("관리자 MFA — Workers + D1", () => {
  it("TC-A1.T2.f Workers + D1: 같은 코드 동시 challenge 여섯 → 1건만 성공, 나머지 401·관리 API 403, 같은 IP 연속 실패 6번째 429", () => tcA1T2f(w.rig));
  it("TC-A1.T3.e Workers + D1: 같은 코드 동시 등록 확인 둘 → 1건만 성공, active factor 1·부분 소비 없음", () => tcA1T3e(w.rig));
  it("TC-A1.T4.e Workers + D1: 같은 proof 동시 역할 변경 둘 → 1건만 성공, 다른 목적 proof 403", () => tcA1T4e(w.rig));
  it("TC-A1.T6.a Workers + D1: grant 등록·승격·초기화·관리자 초대 수락 grant 가 batch 원자 단위로 돈다", () => tcA1T6a(w.rig));
});
