// 초대 수락 (M3.T2) — Node 네 DB (pnpm test:db). 운영과 같은 서버 앱(진짜 Better Auth, test/signup/env.ts serverRig)으로
// 같은 토큰 동시 수락 10건을 보낸다. 한 문장 차지(UPDATE … WHERE used_at IS NULL …)의 영향 행 수가 DB 마다 다른 방식으로 세어진다
// (MySQL affectedRows, 나머지 RETURNING). D1 판은 accept.workers.test.ts.
import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { serverRig, type ServerRig } from "../signup/env.ts";
import { tcM3T2a } from "./accept-checks.ts";

describe.each(enabledDbs())("%s", (kind: DbKind) => {
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

  it(`TC-M3.T2.a ${LABEL[kind]}: 같은 토큰 동시 수락 10건(이메일 지정 없음, 이메일 10개) → 201 정확히 1·나머지 400 invalid_invite·user 증가 1`, async () => {
    const o = await tcM3T2a(rig);
    console.info(`[TC-M3.T2.a ${kind}] ${JSON.stringify(o)}`);
  });
});
