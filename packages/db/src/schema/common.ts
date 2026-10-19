// 네 DB 공통 스키마 정의. 테이블·칼럼 이름과 의미의 유일한 원본이다 (계획서 3.2 "DB 지원 원칙", 5.9).
// sqlite·mysql·pg Drizzle 스키마는 이 파일에서 생성한다: pnpm -C packages/db gen
// 생성물(src/schema/{sqlite,mysql,pg}.ts)은 손으로 고치지 않는다. D1 은 sqlite 를 같이 쓴다.
//
// 칼럼 종류와 DB별 타입 (생성기 packages/db/scripts/gen-schema.mjs 가 이 표대로 바꾼다)
//   id        문자열 id          sqlite text · mysql varchar(36) · pg varchar(36)
//   string    길이 있는 문자열   sqlite text · mysql/pg varchar(length)  — 기본 키·고유 키·인덱스는 이것만 쓴다.
//                                MySQL 인덱스 바이트 한도(utf8mb4 3072바이트) 때문에 키 칼럼은 768자 이하
//   text      긴 문자열          text
//   json      JSON 문자열        text. 앱에서 파싱한다. DB 전용 JSON 타입·연산은 쓰지 않는다
//   integer   정수               sqlite integer · mysql int · pg integer
//   bigint    큰 정수 (JS number) sqlite integer · mysql bigint · pg bigint
//   boolean   참·거짓            sqlite integer(boolean) · mysql boolean(tinyint(1)) · pg boolean
//   timestamp 시각 (UTC)         sqlite integer(timestamp_ms) · mysql datetime(3) · pg timestamp
//                                MySQL TIMESTAMP 는 2038-01-19 이후 값을 거부해 DATETIME(3) 을 쓴다 (값은 Drizzle 이 UTC 로 쓰고 읽는다)
//   usd       금액               sqlite real · mysql/pg decimal(12,6). 칼럼 이름은 *_usd
//
// exact: true — 토큰·해시·식별자처럼 대소문자까지 정확히 같아야 하는 칼럼. MySQL·MariaDB 는 기본 정렬이
// 대소문자를 무시하므로 utf8mb4_bin 으로 만든다. SQLite·Postgres 는 기본이 대소문자 구분이다.

export type ColumnKind = "id" | "string" | "text" | "json" | "integer" | "bigint" | "boolean" | "timestamp" | "usd";

export interface Column {
  /** DB 칼럼 이름 (snake_case). 객체 키는 Drizzle·Better Auth 가 쓰는 필드 이름이다. */
  name: string;
  kind: ColumnKind;
  /** kind "string" 의 최대 길이 */
  length?: number;
  /** 대소문자까지 정확 일치 (MySQL utf8mb4_bin). kind string·text 만 */
  exact?: boolean;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  default?: string | number | boolean;
  /**
   * 행을 만들 때 현재 시각을 넣는다. DB now() 가 아니라 앱(Drizzle $defaultFn)이 넣으므로 DDL 에는 기본값이 없다.
   * DB now() 는 세션 시간대를 따르는데 Hyperdrive 가 세션 시간대 설정을 지키는지 확인할 수 없어서다 (TC-S6.T3.c).
   * Drizzle 을 거치지 않고 행을 넣는 코드는 이 칼럼 값을 직접 넣어야 한다.
   */
  defaultNow?: boolean;
  /** Drizzle 로 고칠 때 현재 시각으로 바꾼다 */
  onUpdateNow?: boolean;
  references?: { table: string; column: string; onDelete?: "cascade" };
  /** 의미. 값의 종류처럼 칼럼 타입이 말하지 않는 것 */
  doc?: string;
}

export interface Table {
  /** DB 테이블 이름 */
  name: string;
  /** better-auth: Better Auth 가 읽고 쓰는 테이블. 칼럼은 Better Auth 1.7.7 + sso 플러그인이 기대하는 것과 같아야 한다 (생성기가 검사) */
  owner: "better-auth" | "app";
  doc: string;
  columns: Record<string, Column>;
  /** 여러 칼럼 기본 키 (필드 이름). 칼럼 하나면 Column.primaryKey 를 쓴다 */
  primaryKey?: string[];
  /** unique: true 면 고유 인덱스 (여러 칼럼 고유 제약) */
  indexes?: { name: string; columns: string[]; unique?: boolean }[];
}

