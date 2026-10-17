// TC-M4.T4 자기 탈퇴. SQLite 파일 DB 와 설치된 인증 proof (작성만, 실행 승인 전).
// exact /api/me 의 운영 앱 연결은 후속이다. 여기서는 독립 Hono 가 DELETE /api/me 에 sameOrigin 을 직접 건다.
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { makeTestEnv, type TestEnv } from "../helpers.ts";
import { serverRig, type ServerRig } from "../signup/env.ts";
import { tcM4DeleteAndSelf } from "./delete-checks.ts";

let t: TestEnv;
let rig: ServerRig;
beforeEach(async () => {
  t = await makeTestEnv();
  rig = await serverRig("SQLite", { url: t.env.DATABASE_URL });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rig?.close();
  t?.cleanup();
});

describe("TC-M4.T4 자기 탈퇴", () => {
  it("TC-M4.T4.a 틀린 비밀번호 403·맞는 proof 200·bootstrap·last admin 409·Origin 403·proof 변경 거부를 확인한다", async () => {
    await tcM4DeleteAndSelf(rig);
  });
});
