// V31 로그인을 막는 자리 (session.create.before·after) — Node 네 DB (M0.T4, pnpm -C packages/auth test -t "TC-M0.T4"). 관찰을 docs/verify/V31.json 과 비교한다.
// D1 은 apps/server/test/verify-p3/v31.workers.test.ts (같은 단언, checks.ts).
import { afterAll, beforeAll, describe, test } from "vitest";
import { ALL_DBS, OPEN, type TestDb } from "../db.ts";
import { tcM0T4a, tcM0T4b } from "./checks.ts";
import type { Rig } from "./measure.ts";
import { answerOf, nodeRig } from "./rig.ts";

const A = answerOf("V31");

describe.each(ALL_DBS)("V31 로그인을 막는 자리 (session.create.before·after) — %s", (kind) => {
  let h: TestDb;
  let rig: Rig;
  beforeAll(async () => {
    h = await OPEN[kind]();
    rig = nodeRig(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-M0.T4.a 로그인 거부 훅은 세션을 만들지 않는다 (V31 의존)", () => tcM0T4a(rig, A));

  test("TC-M0.T4.b 재설정·인증 링크는 세션을 만들지 않고 after 훅이 세션을 지울 수 있다 (V31 의존)", () => tcM0T4b(rig, A));
});
