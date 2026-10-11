// V30 세션 행을 지우면 바로 끊기나 — Node 네 DB (M0.T3, pnpm -C packages/auth test -t "TC-M0.T3"). 관찰을 docs/verify/V30.json 과 비교한다.
// D1 은 apps/server/test/verify-p3/v30.workers.test.ts (같은 단언, checks.ts).
import { afterAll, beforeAll, describe, test } from "vitest";
import { ALL_DBS, OPEN, type TestDb } from "../db.ts";
import { tcM0T3a, tcM0T3b } from "./checks.ts";
import type { Rig } from "./measure.ts";
import { answerOf, nodeRig } from "./rig.ts";

const A = answerOf("V30");

describe.each(ALL_DBS)("V30 세션 행을 지우면 바로 끊기나 — %s", (kind) => {
  let h: TestDb;
  let rig: Rig;
  beforeAll(async () => {
    h = await OPEN[kind]();
    rig = nodeRig(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-M0.T3.a 세션 행을 지운 뒤 첫 요청부터 세션이 없다 (V30 의존)", () => tcM0T3a(rig, A));

  test("TC-M0.T3.b 비밀번호 변경·재설정은 기본으로 다른 세션을 남긴다 (V30 의존)", () => tcM0T3b(rig, A));
});
