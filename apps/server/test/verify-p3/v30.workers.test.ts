// V30 세션 행을 지우면 바로 끊기나 — Workers + D1 (M0, pnpm -C apps/server test:workers -t "TC-M0.T3"). 시험 Worker(verify-p3/wrangler.jsonc)를 wrangler dev 로 띄워
// Node 네 DB 시험(packages/auth/test/verify-p3/v30.test.ts)과 같은 단언(checks.ts)을 로컬 D1 에서 돈다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tcM0T3a, tcM0T3b } from "../../../../packages/auth/test/verify-p3/checks.ts";
import { answerOf, startVerifyWorker } from "./rig.ts";

const A = answerOf("V30");
let w: Awaited<ReturnType<typeof startVerifyWorker>>;
beforeAll(async () => {
  w = await startVerifyWorker();
});
afterAll(async () => {
  await w?.close();
});

describe("V30 세션 행을 지우면 바로 끊기나 — Workers + D1", () => {
  it("TC-M0.T3.a Workers + D1: 세션 행을 지운 뒤 첫 요청부터 세션이 없다 (V30 의존)", () => tcM0T3a(w.rig, A));
  it("TC-M0.T3.b Workers + D1: 비밀번호 변경·재설정은 기본으로 다른 세션을 남긴다 (V30 의존)", () => tcM0T3b(w.rig, A));
});
