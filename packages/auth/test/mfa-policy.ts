// 시험 전용 관리자 MFA 정책 값 (A1). 제품 기본값이 아니다 — 제품 코드에는 기본값이 없고 배포 설정이 정한다.
// 서버·인증 시험 Rig, 시험 Worker(wrangler-dev.mjs), E2E 가 같은 값을 쓴다. 다른 import 가 없는 파일이라 .mjs 에서도 바로 불러온다.
export const TEST_MFA_POLICY_ENV: Record<string, string> = {
  MFA_TOTP_PERIOD_S: "30",
  MFA_TOTP_DIGITS: "6",
  MFA_TOTP_ALGORITHM: "SHA-1",
  MFA_TOTP_PAST_WINDOW: "1",
  MFA_TOTP_FUTURE_WINDOW: "1",
  MFA_SEED_BYTES: "20",
  MFA_RECENCY_TTL_S: "600",
  MFA_CHALLENGE_TTL_S: "600",
  MFA_PENDING_TTL_S: "600",
  MFA_GRANT_TTL_S: "86400",
  MFA_ADMIN_SESSION_ABSOLUTE_TTL_S: "43200",
  MFA_FAILURE_LIMIT: "5",
  MFA_ACCOUNT_FAILURE_LIMIT: "20",
  MFA_FAILURE_WINDOW_S: "900",
  MFA_FAILURE_DELAY_BASE_S: "1",
  MFA_FAILURE_DELAY_MAX_S: "900",
  MFA_RECOVERY_CODE_COUNT: "10",
};

/**
 * 관리자 MFA 앱 플러그인이 auth.api 에 더하는 경로 (A1, src/mfa/plugin.ts). 회원을 만들거나 바꾸는 경로가 아니다
 * (세션 MFA 칼럼·mfa_* 표만 쓴다). V32 경로 목록 고정 시험이 /signup-confirmation 처럼 이름을 밝혀 더한다
 */
export const ADMIN_MFA_API_PATHS: readonly string[] = [
  "/admin-mfa/status",
  "/admin-mfa/enroll/start",
  "/admin-mfa/enroll/confirm",
  "/admin-mfa/challenge",
  "/admin-mfa/step-up",
  "/admin-mfa/recovery-codes/regenerate",
];
