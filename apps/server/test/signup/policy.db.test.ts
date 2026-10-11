// 가입 정책 (M2) — Node 네 DB (pnpm test:db). 서버 앱 전체(app.ts 앞 판정 + Better Auth 훅)로 가입을 보낸다.
// D1 판은 signup.workers.test.ts (같은 단언, checks.ts).
import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { tcM2T1a } from "./checks.ts";
import { serverRig, type ServerRig } from "./env.ts";

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

  it(`TC-M2.T1.a ${LABEL[kind]}: 정책 다섯 × 경로 둘 표 — open·domain_allowlist 만 공개 가입이 회원을 만든다, 행 수로 판정 (Q3·Q19 의존)`, () => tcM2T1a(rig));
});
