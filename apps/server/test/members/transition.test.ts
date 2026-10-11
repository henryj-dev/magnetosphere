// M1.T2 회원 상태 전이 (순수 함수). 전이 표 24칸(TC-M1.T2.a)과 최초 관리자·자기 자신 보호(TC-M1.T2.b).
import { describe, expect, it } from "vitest";
import { MEMBER_ACTIONS, MEMBER_STATUSES, transition, type TransitionInput } from "../../src/members/transition.ts";

const ADMIN = { id: "admin-a" };
const member = { id: "m-1", role: "member", isBootstrapAdmin: false };

describe("M1.T2 회원 상태 전이", () => {
  it("TC-M1.T2.a 4 상태 × 6 동작 24칸 표가 Q8 결정과 같다 — 허용 7칸, deleted 에서 나가는 전이 0", () => {
    // 역할 칸은 일반 회원을 admin 으로 올리는 경우다 (보호 규칙이 끼지 않는 대상·주체)
    const got = Object.fromEntries(
      MEMBER_STATUSES.map((from) => [
        from,
        Object.fromEntries(
          MEMBER_ACTIONS.map((action) => {
            const r = transition({ from, action, target: member, actor: ADMIN, role: "admin" });
            return [action, r.ok ? r.to : r.code];
          }),
        ),
      ]),
    );
    const X = "invalid_transition";
    expect(got).toEqual({
      pending: { approve: "active", reject: "row_deleted", suspend: X, unsuspend: X, delete: X, role: X },
      active: { approve: X, reject: X, suspend: "suspended", unsuspend: X, delete: "deleted", role: "active" },
      suspended: { approve: X, reject: X, suspend: X, unsuspend: "active", delete: "deleted", role: X },
      deleted: { approve: X, reject: X, suspend: X, unsuspend: X, delete: X, role: X },
    });
    const cells = Object.values(got).flatMap((row) => Object.values(row));
    expect(cells).toHaveLength(24);
    expect(cells.filter((c) => c !== X)).toHaveLength(7);
    // deleted 는 어떤 동작·대상·주체로도 나가지 못한다 (개인정보를 지운 계정이 되살아나지 않게, Q9)
    for (const action of MEMBER_ACTIONS) {
      for (const target of [member, { id: "a-2", role: "admin", isBootstrapAdmin: false }, { id: ADMIN.id, role: "admin", isBootstrapAdmin: true }]) {
        for (const role of ["member", "admin"]) expect(transition({ from: "deleted", action, target, actor: ADMIN, role }), `${action} ${target.id} ${role}`).toEqual({ ok: false, code: X });
      }
    }
    // 표에 없는 값은 칸이 아니다
    expect(transition({ from: "unknown" as TransitionInput["from"], action: "approve", target: member, actor: ADMIN })).toEqual({ ok: false, code: X });
    expect(transition({ from: "active", action: "toString" as TransitionInput["action"], target: member, actor: ADMIN })).toEqual({ ok: false, code: X });
  });

  it("TC-M1.T2.b 최초 관리자는 강등·정지·삭제 → bootstrap_admin, 자기 자신 정지·강등 → self, 다른 관리자 정지 → ok (Q12)", () => {
    const bootstrap = { id: "boot", role: "admin", isBootstrapAdmin: true };
    const otherAdmin = { id: "a-2", role: "admin", isBootstrapAdmin: false };
    const self = { id: ADMIN.id, role: "admin", isBootstrapAdmin: false };
    const t = (target: TransitionInput["target"], action: TransitionInput["action"], role?: string, actor = ADMIN) => transition({ from: "active", action, target, actor, role });

    // 최초 관리자: 다른 관리자가 해도, 자기 자신이 해도 막는다
    for (const actor of [ADMIN, { id: bootstrap.id }]) {
      expect(t(bootstrap, "role", "member", actor), "demote").toEqual({ ok: false, code: "bootstrap_admin" });
      expect(t(bootstrap, "suspend", undefined, actor), "suspend").toEqual({ ok: false, code: "bootstrap_admin" });
      expect(t(bootstrap, "delete", undefined, actor), "delete").toEqual({ ok: false, code: "bootstrap_admin" });
    }
    expect(transition({ from: "suspended", action: "delete", target: bootstrap, actor: ADMIN })).toEqual({ ok: false, code: "bootstrap_admin" });
    // 자기 자신
    expect(t(self, "suspend")).toEqual({ ok: false, code: "self" });
    expect(t(self, "role", "member")).toEqual({ ok: false, code: "self" });
    // 대조: 다른 관리자 정지·강등, 최초 관리자를 admin 으로 두는 역할 쓰기, 자기 탈퇴(Q10, 최초 관리자 아님)는 된다
    expect(t(otherAdmin, "suspend")).toEqual({ ok: true, to: "suspended" });
    expect(t(otherAdmin, "role", "member")).toEqual({ ok: true, to: "active" });
    expect(t(bootstrap, "role", "admin")).toEqual({ ok: true, to: "active" });
    expect(t(self, "role", "admin")).toEqual({ ok: true, to: "active" });
    expect(t(self, "delete")).toEqual({ ok: true, to: "deleted" });
    expect(t(member, "suspend", undefined, { id: member.id }), "회원 자기 정지도 self").toEqual({ ok: false, code: "self" });
    // 역할 값은 member·admin 둘뿐이다 (Q11). 대소문자가 다른 값도 받지 않는다
    for (const role of ["owner", "ADMIN", "Admin", "", undefined]) expect(t(member, "role", role), String(role)).toEqual({ ok: false, code: "invalid_role" });
  });
});
