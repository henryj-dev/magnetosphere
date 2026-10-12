// 관리자 초대 API (M3.T1) — Node 네 DB (pnpm test:db). 앱 전체(app.ts 라우터)로 초대를 만든다.
// 단위 판은 admin.test.ts (같은 단언, checks.ts). 초대 만들기는 pg·mysql·mariadb 에서 job_leases 뮤텍스 행을 FOR UPDATE 로 잠가 직렬화하고,
// 재초대 취소는 sqlite·pg 가 UPDATE … RETURNING, mysql·mariadb 가 id 를 읽고 id 마다 UPDATE 다 — 그 DB 별 경로를 여기서 돈다.
// D1 경로(batch)는 SQLite 방언이라 네 DB 판에는 없다 (단위 판이 libsql batch 로 흉내 낸다).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { addUser, call, openRoutes, type RouteEnv } from "../routes/env.ts";
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

  it(`TC-M3.T1.h ${LABEL[kind]}: 같은 이메일 재초대는 차례로 대체한다 — 끼어든 초대도 취소, 동시 6개는 모두 201·살아 있는 초대 1개(해시 일치)·나머지 취소·감사 = 실제 취소`, () => tcM3T1h(e, node));
});

// 악센트 무시 콜레이션 회귀는 실제 MySQL·MariaDB 에서만 본다. 시험마다 새 DB, API 로 만든 행 전체를 JS 로 비교한다.
// SQL email = 로 결과를 고르면 결함 있는 콜레이션이 시험의 관찰까지 바꿀 수 있다.
describe.each(enabledDbs().filter((kind) => kind === "mysql" || kind === "mariadb"))("%s 정확한 재초대 이메일", (kind: DbKind) => {
  let t: TestDb | undefined;
  let e: RouteEnv;
  let admin: string;
  beforeEach(async () => {
    t = undefined;
    t = await createTestDb(kind);
    // URL·자격 증명 없이 이번 시험이 소유한 새 DB 이름만 기록한다 (실행 증거·정상 cleanup 대조용).
    console.info(`[invite-email-db ${kind}] created ${new URL(t.url).pathname.slice(1)}`);
    e = await openRoutes({ url: t.url });
    await prepareInvites(e);
    admin = await addUser(e.h, { role: "admin" });
  });
  afterEach(async () => {
    try {
      await e?.close();
    } finally {
      if (t) {
        await t.drop();
        console.info(`[invite-email-db ${kind}] dropped ${new URL(t.url).pathname.slice(1)}`);
        t = undefined;
      }
    }
  });

  const create = async (email: string) => {
    const r = await call(e, "POST", "/api/admin/invites", { user: admin, body: { role: "member", email } });
    expect(r.status, r.text).toBe(201);
    return r.json.invite.id as string;
  };
  const rows = () => e.h.db.select().from(e.h.schema.invites);
  const revokes = () => e.h.db.select().from(e.h.schema.auditLog).where(eq(e.h.schema.auditLog.action, "invite.revoke"));
  const creates = () => e.h.db.select().from(e.h.schema.auditLog).where(eq(e.h.schema.auditLog.action, "invite.create"));

  it(`TC-M3.T1.j ${LABEL[kind]}: José@example.com·jose@example.com 은 서로 다른 초대 — 살아 있음 2·취소 0·생성 감사 2·취소 감사 0`, async () => {
    const accented = await create("José@example.com");
    const plain = await create("jose@example.com");
    expect((await rows()).map((r: any) => ({ id: r.id, email: r.email, usedAt: r.usedAt, revokedAt: r.revokedAt })).sort((a: any, b: any) => a.email.localeCompare(b.email))).toEqual(
      [
        { id: accented, email: "josé@example.com", usedAt: null, revokedAt: null },
        { id: plain, email: "jose@example.com", usedAt: null, revokedAt: null },
      ].sort((a, b) => a.email.localeCompare(b.email)),
    );
    expect((await creates()).map((a: any) => a.target).sort()).toEqual([accented, plain].sort());
    expect(await revokes()).toEqual([]);
  });

  it(`TC-M3.T1.k ${LABEL[kind]}: 공백·대문자·분해형을 정규화한 같은 주소 재초대만 취소 — 전체 3·살아 있음 2·취소 1·생성 감사 3·취소 감사 1`, async () => {
    const accented = await create("José@example.com");
    const plain = await create("jose@example.com");
    const replacement = await create("  JOSÉ@EXAMPLE.COM  ");
    const all = await rows();
    expect(all).toHaveLength(3);
    const live = all.filter((r: any) => r.usedAt === null && r.revokedAt === null);
    expect(live.map((r: any) => r.id).sort()).toEqual([plain, replacement].sort());
    expect(live.find((r: any) => r.id === plain)?.email).toBe("jose@example.com");
    expect(live.find((r: any) => r.id === replacement)?.email).toBe("josé@example.com");
    const revoked = all.filter((r: any) => r.revokedAt !== null);
    expect(revoked.map((r: any) => r.id)).toEqual([accented]);
    expect((await creates()).map((a: any) => a.target).sort()).toEqual([accented, plain, replacement].sort());
    const audit = await revokes();
    expect(audit.map((a: any) => ({ target: a.target, detail: JSON.parse(a.detail) }))).toEqual([{ target: accented, detail: { reason: "reinvite", replacedBy: replacement } }]);
    expect(audit[0].createdAt.getTime()).toBe(revoked[0].revokedAt.getTime());
  });
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

  it(`TC-M3.T1.i ${LABEL[kind]}: 실제 동시 POST(Promise.all) — 빈 표 같은 이메일 2개·같은 이메일 4·8개·서로 다른 이메일 12개, 회차 3: 모두 201(500·409 0), 같은 이메일은 살아 있는 초대 1개 = 201 하나(해시 일치)·나머지 201 은 취소·감사 = 실제 취소, 다른 이메일은 이메일마다 1개, expires_at 왕복 일치`, async () => {
    const o = await tcM3T1i(e);
    // 관찰값 (보고용). 단언은 tcM3T1i 안에 있다
    console.info(`[TC-M3.T1.i ${kind}] ${JSON.stringify(o.rounds.map(({ failures: _, ...r }) => r))}`);
  });
});
