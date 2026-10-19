// 관리자 MFA 정책 수치 (A1 설계 3·9절). 모두 배포 설정(env·wrangler vars)의 필수값이고 코드에 기본값이 없다.
// 다른 제품의 값·SDK 기본값·RFC 권장값을 기본값으로 쓰지 않는다. 값이 없거나 범위 밖이면 상태는 unavailable 이고
// 관리자 가드가 이 상태로 fail-closed 판정한다(503 mfa_policy_unavailable, 다음 단계).
//
// 이유(reason)는 고정 코드와 설정 이름만 담는다. 받은 값 원문은 넣지 않는다 (로그로 새지 않게).
// version 은 정규화한 정책의 SHA-256 hex 다. 세션의 mfa_policy_version 과 다르면 다시 MFA 를 요구한다.

import { TOTP_ALGORITHMS, TOTP_WINDOW_STEPS_LIMIT, type TotpAlgorithm } from "./totp.ts";

export interface MfaPolicy {
  /** TOTP step 폭(초) */
  totpPeriodS: number;
  totpDigits: number;
  totpAlgorithm: TotpAlgorithm;
  /** 지금보다 이전 step 을 몇 개까지 받나 */
  totpPastWindow: number;
  /** 지금보다 이후 step 을 몇 개까지 받나 */
  totpFutureWindow: number;
  /** 새 seed 길이(바이트) */
  seedBytes: number;
  /** 민감 작업 최근성 = step-up proof 수명(초) */
  recencyTtlS: number;
  /** 부분 세션이 MFA 를 마쳐야 하는 시간(초) */
  challengeTtlS: number;
  /** 등록 시작 → 확인 마감(초) */
  pendingTtlS: number;
  /** 등록 자격(grant) 수명(초) */
  grantTtlS: number;
  /** 관리자 세션 절대 수명(초). 위 세 TTL 의 상한 */
  adminSessionAbsoluteTtlS: number;
  /** 지수 지연을 걸기 전에 허용하는 연속 실패 수 (계정+IP 칸) */
  failureLimit: number;
  /** 계정 단독 칸(IP 무관)에서 지수 지연 전에 허용하는 연속 실패 수. 계정+IP 제한 이상이어야 한다 (A1 보안 리뷰 L2) */
  accountFailureLimit: number;
  /** 마지막 실패 뒤 이만큼(초) 지나면 실패 칸을 비운다 */
  failureWindowS: number;
  /** 실패 제한을 넘은 뒤 첫 지연(초). 실패가 하나 늘 때마다 두 배 */
  failureDelayBaseS: number;
  /** 지연 상한(초) */
  failureDelayMaxS: number;
  /** 한 번에 발급하는 복구 코드 수 */
  recoveryCodeCount: number;
}

/** 정책 필드 → 설정 이름. 설정 객체(process.env·wrangler vars)는 이 이름으로 읽는다 */
export const MFA_POLICY_ENV = {
  totpPeriodS: "MFA_TOTP_PERIOD_S",
  totpDigits: "MFA_TOTP_DIGITS",
  totpAlgorithm: "MFA_TOTP_ALGORITHM",
  totpPastWindow: "MFA_TOTP_PAST_WINDOW",
  totpFutureWindow: "MFA_TOTP_FUTURE_WINDOW",
  seedBytes: "MFA_SEED_BYTES",
  recencyTtlS: "MFA_RECENCY_TTL_S",
  challengeTtlS: "MFA_CHALLENGE_TTL_S",
  pendingTtlS: "MFA_PENDING_TTL_S",
  grantTtlS: "MFA_GRANT_TTL_S",
  adminSessionAbsoluteTtlS: "MFA_ADMIN_SESSION_ABSOLUTE_TTL_S",
  failureLimit: "MFA_FAILURE_LIMIT",
  accountFailureLimit: "MFA_ACCOUNT_FAILURE_LIMIT",
  failureWindowS: "MFA_FAILURE_WINDOW_S",
  failureDelayBaseS: "MFA_FAILURE_DELAY_BASE_S",
  failureDelayMaxS: "MFA_FAILURE_DELAY_MAX_S",
  recoveryCodeCount: "MFA_RECOVERY_CODE_COUNT",
} as const satisfies Record<keyof MfaPolicy, string>;

