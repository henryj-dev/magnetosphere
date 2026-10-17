// TC-M4.T2 관리자 삭제·익명화. SQLite 파일 DB 와 설치된 인증 handler (작성만, 실행 승인 전).
// 공용 app.ts 라우팅은 아직 연결하지 않는다. 이 통과만으로 운영 앱 연결 완료를 뜻하지 않는다.
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

describe("TC-M4.T2 관리자 삭제", () => {
  it("TC-M4.T2.a-d 익명화·소유 토큰·키 보존·120초 큐·권한 경계를 설치된 인증으로 확인한다", async () => {
    await tcM4DeleteAndSelf(rig);
  });
});
