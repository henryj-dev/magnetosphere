// TC-A1.T2.f·T3.e·T4.e 관리자 MFA — Node 네 DB (pnpm test:db). 서버 앱 전체(createApp + buildServices)로 보낸다. D1 판은 admin-mfa.workers.test.ts (같은 단언, checks.ts).
import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { serverRig, type ServerRig } from "../signup/env.ts";
import { tcA1T2f, tcA1T3e, tcA1T4e } from "./checks.ts";

describe.each(enabledDbs())("%s 관리자 MFA", (kind: DbKind) => {
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

  it(`TC-A1.T2.f ${LABEL[kind]}: 같은 코드 동시 challenge 여섯 → 1건만 성공, 나머지 401·관리 API 403, 같은 IP 연속 실패 6번째 429·IP 를 바꾼 실패 21번째 429`, () => tcA1T2f(rig));
  it(`TC-A1.T3.e ${LABEL[kind]}: 같은 코드 동시 등록 확인 둘 → 1건만 성공, active factor 1·부분 소비 없음`, () => tcA1T3e(rig));
  it(`TC-A1.T4.e ${LABEL[kind]}: 같은 proof 동시 역할 변경 둘 → 1건만 성공, 다른 목적 proof 403`, () => tcA1T4e(rig));
});
