import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { tcM2T8e } from "./confirmation-checks.ts";
import { serverRig, type ServerRig } from "./env.ts";

it("H1 확인 테스트는 DB를 하나 이상 선택한다", () => expect(enabledDbs().length).toBeGreaterThan(0));
describe.each(enabledDbs())("%s 비밀번호 확인 인증", (kind: DbKind) => {
  let t: TestDb;
  let rig: ServerRig;
  beforeAll(async () => {
    t = await createTestDb(kind);
    rig = await serverRig(LABEL[kind], { url: t.url });
  });
  afterAll(async () => {
    await rig?.close();
    await t?.drop();
  });
  it(`TC-M2.T8.e ${LABEL[kind]}: 최초·재발송 GET은 읽기 전용, 비밀번호 확인 POST만 인증한다`, () => tcM2T8e(rig));
});
