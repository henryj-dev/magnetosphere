// 예산 차단 판정 도우미 음성 대조 (2단계 실행판 K0.T11, G-K0.27).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isBudgetBlocked } from "./budget-block.mjs";

test("TC-K0.T11.a 두 빌드의 예산 차단은 참, 일반 요청 수 제한은 거짓", () => {
  // arm64 빌드
  assert.equal(isBudgetBlocked(429, { error: { code: "BUDGET_EXCEEDED", message: "Budget exceeded" } }), true);
  // amd64 빌드
  assert.equal(isBudgetBlocked(429, { error: { code: "rate_limit_exceeded", message: "Monthly budget exceeded: $0.0146 / $0.01" } }), true);
  // 그냥 요청 수 제한
  assert.equal(isBudgetBlocked(429, { error: { code: "rate_limit_exceeded", message: "Too many requests" } }), false);
  // 끈 키
  assert.equal(isBudgetBlocked(403, { error: { code: "permission_denied", message: "This API key is disabled" } }), false);
  // 상태코드가 429 가 아니면 본문이 예산 차단이어도 거짓, 본문이 없으면 거짓
  assert.equal(isBudgetBlocked(200, { error: { code: "BUDGET_EXCEEDED" } }), false);
  assert.equal(isBudgetBlocked(429, null), false);
});
