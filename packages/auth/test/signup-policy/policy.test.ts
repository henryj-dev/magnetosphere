// 가입 정책 (M2) — Better Auth 의 두 자리(signUpGate·user.create.before), Node 네 DB. 서버 앞 판정 없이 handler·auth.api 를 바로 부른다.
// D1 판은 apps/server/test/signup/signup.workers.test.ts (같은 단언, checks.ts).
import { afterAll, beforeAll, describe, test } from "vitest";
import { ALL_DBS, OPEN, type TestDb } from "../db.ts";
import { answerOf } from "../verify-p3/rig.ts";
import { tcM2T1b, tcM2T1g, tcM2T2d } from "./checks.ts";
import { nodeRig } from "./node-rig.ts";
import type { Rig } from "./rig.ts";

describe.each(ALL_DBS)("가입 정책 Better Auth 자리 — %s", (kind) => {
  let h: TestDb;
  let rig: Rig;
  beforeAll(async () => {
    h = await OPEN[kind]();
    rig = nodeRig(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-M2.T1.b user 를 만드는 다른 경로는 뒷받침 훅이 막는다, 경로 목록은 V32 와 같다 (V29·V32 의존)", () => tcM2T1b(rig, answerOf("V32")));
  test("TC-M2.T1.g 초대 문맥의 서버 호출은 signUpGate 를 지난다, 문맥 없는 호출·closed 는 403·행 0 (V29 의존)", () => tcM2T1g(rig));
  test("TC-M2.T2.d domain_allowlist 인데 허용 도메인이 비면 공개 가입은 모두 403 domain_not_allowed·행 0 (M1 리뷰)", () => tcM2T2d(rig));
});
