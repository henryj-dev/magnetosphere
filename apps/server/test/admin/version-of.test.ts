// TC-M6.T5.e 손상된 auth_version 은 stale_member 다 (M6 후속 L4). pnpm -C apps/server test test/admin/version-of.test.ts -t "TC-M6.T5.e"
// 0..상한 밖 정수·소수·문자열은 상한 도달(version_exhausted)이 아니라 손상 행이다. 쓰기 전에 거절하고 아무것도 바꾸지 않는다.
// 대조: 정확히 상한이면 지금처럼 version_exhausted 다. SQLite 는 integer 칸에 소수·문자열을 그대로 저장하므로 이 DB 에서 만든다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { connectNode } from "@magnetosphere/runtime/node";
import type { DbHandle } from "@magnetosphere/runtime/types";
import { AUTH_VERSION_MAX, MemberConflictError, mutateMember, type MemberMutation } from "../../src/admin/guard-sql.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";
import { inviteAnonDelete, inviteAnonMember, inviteAnonMemberBefore, inviteAnonRows, seedInviteAnon, type InviteAnonFixture } from "./invite-anon-checks.ts";

const suspend = (f: InviteAnonFixture): MemberMutation => {
  const base = inviteAnonDelete(f);
  return { ...base, action: "suspend", audit: { ...base.audit, action: "member.suspend", detail: {} } };
};
const conflict = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof MemberConflictError ? e.code : "unexpected_error";
  }
};

describe("TC-M6.T5.e 손상된 auth_version", () => {
  let t: TestEnv;
  let h: DbHandle;
  beforeEach(async () => {
    t = await makeTestEnv();
    h = await connectNode(`file:${t.dbFile}`);
  });
  afterEach(async () => {
    await h?.close();
    t?.cleanup();
  });

  for (const [label, value] of [["소수 1.5", 1.5], ["음수 -1", -1], ["상한+1", AUTH_VERSION_MAX + 1], ["문자열 'x'", "x"]] as const) {
    it(`TC-M6.T5.e: 대상 auth_version 이 ${label} 이면 정지·삭제 모두 stale_member 이고 회원·세션·감사·초대가 그대로다`, async () => {
      const f = await seedInviteAnon(h);
      await h.db.run(sql`update ${h.schema.user} set auth_version = ${value} where id = ${f.target}`);
      const raw = async () => (await h.db.all(sql`select auth_version as v, typeof(auth_version) as t from ${h.schema.user} where id = ${f.target}`)) as { v: unknown; t: string }[];
      const stored = await raw();
      expect(stored).toEqual([{ v: value, t: typeof value === "string" ? "text" : Number.isInteger(value) ? "integer" : "real" }]);
      for (const input of [suspend(f), inviteAnonDelete(f)]) {
        expect(await conflict(mutateMember(h, input))).toBe("stale_member");
      }
      expect(await raw()).toEqual(stored);
      expect(await inviteAnonMember(h, f)).toEqual(inviteAnonMemberBefore(f));
      expect(await inviteAnonRows(h, f)).toEqual(f.seeded);
    });
  }

  it("TC-M6.T5.e: 대조 — 대상 auth_version 이 정확히 상한이면 version_exhausted 이고 아무것도 바꾸지 않는다", async () => {
    const f = await seedInviteAnon(h);
    await h.db.run(sql`update ${h.schema.user} set auth_version = ${AUTH_VERSION_MAX} where id = ${f.target}`);
    for (const input of [suspend(f), inviteAnonDelete(f)]) {
      expect(await conflict(mutateMember(h, input))).toBe("version_exhausted");
    }
    expect(await inviteAnonMember(h, f)).toEqual(inviteAnonMemberBefore(f));
    expect(await inviteAnonRows(h, f)).toEqual(f.seeded);
  });
});
