// V29 가입을 막는 자리와 초대 문맥 통로 — Node 네 DB (M0.T2, pnpm -C packages/auth test -t "TC-M0.T2"). 관찰을 docs/verify/V29.json 과 비교한다.
// D1 은 apps/server/test/verify-p3/v29.workers.test.ts (같은 단언, checks.ts).
import { afterAll, beforeAll, describe, test } from "vitest";
import { ALL_DBS, OPEN, type TestDb } from "../db.ts";
import { tcM0T2a, tcM0T2b, tcM0T2c, tcM0T2d } from "./checks.ts";
import type { Rig } from "./measure.ts";
import { answerOf, nodeRig } from "./rig.ts";

const A = answerOf("V29");

describe.each(ALL_DBS)("V29 가입을 막는 자리와 초대 문맥 통로 — %s", (kind) => {
  let h: TestDb;
  let rig: Rig;
  beforeAll(async () => {
    h = await OPEN[kind]();
    rig = nodeRig(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-M0.T2.a 앞 판정 거부는 이메일 존재와 무관하고 행·메일을 남기지 않는다 (V29 의존)", () => tcM0T2a(rig, A));

  test("TC-M0.T2.b 뒷받침 훅 거부는 행을 남기지 않고 응답을 숨긴다 (400 은 숨기지 않는다) (V29 의존)", () => tcM0T2b(rig, A));

  test("TC-M0.T2.c 훅 데이터가 가입 기본값을 덮고 발송기가 그 값을 본다 (V29 의존)", () => tcM0T2c(rig, A));

  test("TC-M0.T2.d 앱 ALS 의 초대 문맥은 서버 호출의 두 훅에서만 보이고 위조할 수 없다, create.after 는 커밋 뒤 (V29 의존)", () => tcM0T2d(rig, A));
});
