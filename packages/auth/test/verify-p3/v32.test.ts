// V32 기본으로 열린 회원 변경 경로 — Node 네 DB (M0.T5, pnpm -C packages/auth test -t "TC-M0.T5"). 관찰을 docs/verify/V32.json 과 비교한다.
// D1 은 apps/server/test/verify-p3/v32.workers.test.ts (같은 단언, checks.ts).
import { afterAll, beforeAll, describe, test } from "vitest";
import { ALL_DBS, OPEN, type TestDb } from "../db.ts";
import { tcM0T5a } from "./checks.ts";
import type { Rig } from "./measure.ts";
import { answerOf, nodeRig } from "./rig.ts";

const A = answerOf("V32");

describe.each(ALL_DBS)("V32 기본으로 열린 회원 변경 경로 — %s", (kind) => {
  let h: TestDb;
  let rig: Rig;
  beforeAll(async () => {
    h = await OPEN[kind]();
    rig = nodeRig(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  test("TC-M0.T5.a 회원 변경·생성 경로의 기본 상태가 V32 와 같다 (V32 의존)", () => tcM0T5a(rig, A));
});
