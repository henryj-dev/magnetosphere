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
  indexes?: { name: string; columns: string[] }[];
}

const now = { kind: "timestamp", notNull: true, defaultNow: true } as const;

// Better Auth user 테이블에 더하는 칼럼 (계획서 4.6). 모두 input: false — 가입·회원정보 수정 요청으로 바꾸지 못한다.
// Better Auth 구성은 src/auth-options.ts 의 AUTH_SCHEMA_OPTIONS 를 거쳐 이 객체를 user.additionalFields 로 쓴다.
export const USER_ADDITIONAL_FIELDS = {
  role: { type: "string", required: false, defaultValue: "member", input: false },
  status: { type: "string", required: false, defaultValue: "active", input: false },
  monthlyLimitUsd: { type: "number", required: false, input: false },
  maxKeys: { type: "number", required: false, input: false },
  isBootstrapAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
} as const;

export const TABLES: Record<string, Table> = {
  // ---------- Better Auth (1.7.7 + @better-auth/sso) ----------
  user: {
    name: "user",
    owner: "better-auth",
    doc: "회원. Better Auth 칼럼 + 권한 칼럼 다섯",
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
    },
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
};
