// 자동 생성 파일이다. 손으로 고치지 않는다.
// 원본: packages/db/src/schema/common.ts · 생성: pnpm -C packages/db gen
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 회원. Better Auth 칼럼 + 권한 칼럼 다섯
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdate(() => new Date()).notNull(),
  role: text("role").default("member").notNull(),
  status: text("status").default("active").notNull(),
  monthlyLimitUsd: real("monthly_limit_usd"),
  maxKeys: integer("max_keys"),
  isBootstrapAdmin: integer("is_bootstrap_admin", { mode: "boolean" }).default(false).notNull(),
});

// 로그인 세션
export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$onUpdate(() => new Date()).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, (table) => [
  index("session_userId_idx").on(table.userId),
]);

// 로그인 방식 (비밀번호, OAuth, SSO)
export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$onUpdate(() => new Date()).notNull(),
}, (table) => [
  index("account_userId_idx").on(table.userId),
]);

// 메일 인증·비밀번호 재설정 등 일회용 값
export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).$onUpdate(() => new Date()).notNull(),
}, (table) => [
  index("verification_identifier_idx").on(table.identifier),
]);

// SSO 제공자 (@better-auth/sso). 우리 쪽 추가 설정은 sso_provider_settings
export const ssoProvider = sqliteTable("sso_provider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
});

// 인증 경로 요청 수 제한 (Better Auth rateLimit storage: "database", 계획서 3.2)
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

// 운영 설정. 키마다 한 행, 값은 JSON
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  updatedBy: text("updated_by"),
});

// SSO 제공자마다 우리 쪽 설정 (계획서 4.3)
export const ssoProviderSettings = sqliteTable("sso_provider_settings", {
  providerId: text("provider_id").primaryKey(),
  displayName: text("display_name").notNull(),
  showButton: integer("show_button", { mode: "boolean" }).default(true).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  jitEnabled: integer("jit_enabled", { mode: "boolean" }).default(true).notNull(),
  defaultRole: text("default_role").default("member").notNull(),
  defaultLimitUsd: real("default_limit_usd"),
  defaultMaxKeys: integer("default_max_keys"),
  groupClaim: text("group_claim"),
  adminGroups: text("admin_groups"),
});

// 초대 링크. 관리자 역할 초대는 이메일 필수 (앱에서 검사, 계획서 4.2)
export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  email: text("email"),
  tokenHash: text("token_hash").notNull().unique(),
  role: text("role").default("member").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  createdBy: text("created_by").notNull(),
});

// 회원 키와 OmniRoute 키의 대응 (계획서 5.2, 5.7)
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  omnirouteKeyId: text("omniroute_key_id").notNull().unique(),
  keyPreview: text("key_preview").notNull(),
  label: text("label"),
  state: text("state").notNull(),
  disabledReason: text("disabled_reason"),
  syncState: text("sync_state").default("synced").notNull(),
  budgetUsd: real("budget_usd"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  budgetAt: integer("budget_at", { mode: "timestamp_ms" }),
}, (table) => [
  index("idx_api_keys_user").on(table.userId),
]);

// 지난 날 키별 비용 (계획서 v5.7 5.3·5.9). 1분 분배는 오늘 창만 부르고 이것을 더한다
export const usageDaily = sqliteTable("usage_daily", {
  keyId: text("key_id").notNull(),
  day: text("day").notNull(),
  costUsd: real("cost_usd").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.keyId, table.day] }),
]);

// OmniRoute 에 보낼 작업 대기열 (재시도)
export const omnirouteJobs = sqliteTable("omniroute_jobs", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  payload: text("payload").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  lastError: text("last_error"),
  nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }).notNull(),
  doneAt: integer("done_at", { mode: "timestamp_ms" }),
  failedAt: integer("failed_at", { mode: "timestamp_ms" }),
  generation: integer("generation").default(0).notNull(),
  interrupts: integer("interrupts").default(0).notNull(),
  keyId: text("key_id"),
}, (table) => [
  index("idx_omniroute_jobs_due").on(table.doneAt, table.nextRunAt),
  index("idx_omniroute_jobs_key").on(table.keyId, table.doneAt),
]);

// 여러 인스턴스에서 주기 작업 중복 실행 방지 (임대 잠금)
export const jobLeases = sqliteTable("job_leases", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  lockedUntil: integer("locked_until", { mode: "timestamp_ms" }).notNull(),
  fence: integer("fence").default(0).notNull(),
  lastSlot: integer("last_slot"),
});

// 감사 기록
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  target: text("target"),
  detail: text("detail"),
  ip: text("ip"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_audit_log_created").on(table.createdAt),
]);
