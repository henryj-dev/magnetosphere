// 자동 생성 파일이다. 손으로 고치지 않는다.
// 원본: packages/db/src/schema/common.ts · 생성: pnpm -C packages/db gen
import { bigint, boolean, index, integer, numeric, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

// 회원. Better Auth 칼럼 + 권한 칼럼 다섯
export const user = pgTable("user", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: text("name").notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).$onUpdate(() => new Date()).notNull(),
  role: varchar("role", { length: 16 }).default("member").notNull(),
  status: varchar("status", { length: 16 }).default("active").notNull(),
  monthlyLimitUsd: numeric("monthly_limit_usd", { precision: 12, scale: 6, mode: "number" }),
  maxKeys: integer("max_keys"),
  isBootstrapAdmin: boolean("is_bootstrap_admin").default(false).notNull(),
});

// 로그인 세션
export const session = pgTable("session", {
  id: varchar("id", { length: 36 }).primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: varchar("token", { length: 255 }).notNull().unique(),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
  updatedAt: timestamp("updated_at").$onUpdate(() => new Date()).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => user.id, { onDelete: "cascade" }),
}, (table) => [
  index("session_userId_idx").on(table.userId),
]);

// 로그인 방식 (비밀번호, OAuth, SSO)
export const account = pgTable("account", {
  id: varchar("id", { length: 36 }).primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
  updatedAt: timestamp("updated_at").$onUpdate(() => new Date()).notNull(),
}, (table) => [
  index("account_userId_idx").on(table.userId),
]);

// 메일 인증·비밀번호 재설정 등 일회용 값
export const verification = pgTable("verification", {
  id: varchar("id", { length: 36 }).primaryKey(),
  identifier: varchar("identifier", { length: 768 }).notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).$onUpdate(() => new Date()).notNull(),
}, (table) => [
  index("verification_identifier_idx").on(table.identifier),
]);

// SSO 제공자 (@better-auth/sso). 우리 쪽 추가 설정은 sso_provider_settings
export const ssoProvider = pgTable("sso_provider", {
  id: varchar("id", { length: 36 }).primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: varchar("user_id", { length: 36 }).references(() => user.id, { onDelete: "cascade" }),
  providerId: varchar("provider_id", { length: 255 }).notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
});

// 인증 경로 요청 수 제한 (Better Auth rateLimit storage: "database", 계획서 3.2)
export const rateLimit = pgTable("rate_limit", {
  id: varchar("id", { length: 36 }).primaryKey(),
  key: varchar("key", { length: 255 }).notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// 운영 설정. 키마다 한 행, 값은 JSON
export const appSettings = pgTable("app_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  updatedBy: varchar("updated_by", { length: 36 }),
});

// SSO 제공자마다 우리 쪽 설정 (계획서 4.3)
export const ssoProviderSettings = pgTable("sso_provider_settings", {
  providerId: varchar("provider_id", { length: 255 }).primaryKey(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  showButton: boolean("show_button").default(true).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  jitEnabled: boolean("jit_enabled").default(true).notNull(),
  defaultRole: varchar("default_role", { length: 16 }).default("member").notNull(),
  defaultLimitUsd: numeric("default_limit_usd", { precision: 12, scale: 6, mode: "number" }),
  defaultMaxKeys: integer("default_max_keys"),
  groupClaim: varchar("group_claim", { length: 255 }),
  adminGroups: text("admin_groups"),
});

// 초대 링크. 관리자 역할 초대는 이메일 필수 (앱에서 검사, 계획서 4.2)
export const invites = pgTable("invites", {
  id: varchar("id", { length: 36 }).primaryKey(),
  email: varchar("email", { length: 255 }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  role: varchar("role", { length: 16 }).default("member").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdBy: varchar("created_by", { length: 36 }).notNull(),
});

// 회원 키와 OmniRoute 키의 대응 (계획서 5.2, 5.7)
export const apiKeys = pgTable("api_keys", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => user.id),
  omnirouteKeyId: varchar("omniroute_key_id", { length: 255 }).notNull().unique(),
  keyPreview: varchar("key_preview", { length: 16 }).notNull(),
  label: varchar("label", { length: 255 }),
  state: varchar("state", { length: 16 }).notNull(),
  disabledReason: varchar("disabled_reason", { length: 16 }),
  syncState: varchar("sync_state", { length: 16 }).default("synced").notNull(),
  budgetUsd: numeric("budget_usd", { precision: 12, scale: 6, mode: "number" }),
  createdAt: timestamp("created_at").notNull(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_api_keys_user").on(table.userId),
]);

// OmniRoute 에 보낼 작업 대기열 (재시도)
export const omnirouteJobs = pgTable("omniroute_jobs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  action: varchar("action", { length: 64 }).notNull(),
  payload: text("payload").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  lastError: text("last_error"),
  nextRunAt: timestamp("next_run_at").notNull(),
  doneAt: timestamp("done_at"),
  failedAt: timestamp("failed_at"),
  generation: integer("generation").default(0).notNull(),
  interrupts: integer("interrupts").default(0).notNull(),
  keyId: varchar("key_id", { length: 36 }),
}, (table) => [
  index("idx_omniroute_jobs_due").on(table.doneAt, table.nextRunAt),
  index("idx_omniroute_jobs_key").on(table.keyId, table.doneAt),
]);

// 여러 인스턴스에서 주기 작업 중복 실행 방지 (임대 잠금)
export const jobLeases = pgTable("job_leases", {
  name: varchar("name", { length: 64 }).primaryKey(),
  holder: varchar("holder", { length: 255 }).notNull(),
  lockedUntil: timestamp("locked_until").notNull(),
  fence: integer("fence").default(0).notNull(),
  lastSlot: bigint("last_slot", { mode: "number" }),
});

// 감사 기록
export const auditLog = pgTable("audit_log", {
  id: varchar("id", { length: 36 }).primaryKey(),
  actorId: varchar("actor_id", { length: 36 }),
  action: varchar("action", { length: 64 }).notNull(),
  target: varchar("target", { length: 255 }),
  detail: text("detail"),
  ip: varchar("ip", { length: 64 }),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  index("idx_audit_log_created").on(table.createdAt),
]);
