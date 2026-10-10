// K2.T1 남은 한도 계산 (순수 함수, 계획서 v5.7 5.3).
import { describe, expect, it } from "vitest";
import { computeBudgets } from "../../src/limits/compute.ts";

const decimals = (x: number) => (String(x).split(".")[1] ?? "").length;

describe("TC-K2.T1.a 계산식이 계획서 5.3 과 같다", () => {
  it("한도 5, 키 A(active) 3, 키 B(deleted) 1.5, 키 C(active) 0 → 사용액 4.5, 남은 0.5, A 3.5, C 0.5, B 예산 없음", () => {
    const r = computeBudgets({
      limitUsd: 5,
      keys: [
        { id: "A", state: "active", spentUsd: 3 },
        { id: "B", state: "deleted", spentUsd: 1.5 },
        { id: "C", state: "active", spentUsd: 0 },
      ],
    });
    expect({ memberSpent: r.memberSpent, remaining: r.remaining, exhausted: r.exhausted }).toEqual({ memberSpent: 4.5, remaining: 0.5, exhausted: false });
    expect([...r.budgets]).toEqual([
      ["A", 3.5],
      ["C", 0.5],
    ]);
  });
});

describe("TC-K2.T1.b 한도를 넘긴 회원의 남은 한도는 0 이고 예산 대신 끄기다 (Q1 의존)", () => {
  it("한도 5, 사용액 6(A 4, B 2) → 남은 0, exhausted true, budgets 빈 Map", () => {
    const r = computeBudgets({
      limitUsd: 5,
      keys: [
        { id: "A", state: "active", spentUsd: 4 },
        { id: "B", state: "active", spentUsd: 2 },
      ],
    });
    expect({ memberSpent: r.memberSpent, remaining: r.remaining, exhausted: r.exhausted, budgets: r.budgets.size }).toEqual({ memberSpent: 6, remaining: 0, exhausted: true, budgets: 0 });
  });
});

describe("TC-K2.T1.c 한도 NULL(무제한)이면 예산을 걸지 않는다", () => {
  it("limitUsd null → budgets 빈 Map, exhausted false", () => {
    const r = computeBudgets({ limitUsd: null, keys: [{ id: "A", state: "active", spentUsd: 100 }] });
    expect({ remaining: r.remaining, exhausted: r.exhausted, budgets: r.budgets.size, memberSpent: r.memberSpent }).toEqual({ remaining: null, exhausted: false, budgets: 0, memberSpent: 100 });
  });
});

describe("TC-K2.T1.d 남은 한도 0 · 사용액 0 키는 예산이 아니라 끄기 대상이다 (Q1 의존)", () => {
  it("한도 1, A 사용액 1, C 사용액 0 → remaining 0, exhausted true, budgets 에 C 없음 (0 이하 예산 0건)", () => {
    const r = computeBudgets({
      limitUsd: 1,
      keys: [
        { id: "A", state: "active", spentUsd: 1 },
        { id: "C", state: "active", spentUsd: 0 },
      ],
    });
    expect({ remaining: r.remaining, exhausted: r.exhausted, hasC: r.budgets.has("C") }).toEqual({ remaining: 0, exhausted: true, hasC: false });
    expect([...r.budgets.values()].filter((b) => b <= 0)).toEqual([]);
  });
});

describe("TC-K2.T1.e 부동소수 오차로 남은 한도가 생기지 않는다", () => {
  it("한도 0.3, 키 0.1·0.2 → 남은 0. 한도 0.3, 0.1·0.19999999 → 남은 0 (1e-8 예산 없음). 예산은 소수 6자리 이하", () => {
    const a = computeBudgets({ limitUsd: 0.3, keys: [{ id: "A", state: "active", spentUsd: 0.1 }, { id: "B", state: "active", spentUsd: 0.2 }] });
    expect({ remaining: a.remaining, exhausted: a.exhausted }).toEqual({ remaining: 0, exhausted: true });
    const b = computeBudgets({ limitUsd: 0.3, keys: [{ id: "A", state: "active", spentUsd: 0.1 }, { id: "B", state: "active", spentUsd: 0.19999999 }] });
    expect({ remaining: b.remaining, exhausted: b.exhausted, budgets: b.budgets.size }).toEqual({ remaining: 0, exhausted: true, budgets: 0 });
    const c = computeBudgets({ limitUsd: 1, keys: [{ id: "A", state: "active", spentUsd: 0.1234567 }, { id: "B", state: "active", spentUsd: 0.0000004 }] });
    expect(c.remaining).toBe(0.876543);
    for (const v of c.budgets.values()) expect(decimals(v), String(v)).toBeLessThanOrEqual(6);
  });
});