export type MfaPolicyEnvName = (typeof MFA_POLICY_ENV)[keyof MfaPolicy];

/**
 * 고정 이유 코드. missing: 값 없음, not_integer: 정수가 아님, out_of_range: 범위 밖, unknown_algorithm: 모르는 해시,
 * inconsistent: 다른 값과 맞지 않음, implementation_limit: 구현 안전 한계를 넘음
 */
export type MfaPolicyReason = "missing" | "not_integer" | "out_of_range" | "unknown_algorithm" | "inconsistent" | "implementation_limit";

export type MfaPolicyState =
  | { state: "ready"; policy: Readonly<MfaPolicy>; version: string }
  | { state: "unavailable"; reason: MfaPolicyReason; field: MfaPolicyEnvName };

// 범위 규칙과 근거 (값이 아니라 형식·관계만 정한다)
//   step > 0            RFC 6238 §4.1 X 는 양의 시간 간격
//   window ≥ 0          0 이면 지금 step 만 받는다. 상한은 정책 결정이라 두지 않는다
//   digits 6~8          RFC 4226 §5.3 R4 최소 6자리, 부록 C 참조 구현과 RFC 6238 부록 A 가 8자리까지 다룬다
//   algorithm           RFC 6238 §1.2 가 HMAC-SHA-1·SHA-256·SHA-512 를 정한다
//   seed ≥ 16바이트     RFC 4226 §4 R6 공유 비밀은 최소 128비트
//   seed ≤ 128바이트    HMAC 은 블록 크기(SHA-512 128바이트)보다 긴 키를 해시로 줄인다 (RFC 2104 §2). 더 길어도 강해지지 않는다
//   TTL·실패 수 > 0     0 이하면 흐름이 성립하지 않는다
//   최근성·challenge·pending ≤ 관리자 세션 절대 수명   세션보다 오래 사는 증명·부분 세션·등록 대기는 뜻이 없다
//   (past + future + 1) × 실패 제한 < 10^digits       한 실패 창에서 시간창의 모든 step 에 실패 제한만큼 찍어도 코드 공간
//                                                      전체를 덮지 못해야 한다. 덮으면 추측이 확실히 맞는다 (RFC 4226 §7.3·부록 A 의 Sec = s·v/10^Digit)
//   past + future + 1 ≤ TOTP_WINDOW_STEPS_LIMIT        공통 정책값이 아니라 구현 안전 한계다 (totp.ts, 요청당 HMAC 계산량 상한)
//   지연 상한 ≥ 첫 지연                                 상한이 첫 지연보다 작으면 두 배씩 늘리는 규칙이 성립하지 않는다
//   계정 제한 ≥ 계정+IP 제한                           계정 칸이 더 낮으면 계정+IP 칸은 뜻이 없다
//   (past + future + 1) × 계정 제한 < 10^digits       IP 를 바꿔도 계정 칸이 같은 예산을 막는다 (위 관계와 같은 근거)
//   복구 코드 수 1~50                                  구현 안전 한계 (한 응답·한 batch 의 행 수)
// 모든 정수는 JS 안전 정수여야 한다 (시각 계산에서 정밀도를 잃지 않게).
const INTEGER_FIELDS = [
  ["totpPeriodS", 1],
  ["totpDigits", 6, 8],
  ["totpPastWindow", 0],
  ["totpFutureWindow", 0],
  ["seedBytes", 16, 128],
  ["recencyTtlS", 1],
  ["challengeTtlS", 1],
  ["pendingTtlS", 1],
  ["grantTtlS", 1],
  ["adminSessionAbsoluteTtlS", 1],
  ["failureLimit", 1],
  ["accountFailureLimit", 1],
  ["failureWindowS", 1],
  ["failureDelayBaseS", 1],
  ["failureDelayMaxS", 1],
  ["recoveryCodeCount", 1, 50],
] as const satisfies readonly (readonly [Exclude<keyof MfaPolicy, "totpAlgorithm">, number, number?])[];

