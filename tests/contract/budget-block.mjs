// 예산 차단 판정 도우미 (2단계 실행판 K0.T11). 2단계 계약·E2E 시험의 예산 차단 단언은 모두 이 함수를 쓴다.
//
// OmniRoute 3.8.51 은 같은 digest 라도 아키텍처마다 다른 빌드다 (S7 CI 실측).
//   arm64: 429 { error: { code: "BUDGET_EXCEEDED", … } }
//   amd64: 429 { error: { code: "rate_limit_exceeded", message: "Monthly budget exceeded: $0.0146 / $0.01" } }
// 그냥 요청 수 제한도 429 rate_limit_exceeded 라서, 상태코드만 보면 분배가 고장 나도 요청 수 제한을 한도 차단으로 오인한다.
// 회원 앱 코드는 차단 code 를 읽지 않는다 (차단은 OmniRoute 가 회원 도구에 직접 낸다). 이 함수는 시험 전용이다.

/**
 * @param {number} status 응답 상태코드
 * @param {unknown} body 응답 본문 JSON (못 읽었으면 null)
 * @returns {boolean} 예산 때문에 막힌 응답이면 true
 */
export function isBudgetBlocked(status, body) {
  if (status !== 429 || body === null || typeof body !== "object") return false;
  const err = body.error && typeof body.error === "object" ? body.error : body;
  const code = typeof err.code === "string" ? err.code : null;
  const message = typeof err.message === "string" ? err.message : "";
  if (code === "BUDGET_EXCEEDED") return true;
  return code === "rate_limit_exceeded" && /budget exceeded/i.test(message);
}
