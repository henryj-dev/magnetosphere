// 자동 생성 파일이다. 손으로 고치지 않는다.
// 원본: packages/db/src/schema/common.ts · 생성: pnpm -C packages/db gen
import { bigint, boolean, customType, datetime, decimal, index, int, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";

// 대소문자까지 정확히 같아야 하는 칼럼 (common.ts 의 exact). MySQL·MariaDB 기본 정렬은 대소문자를 무시한다.
const varcharBin = customType<{ data: string; config: { length: number } }>({
  dataType: (config) => `varchar(${config?.length}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
});
const textBin = customType<{ data: string }>({ dataType: () => "text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin" });

// 회원. Better Auth 칼럼 + 권한 칼럼 다섯
export const user = mysqlTable("user", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: text("name").notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: datetime("created_at", { fsp: 3 }).$defaultFn(() => new Date()).notNull(),
  updatedAt: datetime("updated_at", { fsp: 3 }).$defaultFn(() => new Date()).$onUpdate(() => new Date()).notNull(),
  role: varchar("role", { length: 16 }).default("member").notNull(),
  status: varchar("status", { length: 16 }).default("active").notNull(),
  monthlyLimitUsd: decimal("monthly_limit_usd", { precision: 12, scale: 6, mode: "number" }),
  maxKeys: int("max_keys"),
  isBootstrapAdmin: boolean("is_bootstrap_admin").default(false).notNull(),
});

// 로그인 세션
export const session = mysqlTable("session", {
  id: varchar("id", { length: 36 }).primaryKey(),
  expiresAt: datetime("expires_at", { fsp: 3 }).notNull(),
  token: varcharBin("token", { length: 255 }).notNull().unique(),
  createdAt: datetime("created_at", { fsp: 3 }).$defaultFn(() => new Date()).notNull(),
  updatedAt: datetime("updated_at", { fsp: 3 }).$onUpdate(() => new Date()).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => user.id, { onDelete: "cascade" }),
}, (table) => [
  index("session_userId_idx").on(table.userId),
]);

// 로그인 방식 (비밀번호, OAuth, SSO)
export const account = mysqlTable("account", {
  id: varchar("id", { length: 36 }).primaryKey(),
  accountId: textBin("account_id").notNull(),
  providerId: textBin("provider_id").notNull(),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: datetime("access_token_expires_at", { fsp: 3 }),
  refreshTokenExpiresAt: datetime("refresh_token_expires_at", { fsp: 3 }),
  scope: text("scope"),
  password: text("password"),
  createdAt: datetime("created_at", { fsp: 3 }).$defaultFn(() => new Date()).notNull(),
  updatedAt: datetime("updated_at", { fsp: 3 }).$onUpdate(() => new Date()).notNull(),
}, (table) => [
  index("account_userId_idx").on(table.userId),
]);

// 메일 인증·비밀번호 재설정 등 일회용 값
export const verification = mysqlTable("verification", {
  id: varchar("id", { length: 36 }).primaryKey(),
  identifier: varcharBin("identifier", { length: 768 }).notNull(),
  value: text("value").notNull(),
  expiresAt: datetime("expires_at", { fsp: 3 }).notNull(),
  createdAt: datetime("created_at", { fsp: 3 }).$defaultFn(() => new Date()).notNull(),
  updatedAt: datetime("updated_at", { fsp: 3 }).$defaultFn(() => new Date()).$onUpdate(() => new Date()).notNull(),
}, (table) => [
  index("verification_identifier_idx").on(table.identifier),
]);

// SSO 제공자 (@better-auth/sso). 우리 쪽 추가 설정은 sso_provider_settings
export const ssoProvider = mysqlTable("sso_provider", {
  id: varchar("id", { length: 36 }).primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: varchar("user_id", { length: 36 }).references(() => user.id, { onDelete: "cascade" }),
  providerId: varcharBin("provider_id", { length: 255 }).notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
});

// 인증 경로 요청 수 제한 (Better Auth rateLimit storage: "database", 계획서 3.2)
export const rateLimit = mysqlTable("rate_limit", {
  id: varchar("id", { length: 36 }).primaryKey(),
  key: varcharBin("key", { length: 255 }).notNull().unique(),
  count: int("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// 운영 설정. 키마다 한 행, 값은 JSON
export const appSettings = mysqlTable("app_settings", {
  key: varcharBin("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: datetime("updated_at", { fsp: 3 }).notNull(),
  updatedBy: varchar("updated_by", { length: 36 }),
});

// SSO 제공자마다 우리 쪽 설정 (계획서 4.3)
export const ssoProviderSettings = mysqlTable("sso_provider_settings", {
  providerId: varcharBin("provider_id", { length: 255 }).primaryKey(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  showButton: boolean("show_button").default(true).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  jitEnabled: boolean("jit_enabled").default(true).notNull(),
  defaultRole: varchar("default_role", { length: 16 }).default("member").notNull(),
  defaultLimitUsd: decimal("default_limit_usd", { precision: 12, scale: 6, mode: "number" }),
  defaultMaxKeys: int("default_max_keys"),
  groupClaim: varchar("group_claim", { length: 255 }),
  adminGroups: text("admin_groups"),
});

// 초대 링크. 관리자 역할 초대는 이메일 필수 (앱에서 검사, 계획서 4.2)
export const invites = mysqlTable("invites", {
  id: varchar("id", { length: 36 }).primaryKey(),
  email: varchar("email", { length: 255 }),
  tokenHash: varcharBin("token_hash", { length: 128 }).notNull().unique(),
  role: varchar("role", { length: 16 }).default("member").notNull(),
  expiresAt: datetime("expires_at", { fsp: 3 }).notNull(),
  usedAt: datetime("used_at", { fsp: 3 }),
  createdBy: varchar("created_by", { length: 36 }).notNull(),
});

// 회원 키와 OmniRoute 키의 대응 (계획서 5.2, 5.7)
export const apiKeys = mysqlTable("api_keys", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => user.id),
  omnirouteKeyId: varcharBin("omniroute_key_id", { length: 255 }).notNull().unique(),
  keyPreview: varchar("key_preview", { length: 16 }).notNull(),
  label: varchar("label", { length: 255 }),
  state: varchar("state", { length: 16 }).notNull(),
  disabledReason: varchar("disabled_reason", { length: 16 }),
  syncState: varchar("sync_state", { length: 16 }).default("synced").notNull(),
  budgetUsd: decimal("budget_usd", { precision: 12, scale: 6, mode: "number" }),
  createdAt: datetime("created_at", { fsp: 3 }).notNull(),
  deletedAt: datetime("deleted_at", { fsp: 3 }),
}, (table) => [
  index("idx_api_keys_user").on(table.userId),
]);

// OmniRoute 에 보낼 작업 대기열 (재시도)
export const omnirouteJobs = mysqlTable("omniroute_jobs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  action: varchar("action", { length: 64 }).notNull(),
  payload: text("payload").notNull(),
  attempts: int("attempts").default(0).notNull(),
  lastError: text("last_error"),
  nextRunAt: datetime("next_run_at", { fsp: 3 }).notNull(),
  doneAt: datetime("done_at", { fsp: 3 }),
  failedAt: datetime("failed_at", { fsp: 3 }),
  generation: int("generation").default(0).notNull(),
  interrupts: int("interrupts").default(0).notNull(),
  keyId: varchar("key_id", { length: 36 }),
}, (table) => [
  index("idx_omniroute_jobs_due").on(table.doneAt, table.nextRunAt),
  index("idx_omniroute_jobs_key").on(table.keyId, table.doneAt),
]);

// 여러 인스턴스에서 주기 작업 중복 실행 방지 (임대 잠금)
export const jobLeases = mysqlTable("job_leases", {
  name: varcharBin("name", { length: 64 }).primaryKey(),
  holder: varcharBin("holder", { length: 255 }).notNull(),
  lockedUntil: datetime("locked_until", { fsp: 3 }).notNull(),
  fence: int("fence").default(0).notNull(),
  lastSlot: bigint("last_slot", { mode: "number" }),
});

// 감사 기록
export const auditLog = mysqlTable("audit_log", {
  id: varchar("id", { length: 36 }).primaryKey(),
  actorId: varchar("actor_id", { length: 36 }),
  action: varchar("action", { length: 64 }).notNull(),
  target: varchar("target", { length: 255 }),
  detail: text("detail"),
  ip: varchar("ip", { length: 64 }),
  createdAt: datetime("created_at", { fsp: 3 }).notNull(),
}, (table) => [
  index("idx_audit_log_created").on(table.createdAt),
]);
