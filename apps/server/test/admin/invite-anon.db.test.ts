// TC-M6.T5.a 회원 삭제의 초대 정리 (M6 후속 U1, Node DB 넷). pnpm -C apps/server test:db -t "TC-M6.T5.a" --db sqlite,mysql,mariadb,pg
// 삭제는 그 회원이 수락한 초대의 email 을 user 와 같은 익명값으로 바꾸고(used_by 유지), 삭제 전 이메일의 미사용·미철회 초대는 철회한다.
// 초대 정리가 실패하면 user 익명화·세션 폐기·감사까지 한 트랜잭션으로 되돌려진다. 실제 D1 batch 판은 invite-anon.workers.test.ts 다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { createTestDb, enabledDbs, LABEL, type DbKind, type TestDb } from "../../../../packages/runtime/test/dbs.ts";
import { mutateMember } from "../../src/admin/guard-sql.ts";
import { inviteAnonDelete, inviteAnonExpected, inviteAnonMember, inviteAnonMemberAfter, inviteAnonMemberBefore, inviteAnonRows, seedInviteAnon } from "./invite-anon-checks.ts";

const FAULT = "invite_cleanup_fault";

describe.each(enabledDbs())("%s", (kind: DbKind) => {
  let t: TestDb;
  let h: DbHandle;
  beforeEach(async () => {
    t = await createTestDb(kind);
    h = await connectNode(t.url);
    if (!h.schema.user.authVersion || !h.schema.session.authVersion) throw new Error("M6 DB fixture 준비 실패: authVersion 생성 스키마가 없다");
  });
  afterEach(async () => {
    await h?.close();
    await t?.drop();
  });

  it(`TC-M6.T5.a ${LABEL[kind]}: 삭제는 수락한 초대 email 을 익명화하고 삭제 전 이메일의 미사용 초대만 철회한다`, async () => {
    const f = await seedInviteAnon(h);
    expect(await inviteAnonRows(h, f)).toEqual(f.seeded);
    expect(await inviteAnonMember(h, f)).toEqual(inviteAnonMemberBefore(f));
    await mutateMember(h, inviteAnonDelete(f));
    expect(await inviteAnonRows(h, f)).toEqual(inviteAnonExpected(f));
    expect(await inviteAnonMember(h, f)).toEqual(inviteAnonMemberAfter(f));
  });

  it(`TC-M6.T5.a ${LABEL[kind]}: 초대 정리가 실패하면 user 익명화·세션 폐기·감사·초대 철회가 모두 되돌려진다`, async () => {
    const f = await seedInviteAnon(h);
    let inviteWrites = 0;
    // 시험 연결만 감싼다. 트랜잭션 안에서 초대 UPDATE 를 만들려는 순간 실패시킨다 (철회 UPDATE 는 먼저 실행된 뒤다)
    const db = new Proxy(h.db, {
      get(real, key) {
        if (key === "transaction") return (body: (tx: any) => Promise<unknown>, config?: unknown) => real.transaction((tx: any) => body(new Proxy(tx, {
          get(inner, op) {
            if (op === "update") return (table: unknown) => {
              if (table === h.schema.invites && ++inviteWrites > 1) throw new Error(FAULT);
              return inner.update(table);
            };
            const value = Reflect.get(inner, op, inner);
            return typeof value === "function" ? value.bind(inner) : value;
          },
        })), config);
        const value = Reflect.get(real, key, real);
        return typeof value === "function" ? value.bind(real) : value;
      },
    });
    await expect(mutateMember({ ...h, db }, inviteAnonDelete(f))).rejects.toThrow(FAULT);
    expect(inviteWrites).toBeGreaterThan(1); // 초대 정리까지 닿았다 — CAS·감사·철회 뒤의 실패다
    expect(await inviteAnonRows(h, f)).toEqual(f.seeded);
    expect(await inviteAnonMember(h, f)).toEqual(inviteAnonMemberBefore(f));
  });
});
