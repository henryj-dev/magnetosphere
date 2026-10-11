// 관리자 초대 API (M3.T1) — Node 네 DB (pnpm test:db). 앱 전체(app.ts 라우터)로 초대를 만든다.
// 단위 판은 admin.test.ts (같은 단언, checks.ts). 재초대 취소는 sqlite·pg 가 UPDATE … RETURNING, mysql·mariadb 가 SELECT … FOR UPDATE 뒤 UPDATE 이고,
// 동시 재초대 정리(settleSiblings)는 sqlite 를 뺀 셋에서 자기 행을 FOR UPDATE 로 잠근다 — 그 DB 별 경로를 여기서 돈다.
// D1 경로(batch)는 SQLite 방언이라 네 DB 판에는 없다 (단위 판이 libsql batch 로 흉내 낸다).
import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { openRoutes, type RouteEnv } from "../routes/env.ts";
import { prepareInvites, tcM3T1g, tcM3T1h, tcM3T1i, type Variant } from "./checks.ts";

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let e: RouteEnv;
  const node: readonly Variant[] = [[LABEL[kind], false]];
  beforeAll(async () => {
    t = await createTestDb(kind);
    e = await openRoutes({ url: t.url });
    await prepareInvites(e);
  });
  afterAll(async () => {
    await e?.close();
    await t?.drop();
  });

  it(`TC-M3.T1.g ${LABEL[kind]}: 감사 기록은 실제 변경과 같다 — 읽은 뒤 사용·취소된 초대의 DELETE 는 404·감사 0행, 재초대 invite.revoke 는 실제로 취소된 행만`, () => tcM3T1g(e, node));

  it(`TC-M3.T1.h ${LABEL[kind]}: 같은 이메일 동시 재초대 → 살아 있는 초대 1개 (승자는 (expires_at, id) 가 큰 쪽, 진 쪽은 409 invite_conflict·링크 없음)`, () => tcM3T1h(e, node));
});

// TC-M3.T1.i 는 빈 표에서 시작하고 회차 사이에 invites 를 비우므로 전용 DB 를 쓴다
describe.each(enabledDbs())("%s 실제 동시 요청", (kind: DbKind) => {
  let t: TestDb;
  let e: RouteEnv;
  beforeAll(async () => {
    t = await createTestDb(kind);
    e = await openRoutes({ url: t.url });
    await prepareInvites(e);
  });
  afterAll(async () => {
    await e?.close();
    await t?.drop();
  });

  it(`TC-M3.T1.i ${LABEL[kind]}: 실제 동시 POST(Promise.all) — 빈 표 같은 이메일 2개·같은 이메일 4·8개·서로 다른 이메일 12개, 회차 3: 500 0, 같은 이메일은 살아 있는 초대 1개 = 201 하나(해시 일치)·나머지 201 은 뒤에 취소·409 invite_conflict 링크 없음·감사 = 실제 취소, 다른 이메일은 모두 201·이메일마다 1개, expires_at 왕복 일치`, async () => {
    const o = await tcM3T1i(e);
    // 관찰값 (보고용). 단언은 tcM3T1i 안에 있다
    console.info(`[TC-M3.T1.i ${kind}] ${JSON.stringify(o.rounds.map(({ failures: _, ...r }) => r))}`);
  });
});
