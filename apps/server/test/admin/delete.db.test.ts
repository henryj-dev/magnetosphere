// TC-M4.T2.d 네 DB: 삭제 전에 받은 재설정 토큰으로 계정이 되살아나지 않는다. 작성만 승인됐고 실행하지 않는다.
// SQLite 단일 흐름(delete.test.ts·self-delete.test.ts)과 같은 resetAfterDelete 단언을 설치형 DB 넷에서 돌린다.
// DB 마다 새 시험 DB 를 만들고 afterAll 이 지운다. 삭제 라우트의 관리 API 는 키가 없어 부르지 않는다.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { tcM4T2dResetAfterDelete } from "./delete-checks.ts";
import { serverRig, type ServerRig } from "../signup/env.ts";

it("삭제 뒤 재설정 토큰 테스트는 DB를 하나 이상 선택한다", () => expect(enabledDbs().length).toBeGreaterThan(0));
describe.each(enabledDbs())("%s 삭제 뒤 재설정 토큰", (kind: DbKind) => {
  let t: TestDb;
  let rig: ServerRig;
  beforeAll(async () => {
    t = await createTestDb(kind);
    rig = await serverRig(LABEL[kind], { url: t.url });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await rig?.close();
    await t?.drop();
  });
  it(`TC-M4.T2.d ${LABEL[kind]}: 삭제 전 재설정 토큰은 삭제 뒤 400 INVALID_TOKEN 이고 credential·세션·남의 행을 바꾸지 않는다`, () => tcM4T2dResetAfterDelete(rig));
});
