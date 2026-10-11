// V31 로그인을 막는 자리 (session.create.before·after) — Workers + D1 (M0, pnpm -C apps/server test:workers -t "TC-M0.T4"). 시험 Worker(verify-p3/wrangler.jsonc)를 wrangler dev 로 띄워
// Node 네 DB 시험(packages/auth/test/verify-p3/v31.test.ts)과 같은 단언(checks.ts)을 로컬 D1 에서 돈다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// M0 봉인 재검이 packages/auth/test/verify-p3/ 에 의존한다 (측정·단언·시험 구성을 상대 경로로 가져온다). 그 폴더를 옮기거나 지우면 M0 봉인 커밋 재검이 깨진다.
import { tcM0T4a, tcM0T4b } from "../../../../packages/auth/test/verify-p3/checks.ts";
import { answerOf, startVerifyWorker } from "./rig.ts";

const A = answerOf("V31");
let w: Awaited<ReturnType<typeof startVerifyWorker>>;
beforeAll(async () => {
  w = await startVerifyWorker();
});
afterAll(async () => {
  await w?.close();
});

describe("V31 로그인을 막는 자리 (session.create.before·after) — Workers + D1", () => {
  it("TC-M0.T4.a Workers + D1: 로그인 거부 훅은 세션을 만들지 않는다 (V31 의존)", () => tcM0T4a(w.rig, A));
  it("TC-M0.T4.b Workers + D1: 재설정·인증 링크는 세션을 만들지 않고 after 훅이 세션을 지울 수 있다 (V31 의존)", () => tcM0T4b(w.rig, A));
});