const BOUNDED_BY_SESSION = ["recencyTtlS", "challengeTtlS", "pendingTtlS"] as const;

/** 문자열(env)·숫자 모두 받는다. 문자열은 앞뒤 공백을 빼고 10진수 숫자만 받는다 ("1e3"·"0x10"·"1.0" 거부) */
function parseInteger(raw: unknown): number | "missing" | "not_integer" {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return "missing";
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : "not_integer";
  if (typeof raw !== "string") return "not_integer";
  const s = raw.trim();
  if (!/^-?[0-9]+$/.test(s)) return "not_integer";
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : "not_integer";
}

/** 정규화한 정책을 고정 순서 JSON 으로 만들어 SHA-256 hex. 설정 이름 순서가 아니라 필드 목록 순서를 쓴다 */
async function policyVersion(p: MfaPolicy): Promise<string> {
  const fields = Object.keys(MFA_POLICY_ENV) as (keyof MfaPolicy)[];
  const canonical = JSON.stringify(["magnetosphere:mfa-policy:v1", ...fields.map((f) => [f, p[f]])]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 설정 객체를 검사·정규화한다. 기본값은 없다: 하나라도 없거나 틀리면 unavailable.
 * 첫 번째 문제 하나만 알린다 (설정 이름 순서). 받은 값은 돌려주지 않는다.
 */
export async function loadMfaPolicy(env: Readonly<Record<string, unknown>>): Promise<MfaPolicyState> {
  const out: Partial<MfaPolicy> = {};
  for (const [field, min, max] of INTEGER_FIELDS) {
    const v = parseInteger(env[MFA_POLICY_ENV[field]]);
    if (v === "missing" || v === "not_integer") return { state: "unavailable", reason: v, field: MFA_POLICY_ENV[field] };
    if (v < min || (max !== undefined && v > max)) return { state: "unavailable", reason: "out_of_range", field: MFA_POLICY_ENV[field] };
    out[field] = v;
  }
  const alg = env[MFA_POLICY_ENV.totpAlgorithm];
  if (alg === undefined || alg === null || (typeof alg === "string" && alg.trim() === "")) return { state: "unavailable", reason: "missing", field: MFA_POLICY_ENV.totpAlgorithm };
  const algorithm = typeof alg === "string" ? TOTP_ALGORITHMS.find((a) => a === alg.trim().toUpperCase()) : undefined;
  if (!algorithm) return { state: "unavailable", reason: "unknown_algorithm", field: MFA_POLICY_ENV.totpAlgorithm };
  out.totpAlgorithm = algorithm;
  const policy = out as MfaPolicy;
  if (policy.failureDelayMaxS < policy.failureDelayBaseS) return { state: "unavailable", reason: "inconsistent", field: MFA_POLICY_ENV.failureDelayMaxS };
  if (policy.accountFailureLimit < policy.failureLimit) return { state: "unavailable", reason: "inconsistent", field: MFA_POLICY_ENV.accountFailureLimit };
  for (const f of BOUNDED_BY_SESSION) {
    if (policy[f] > policy.adminSessionAbsoluteTtlS) return { state: "unavailable", reason: "inconsistent", field: MFA_POLICY_ENV[f] };
  }
  // 시간창 합 검사는 더 큰 쪽의 설정 이름으로 알린다
  const steps = policy.totpPastWindow + policy.totpFutureWindow + 1;
  const windowField = policy.totpPastWindow >= policy.totpFutureWindow ? MFA_POLICY_ENV.totpPastWindow : MFA_POLICY_ENV.totpFutureWindow;
  if (steps > TOTP_WINDOW_STEPS_LIMIT) return { state: "unavailable", reason: "implementation_limit", field: windowField };
  if (steps * policy.accountFailureLimit >= 10 ** policy.totpDigits) return { state: "unavailable", reason: "inconsistent", field: windowField };
  return { state: "ready", policy: Object.freeze(policy), version: await policyVersion(policy) };
}