const now = { kind: "timestamp", notNull: true, defaultNow: true } as const;

/**
 * 회원별 인증 버전 계약 (M4 ABA). credential 지문·updatedAt 과 별개이며 둘 다 서버 전용이다.
 * 기존 행과 새 행의 시작값은 0 이다. 권한·상태·credential 변경은 DB 식 `auth_version + 1` 로만 1 씩 늘리고,
 * 이전 값으로 되돌리거나 updatedAt 으로 계산하지 않는다. 증가 결과가 이 상한을 넘으면 변경은 실패하며 순환하지 않는다.
 *
 * 상한 2147483647 은 세 방언 integer 범위의 공통 최댓값이다.
 *   sqlite integer: 64비트 저장이지만 Drizzle 은 JS number 로 읽고, 2^53-1 까지만 정수를 정확히 나타낸다
 *   mysql int: 부호 있는 32비트, -2147483648..2147483647
 *   pg integer: 부호 있는 32비트, -2147483648..2147483647
 * MySQL·Postgres 가 가장 좁고 그 최댓값이 2147483647 이다. 다음 값 2147483648 은 그 두 DB 가 거부한다.
 * SQLite integer 에는 32비트 CHECK 가 없어 2147483648 도 저장되므로, 스키마가 아닌 애플리케이션 SQL 조건
 * `auth_version < AUTH_VERSION_MAX` 가 세 방언의 공통 증가 가드다. 현재 값이 상한이면 증가 SQL 을 실행하지 않고 실패시킨다.
 */
export const AUTH_VERSION_DEFAULT = 0;
export const AUTH_VERSION_MAX = 2147483647;

// Better Auth user 테이블에 더하는 칼럼 (계획서 4.6). 모두 input: false — 가입·회원정보 수정 요청으로 바꾸지 못한다.
// Better Auth 구성은 src/auth-options.ts 의 AUTH_SCHEMA_OPTIONS 를 거쳐 이 객체를 user.additionalFields 로 쓴다.
export const USER_ADDITIONAL_FIELDS = {
  role: { type: "string", required: false, defaultValue: "member", input: false },
  status: { type: "string", required: false, defaultValue: "active", input: false },
  monthlyLimitUsd: { type: "number", required: false, input: false },
  maxKeys: { type: "number", required: false, input: false },
  isBootstrapAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
  // 기본값이 없어 가입 본문에 넣으면 400 FIELD_NOT_ALLOWED, 회원정보 수정도 400 이다 (TC-M1.T4.b)
  deletedAt: { type: "date", required: false, input: false },
  signupOrigin: { type: "string", required: false, defaultValue: "legacy", input: false, returned: false },
  // 생성 본문의 값은 버리고 0 을 쓴다. 수정 본문에 값이 있으면 FIELD_NOT_ALLOWED 다. 응답·synthetic user 에도 없다 (M4 ABA).
  authVersion: { type: "number", required: false, defaultValue: AUTH_VERSION_DEFAULT, input: false, returned: false },
} as const;

export const SESSION_ADDITIONAL_FIELDS = {
  credentialFingerprint: { type: "string", required: false, input: false, returned: false },
  // 생성 본문의 값은 버리고 0 을 쓴다. 갱신 본문에 값이 있으면 FIELD_NOT_ALLOWED 다. 세션 응답에는 없다.
  authVersion: { type: "number", required: false, defaultValue: AUTH_VERSION_DEFAULT, input: false, returned: false },
  // 관리자 MFA 충족 증거 (A1). 서버 전용이라 생성·갱신 본문으로 쓰지 못하고 응답에도 없다.
  // 세션 행에 두어 세션 철회 문장과 함께 사라진다. 기존 세션은 NULL 이라 MFA 충족으로 소급되지 않는다.
  mfaVerifiedAt: { type: "date", required: false, input: false, returned: false },
  mfaFactorId: { type: "string", required: false, input: false, returned: false },
  mfaMethod: { type: "string", required: false, input: false, returned: false },
  mfaPolicyVersion: { type: "string", required: false, input: false, returned: false },
} as const;

