// V32 기본으로 열린 회원 변경 경로 — Workers + D1 (M0, pnpm -C apps/server test:workers -t "TC-M0.T5"). 시험 Worker(verify-p3/wrangler.jsonc)를 wrangler dev 로 띄워
// Node 네 DB 시험(packages/auth/test/verify-p3/v32.test.ts)과 같은 단언(checks.ts)을 로컬 D1 에서 돈다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// M0 봉인 재검이 packages/auth/test/verify-p3/ 에 의존한다 (측정·단언·시험 구성을 상대 경로로 가져온다). 그 폴더를 옮기거나 지우면 M0 봉인 커밋 재검이 깨진다.
import { tcM0T5a } from "../../../../packages/auth/test/verify-p3/checks.ts";
import { answerOf, startVerifyWorker } from "./rig.ts";

const A = answerOf("V32");
let w: Awaited<ReturnType<typeof startVerifyWorker>>;
beforeAll(async () => {
  w = await startVerifyWorker();
});
afterAll(async () => {
  await w?.close();
});

describe("V32 기본으로 열린 회원 변경 경로 — Workers + D1", () => {
  it("TC-M0.T5.a Workers + D1: 회원 변경·생성 경로의 기본 상태가 V32 와 같다 (V32 의존)", () => tcM0T5a(w.rig, A));
});
