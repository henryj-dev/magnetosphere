// K3.T1 키 목표 상태 함수 (계획서 v5.7 5.7, Q1). DB 없는 순수 계산.
import { describe, expect, it } from "vitest";
import { targetState, type KeyTarget } from "../../src/keys/target.ts";

const KEY_STATES = ["active", "disabled", "deleted"] as const;
const USER_STATUSES = ["pending", "active", "suspended", "deleted"] as const;
const REMAINING = [null, 0, 0.5] as const;

/** 표의 키 state 마다 넣는 disabled_reason: 켜진 키는 없음, 꺼진 키는 limit (원인이 사라지면 켜지는 쪽) */
const REASON_OF = { active: null, disabled: "limit", deleted: null } as const;

describe("TC-K3.T1.a 조합 표가 계획서 v5.6 5.7 과 같다 (Q1 의존)", () => {
  it("keyState 3 × userStatus 4 × remaining 3 = 36 칸 == 기대 표", () => {
    // 계획서 식을 손으로 옮긴 기대 표. 행 = keyState, 열 = userStatus, 칸 안 = remaining null · 0 · 0.5
    const expected: Record<string, Record<string, [KeyTarget, KeyTarget, KeyTarget]>> = {
      active: {
        pending: ["off", "off", "off"],
        active: ["on", "off", "on"],
        suspended: ["off", "off", "off"],
        deleted: ["deleted", "deleted", "deleted"],
      },
      disabled: {
        pending: ["off", "off", "off"],
        active: ["on", "off", "on"],
        suspended: ["off", "off", "off"],
        deleted: ["deleted", "deleted", "deleted"],
      },
      deleted: {
        pending: ["deleted", "deleted", "deleted"],
        active: ["deleted", "deleted", "deleted"],
        suspended: ["deleted", "deleted", "deleted"],
        deleted: ["deleted", "deleted", "deleted"],
      },
    };
    const actual: typeof expected = {};
    let cells = 0;
    for (const keyState of KEY_STATES) {
      actual[keyState] = {};
      for (const userStatus of USER_STATUSES) {
        actual[keyState][userStatus] = REMAINING.map((remaining) => {
          cells++;
          return targetState({ keyState, disabledReason: REASON_OF[keyState], userStatus, remaining });
        }) as [KeyTarget, KeyTarget, KeyTarget];
      }
    }
    expect(cells).toBe(36);
    expect(actual).toEqual(expected);
    // 회원·관리자가 끈 키, 이유를 모르는 꺼진 키는 다른 값이 모두 켜짐 쪽이어도 꺼짐이다 (fail-closed)
    for (const disabledReason of ["member", "admin", null, "unknown"]) {
      expect(targetState({ keyState: "disabled", disabledReason, userStatus: "active", remaining: null }), String(disabledReason)).toBe("off");
    }
  });
});

describe("TC-K3.T1.b 정지를 풀면 user_status 때문에, 한도가 생기면 limit 때문에 꺼진 키만 켠다 (Q1 의존)", () => {
  it("키 넷(member·admin·user_status·limit), 회원 suspended → active (remaining 0.5) → user_status·limit 만 on. remaining 0 이면 넷 모두 off", () => {
    const reasons = ["member", "admin", "user_status", "limit"] as const;
    const of = (userStatus: string, remaining: number | null) =>
      Object.fromEntries(reasons.map((r) => [r, targetState({ keyState: "disabled", disabledReason: r, userStatus, remaining })]));
    expect(of("suspended", 0.5), "정지 중").toEqual({ member: "off", admin: "off", user_status: "off", limit: "off" });
    expect(of("active", 0.5), "정지 해제·한도 있음").toEqual({ member: "off", admin: "off", user_status: "on", limit: "on" });
    expect(of("active", 0), "정지 해제·남은 한도 0").toEqual({ member: "off", admin: "off", user_status: "off", limit: "off" });
  });
});