export const TABLES: Record<string, Table> = {
  // ---------- Better Auth (1.7.7 + @better-auth/sso) ----------
  user: {
    name: "user",
    owner: "better-auth",
    doc: "회원. Better Auth 칼럼 + 권한 칼럼 다섯 + 삭제 시각 + 인증 버전",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      name: { name: "name", kind: "text", notNull: true },
      email: { name: "email", kind: "string", length: 255, notNull: true, unique: true, doc: "항상 소문자로 저장한다 (V26)" },
      emailVerified: { name: "email_verified", kind: "boolean", notNull: true, default: false },
      image: { name: "image", kind: "text" },
      createdAt: { name: "created_at", ...now },
      updatedAt: { name: "updated_at", ...now, onUpdateNow: true },
      role: { name: "role", kind: "string", length: 16, notNull: true, default: "member", doc: "member | admin" },
      status: { name: "status", kind: "string", length: 16, notNull: true, default: "active", doc: "pending | active | suspended | deleted" },
      monthlyLimitUsd: { name: "monthly_limit_usd", kind: "usd", doc: "NULL 이면 무제한" },
      maxKeys: { name: "max_keys", kind: "integer", doc: "NULL 이면 설정 기본값" },
      isBootstrapAdmin: { name: "is_bootstrap_admin", kind: "boolean", notNull: true, default: false },
      deletedAt: { name: "deleted_at", kind: "timestamp", doc: "삭제(탈퇴) 시각. 개인정보를 지운 행이다 (Q9). NULL 이면 삭제되지 않음" },
      signupOrigin: { name: "signup_origin", kind: "string", length: 16, exact: true, notNull: true, default: "legacy", doc: "서버 전용 가입 출처: public | invite | setup | legacy. 기존 미인증 행은 추정하지 않는다" },
      authVersion: { name: "auth_version", kind: "integer", notNull: true, default: AUTH_VERSION_DEFAULT, doc: "서버 전용 인증 버전. 0 부터 시작해 상태·권한·credential 변경 때 DB 에서 1 씩만 는다. AUTH_VERSION_MAX 를 넘기면 실패하고 순환하지 않는다" },
    },
  },
  session: {
    name: "session",
    owner: "better-auth",
    doc: "로그인 세션",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      expiresAt: { name: "expires_at", kind: "timestamp", notNull: true },
      token: { name: "token", kind: "string", length: 255, exact: true, notNull: true, unique: true },
      createdAt: { name: "created_at", ...now },
      updatedAt: { name: "updated_at", kind: "timestamp", notNull: true, onUpdateNow: true },
      ipAddress: { name: "ip_address", kind: "text" },
      userAgent: { name: "user_agent", kind: "text" },
      userId: { name: "user_id", kind: "id", notNull: true, references: { table: "user", column: "id", onDelete: "cascade" } },
      credentialFingerprint: { name: "credential_fingerprint", kind: "string", length: 64, exact: true, doc: "서버 전용 credential HMAC. 비밀번호 변경 전 세션은 조회 때도 거부. NULL 은 기존·비비밀번호 세션" },
      authVersion: { name: "auth_version", kind: "integer", notNull: true, default: AUTH_VERSION_DEFAULT, doc: "세션을 만들 때 관찰한 회원 인증 버전. 로그인 전 재바인딩하지 않으며 현재 user.auth_version 과 다르면 접근을 막는다" },
      mfaVerifiedAt: { name: "mfa_verified_at", kind: "timestamp", doc: "관리자 MFA 를 마친 시각 (A1). NULL 이면 부분 세션" },
      mfaFactorId: { name: "mfa_factor_id", kind: "id", doc: "MFA 충족에 쓴 mfa_factor.id. 현재 active factor 와 다르면 미충족" },
      mfaMethod: { name: "mfa_method", kind: "string", length: 16, exact: true, doc: "totp | recovery" },
      mfaPolicyVersion: { name: "mfa_policy_version", kind: "string", length: 64, exact: true, doc: "충족 당시 MFA 정책 해시(SHA-256 hex). 현재 정책 해시와 다르면 미충족" },
    },
    indexes: [{ name: "session_userId_idx", columns: ["userId"] }],
  },
  account: {
    name: "account",
    owner: "better-auth",
    doc: "로그인 방식 (비밀번호, OAuth, SSO)",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      accountId: { name: "account_id", kind: "text", exact: true, notNull: true, doc: "IdP 의 사용자 id. Better Auth 가 이 값으로 계정을 찾는다" },
      providerId: { name: "provider_id", kind: "text", exact: true, notNull: true },
      userId: { name: "user_id", kind: "id", notNull: true, references: { table: "user", column: "id", onDelete: "cascade" } },
      accessToken: { name: "access_token", kind: "text" },
      refreshToken: { name: "refresh_token", kind: "text" },
      idToken: { name: "id_token", kind: "text" },
      accessTokenExpiresAt: { name: "access_token_expires_at", kind: "timestamp" },
      refreshTokenExpiresAt: { name: "refresh_token_expires_at", kind: "timestamp" },
      scope: { name: "scope", kind: "text" },
      password: { name: "password", kind: "text" },
      createdAt: { name: "created_at", ...now },
      updatedAt: { name: "updated_at", kind: "timestamp", notNull: true, onUpdateNow: true },
    },
    indexes: [{ name: "account_userId_idx", columns: ["userId"] }],
  },
  verification: {
    name: "verification",
    owner: "better-auth",
    doc: "메일 인증·비밀번호 재설정 등 일회용 값",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      identifier: { name: "identifier", kind: "string", length: 768, exact: true, notNull: true, doc: "예: saml-session:${providerId}:${nameID}" },
      value: { name: "value", kind: "text", notNull: true },
      expiresAt: { name: "expires_at", kind: "timestamp", notNull: true },
      createdAt: { name: "created_at", ...now },
      updatedAt: { name: "updated_at", ...now, onUpdateNow: true },
    },
    indexes: [{ name: "verification_identifier_idx", columns: ["identifier"] }],
  },
  ssoProvider: {
    name: "sso_provider",
    owner: "better-auth",
    doc: "SSO 제공자 (@better-auth/sso). 우리 쪽 추가 설정은 sso_provider_settings",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      issuer: { name: "issuer", kind: "text", notNull: true },
      oidcConfig: { name: "oidc_config", kind: "text", doc: "Better Auth 가 쓰는 JSON 문자열" },
      samlConfig: { name: "saml_config", kind: "text", doc: "Better Auth 가 쓰는 JSON 문자열" },
      userId: { name: "user_id", kind: "id", references: { table: "user", column: "id", onDelete: "cascade" } },
      providerId: { name: "provider_id", kind: "string", length: 255, exact: true, notNull: true, unique: true },
      organizationId: { name: "organization_id", kind: "text" },
      domain: { name: "domain", kind: "text", notNull: true },
    },
  },

  rateLimit: {
    name: "rate_limit",
    owner: "better-auth",
    doc: "인증 경로 요청 수 제한 (Better Auth rateLimit storage: \"database\", 계획서 3.2)",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      key: { name: "key", kind: "string", length: 255, exact: true, notNull: true, unique: true, doc: "IP + 경로" },
      count: { name: "count", kind: "integer", notNull: true },
      lastRequest: { name: "last_request", kind: "bigint", notNull: true, doc: "epoch ms" },
    },
  },

  // ---------- 회원 앱 ----------
  appSettings: {
    name: "app_settings",
    owner: "app",
    doc: "운영 설정. 키마다 한 행, 값은 JSON",
    columns: {
      key: {
        name: "key",
        kind: "string",
        length: 64,
        exact: true,
        primaryKey: true,
        doc: "signup_mode, allowed_domains, default_limit_usd, default_max_keys, signup_requires_approval, daily_signup_cap, public_base_url, budget_rebalance_month, usage_daily_confirmed, ...",
      },
      value: { name: "value", kind: "json", notNull: true },
      updatedAt: { name: "updated_at", kind: "timestamp", notNull: true },
      updatedBy: { name: "updated_by", kind: "id", doc: "바꾼 회원 id. 시드는 NULL" },
    },
  },
  ssoProviderSettings: {
    name: "sso_provider_settings",
    owner: "app",
    doc: "SSO 제공자마다 우리 쪽 설정 (계획서 4.3)",
    columns: {
      providerId: { name: "provider_id", kind: "string", length: 255, exact: true, primaryKey: true, doc: "Better Auth sso_provider.provider_id" },
      displayName: { name: "display_name", kind: "string", length: 255, notNull: true },
      showButton: { name: "show_button", kind: "boolean", notNull: true, default: true },
      enabled: { name: "enabled", kind: "boolean", notNull: true, default: true },
      jitEnabled: { name: "jit_enabled", kind: "boolean", notNull: true, default: true },
      defaultRole: { name: "default_role", kind: "string", length: 16, notNull: true, default: "member" },
      defaultLimitUsd: { name: "default_limit_usd", kind: "usd" },
      defaultMaxKeys: { name: "default_max_keys", kind: "integer" },
      groupClaim: { name: "group_claim", kind: "string", length: 255 },
      adminGroups: { name: "admin_groups", kind: "json", doc: "JSON 배열" },
    },
  },
  invites: {
    name: "invites",
    owner: "app",
    doc: "초대 링크. 관리자 역할 초대는 이메일 필수 (앱에서 검사, 계획서 4.2)",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      email: { name: "email", kind: "string", length: 255, doc: "소문자. role = admin 이면 필수" },
      tokenHash: { name: "token_hash", kind: "string", length: 128, exact: true, notNull: true, unique: true },
      role: { name: "role", kind: "string", length: 16, notNull: true, default: "member" },
      expiresAt: { name: "expires_at", kind: "timestamp", notNull: true },
      usedAt: { name: "used_at", kind: "timestamp" },
      createdBy: { name: "created_by", kind: "id", notNull: true },
      revokedAt: { name: "revoked_at", kind: "timestamp", doc: "관리자가 취소한 시각 (Q4). NULL 이면 취소되지 않음" },
      usedBy: { name: "used_by", kind: "id", doc: "이 초대로 가입한 회원 id. 수락을 마친 뒤 쓴다 (M3.T2)" },
    },
    // 만료한 초대 정리(M3.T3)가 expires_at 으로 찾는다
    indexes: [{ name: "idx_invites_expires", columns: ["expiresAt"] }],
  },
  apiKeys: {
    name: "api_keys",
    owner: "app",
    doc: "회원 키와 OmniRoute 키의 대응 (계획서 5.2, 5.7)",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      userId: { name: "user_id", kind: "id", notNull: true, references: { table: "user", column: "id" } },
      omnirouteKeyId: { name: "omniroute_key_id", kind: "string", length: 255, exact: true, notNull: true, unique: true },
      keyPreview: { name: "key_preview", kind: "string", length: 16, notNull: true, doc: "끝 4자리" },
      label: { name: "label", kind: "string", length: 255 },
      state: { name: "state", kind: "string", length: 16, notNull: true, doc: "active | disabled | deleted" },
      disabledReason: { name: "disabled_reason", kind: "string", length: 16, doc: "member | admin | user_status | limit (남은 한도 0, 계획서 v5.6 Q1)" },
      syncState: { name: "sync_state", kind: "string", length: 16, notNull: true, default: "synced", doc: "synced | pending | failed" },
      budgetUsd: { name: "budget_usd", kind: "usd", doc: "마지막으로 OmniRoute 에 건 월 예산" },
      createdAt: { name: "created_at", kind: "timestamp", notNull: true },
      deletedAt: { name: "deleted_at", kind: "timestamp" },
      budgetAt: { name: "budget_at", kind: "timestamp", doc: "budget_usd·limit 끄기를 계산한 분석 시각. 이보다 이른 분석으로 계산한 쓰기는 0행이다 (K2.T4)" },
      budgetMonth: { name: "budget_month", kind: "string", length: 7, doc: "budget_usd 를 OmniRoute 에 건 달 (UTC YYYY-MM). 새 달 첫 분배가 중간에 멈춰도 이미 건 키는 건너뛴다 (K2 리뷰 M2)" },
    },
    indexes: [{ name: "idx_api_keys_user", columns: ["userId"] }],
  },
  usageDaily: {
    name: "usage_daily",
    owner: "app",
    doc: "지난 날 키별 비용 (계획서 v5.7 5.3·5.9). 1분 분배는 오늘 창만 부르고 이것을 더한다",
    columns: {
      keyId: { name: "key_id", kind: "string", length: 255, exact: true, notNull: true, doc: "OmniRoute 키 id (api_keys.omniroute_key_id, 삭제한 키 포함)" },
      day: { name: "day", kind: "string", length: 10, notNull: true, doc: "UTC 날짜 YYYY-MM-DD" },
      costUsd: { name: "cost_usd", kind: "usd", notNull: true },
      updatedAt: { name: "updated_at", kind: "timestamp", notNull: true, doc: "날 확정·대조 때 갱신" },
    },
    primaryKey: ["keyId", "day"],
  },
  omnirouteJobs: {
    name: "omniroute_jobs",
    owner: "app",
    doc: "OmniRoute 에 보낼 작업 대기열 (재시도)",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      action: { name: "action", kind: "string", length: 64, notNull: true, doc: "key.apply_state, key.delete, budget.set, key.rollback, ..." },
      payload: { name: "payload", kind: "json", notNull: true },
      attempts: { name: "attempts", kind: "integer", notNull: true, default: 0 },
      lastError: { name: "last_error", kind: "text" },
      nextRunAt: { name: "next_run_at", kind: "timestamp", notNull: true },
      doneAt: { name: "done_at", kind: "timestamp" },
      failedAt: { name: "failed_at", kind: "timestamp", doc: "4번째 재시도 실패 시각 (계획서 v5.6 Q3). 지금 − failed_at > 30분이면 오래 실패" },
      generation: { name: "generation", kind: "integer", notNull: true, default: 0, doc: "합칠 때마다 1 씩 는다. 결과 쓰기는 차지할 때 읽은 값이 그대로일 때만 (K1 재검토)" },
      interrupts: { name: "interrupts", kind: "integer", notNull: true, default: 0, doc: "임대를 잃어 끊긴 횟수. attempts 와 따로 센다 (K1 재검토)" },
      keyId: { name: "key_id", kind: "id", doc: "대상 api_keys.id (없으면 NULL). 같은 키의 미완료 key.apply_state 합치기·key.delete 우선·실패 표시에 쓴다 (K1 리뷰 #1)" },
    },
    // 실행할 작업 찾기: done_at IS NULL AND failed_at IS NULL AND next_run_at <= now. 키별 미완료 작업 찾기: key_id, done_at
    indexes: [
      { name: "idx_omniroute_jobs_due", columns: ["doneAt", "nextRunAt"] },
      { name: "idx_omniroute_jobs_key", columns: ["keyId", "doneAt"] },
    ],
  },
  jobLeases: {
    name: "job_leases",
    owner: "app",
    doc: "여러 인스턴스에서 주기 작업 중복 실행 방지 (임대 잠금)",
    columns: {
      name: { name: "name", kind: "string", length: 64, exact: true, primaryKey: true, doc: "budget_rebalance, reconcile, ..." },
      holder: { name: "holder", kind: "string", length: 255, exact: true, notNull: true },
      lockedUntil: { name: "locked_until", kind: "timestamp", notNull: true },
      fence: { name: "fence", kind: "integer", notNull: true, default: 0, doc: "펜싱 토큰. 잡을 때마다 1 씩 는다. 쓰기는 이 값이 그대로일 때만 한다 (K1.T2)" },
      lastSlot: { name: "last_slot", kind: "bigint", doc: "마지막으로 돈 주기 경계 번호 (경계 시각 / 주기). 같은 경계는 다시 잡지 않는다 (K1 리뷰 #6)" },
    },
  },
  auditLog: {
    name: "audit_log",
    owner: "app",
    doc: "감사 기록",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      actorId: { name: "actor_id", kind: "id" },
      action: { name: "action", kind: "string", length: 64, notNull: true },
      target: { name: "target", kind: "string", length: 255 },
      detail: { name: "detail", kind: "json", doc: "비밀 값 제외" },
      ip: { name: "ip", kind: "string", length: 64 },
      createdAt: { name: "created_at", kind: "timestamp", notNull: true },
    },
    indexes: [{ name: "idx_audit_log_created", columns: ["createdAt"] }],
  },

  // ---------- 관리자 MFA (A1, 설계 docs/plan/phase4-a1-admin-mfa.md 2절) ----------
  // 회원 행을 지우는 경로(가입 거절 row_deleted)가 MFA 행 때문에 막히지 않게 user_id 참조는 ON DELETE CASCADE 다.
  // session·account 의 Better Auth 참조와 같은 규칙이다. foreign_keys 가 꺼진 SQLite 연결에서는 cascade 가 돌지 않으므로
  // 삭제 경로(guard-sql cleanupOwned)가 MFA 행을 직접 지우는 일은 서버 연결 단계에서 함께 맞춘다.
  mfaFactor: {
    name: "mfa_factor",
    owner: "app",
    doc: "관리자 MFA 수단 (TOTP). 회원당 active 하나·pending 하나를 active_slot·pending_slot 고유 키로 강제한다",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      userId: { name: "user_id", kind: "id", notNull: true, references: { table: "user", column: "id", onDelete: "cascade" } },
      kind: { name: "kind", kind: "string", length: 16, exact: true, notNull: true, doc: "totp" },
      state: { name: "state", kind: "string", length: 16, exact: true, notNull: true, doc: "pending | active | revoked" },
      secretEnc: { name: "secret_enc", kind: "text", notNull: true, doc: "createCipher 암호문. AAD 는 mfa_factor.secret_enc|v1|{factorId}|{userId}" },
      periodS: { name: "period_s", kind: "integer", notNull: true, doc: "등록 당시 정책의 TOTP step 폭(초)" },
      digits: { name: "digits", kind: "integer", notNull: true, doc: "등록 당시 정책의 자릿수" },
      algorithm: { name: "algorithm", kind: "string", length: 16, exact: true, notNull: true, doc: "등록 당시 정책의 HMAC 해시: SHA-1 | SHA-256 | SHA-512" },
      lastUsedStep: { name: "last_used_step", kind: "bigint", doc: "마지막으로 받은 시간 step. 이보다 큰 step 만 받는다 (재사용 차단 CAS)" },
      pendingSessionId: { name: "pending_session_id", kind: "id", doc: "등록을 시작한 세션. pending 일 때만" },
      pendingAuthVersion: { name: "pending_auth_version", kind: "integer", doc: "등록을 시작할 때 관찰한 user.auth_version. pending 일 때만" },
      pendingExpiresAt: { name: "pending_expires_at", kind: "timestamp", doc: "등록 확인 마감. pending 일 때만" },
      activeSlot: { name: "active_slot", kind: "id", unique: true, doc: "state = active 이면 user_id, 아니면 NULL. MySQL 에 부분 인덱스가 없어 회원당 active 하나를 이것으로 강제한다" },
      pendingSlot: { name: "pending_slot", kind: "id", unique: true, doc: "state = pending 이면 user_id, 아니면 NULL. 회원당 pending 하나" },
      createdAt: { name: "created_at", ...now },
      activatedAt: { name: "activated_at", kind: "timestamp" },
      revokedAt: { name: "revoked_at", kind: "timestamp" },
      revokedReason: { name: "revoked_reason", kind: "string", length: 32, doc: "replaced | superseded | demoted | reset | ..." },
    },
    indexes: [{ name: "idx_mfa_factor_user", columns: ["userId"] }],
  },
  mfaRecoveryCode: {
    name: "mfa_recovery_code",
    owner: "app",
    doc: "관리자 MFA 복구 코드. 원문은 두지 않고 HMAC 만 둔다. used_at IS NULL 조건 UPDATE 하나로 한 번만 소비한다",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      factorId: { name: "factor_id", kind: "id", notNull: true, references: { table: "mfa_factor", column: "id", onDelete: "cascade" } },
      userId: { name: "user_id", kind: "id", notNull: true, references: { table: "user", column: "id", onDelete: "cascade" } },
      codeHash: { name: "code_hash", kind: "string", length: 64, exact: true, notNull: true, doc: "HMAC-SHA256(서버 키, factorId|code) hex" },
      usedAt: { name: "used_at", kind: "timestamp" },
      usedSessionId: { name: "used_session_id", kind: "id" },
    },
    indexes: [{ name: "uniq_mfa_recovery_code_factor_hash", columns: ["factorId", "codeHash"], unique: true }],
  },
  mfaEnrollmentGrant: {
    name: "mfa_enrollment_grant",
    owner: "app",
    doc: "관리자 MFA 최초 등록 자격. 토큰 원문은 두지 않는다. 한 번만 쓴다",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      userId: { name: "user_id", kind: "id", notNull: true, references: { table: "user", column: "id", onDelete: "cascade" } },
      tokenHash: { name: "token_hash", kind: "string", length: 64, exact: true, notNull: true, unique: true, doc: "HMAC-SHA256(서버 키, token) hex" },
      purpose: { name: "purpose", kind: "string", length: 16, exact: true, notNull: true, doc: "bootstrap | promotion | reset | transition" },
      issuedBy: { name: "issued_by", kind: "id", doc: "발급한 회원 id. 설치·운영자 CLI 는 NULL" },
      authVersion: { name: "auth_version", kind: "integer", notNull: true, doc: "발급할 때의 대상 user.auth_version. 다르면 쓸 수 없다" },
      expiresAt: { name: "expires_at", kind: "timestamp", notNull: true },
      usedAt: { name: "used_at", kind: "timestamp" },
      revokedAt: { name: "revoked_at", kind: "timestamp" },
    },
  },
  mfaProof: {
    name: "mfa_proof",
    owner: "app",
    doc: "작업에 묶인 step-up 증명. 토큰 원문은 두지 않는다. 작업 자신의 트랜잭션 안에서 used_at IS NULL 조건 UPDATE 로 한 번만 소비한다",
    columns: {
      id: { name: "id", kind: "id", primaryKey: true },
      tokenHash: { name: "token_hash", kind: "string", length: 64, exact: true, notNull: true, unique: true, doc: "HMAC-SHA256(서버 키, mfa_proof|v1|token) hex. 토큰 원문은 두지 않는다" },
      sessionId: { name: "session_id", kind: "id", notNull: true, references: { table: "session", column: "id", onDelete: "cascade" }, doc: "proof 를 만든 세션. 세션을 지우면 proof 도 지운다" },
      userId: { name: "user_id", kind: "id", notNull: true, references: { table: "user", column: "id", onDelete: "cascade" } },
      authVersion: { name: "auth_version", kind: "integer", notNull: true },
      factorId: { name: "factor_id", kind: "id", notNull: true, doc: "proof 를 만든 factor. 소비 때 이 factor 가 아직 active 여야 한다" },
      purpose: { name: "purpose", kind: "string", length: 64, exact: true, notNull: true, doc: "mfa.reenroll, mfa.reset, role.change, ..." },
      target: { name: "target", kind: "string", length: 255, exact: true, notNull: true, doc: "작업 대상 (예: 회원 id)" },
      expiresAt: { name: "expires_at", kind: "timestamp", notNull: true },
      usedAt: { name: "used_at", kind: "timestamp" },
    },
  },
};
