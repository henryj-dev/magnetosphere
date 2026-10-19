CREATE TABLE "mfa_enrollment_grant" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"purpose" varchar(16) NOT NULL,
	"issued_by" varchar(36),
	"auth_version" integer NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "mfa_enrollment_grant_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mfa_factor" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"state" varchar(16) NOT NULL,
	"secret_enc" text NOT NULL,
	"period_s" integer NOT NULL,
	"digits" integer NOT NULL,
	"algorithm" varchar(16) NOT NULL,
	"last_used_step" bigint,
	"pending_session_id" varchar(36),
	"pending_auth_version" integer,
	"pending_expires_at" timestamp,
	"active_slot" varchar(36),
	"pending_slot" varchar(36),
	"created_at" timestamp NOT NULL,
	"activated_at" timestamp,
	"revoked_at" timestamp,
	"revoked_reason" varchar(32),
	CONSTRAINT "mfa_factor_active_slot_unique" UNIQUE("active_slot"),
	CONSTRAINT "mfa_factor_pending_slot_unique" UNIQUE("pending_slot")
);
--> statement-breakpoint
CREATE TABLE "mfa_proof" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"auth_version" integer NOT NULL,
	"factor_id" varchar(36) NOT NULL,
	"purpose" varchar(64) NOT NULL,
	"target" varchar(255) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	CONSTRAINT "mfa_proof_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_code" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"factor_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"used_at" timestamp,
	"used_session_id" varchar(36)
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_factor_id" varchar(36);--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_method" varchar(16);--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_policy_version" varchar(64);--> statement-breakpoint
ALTER TABLE "mfa_enrollment_grant" ADD CONSTRAINT "mfa_enrollment_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_factor" ADD CONSTRAINT "mfa_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_proof" ADD CONSTRAINT "mfa_proof_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_proof" ADD CONSTRAINT "mfa_proof_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_code" ADD CONSTRAINT "mfa_recovery_code_factor_id_mfa_factor_id_fk" FOREIGN KEY ("factor_id") REFERENCES "public"."mfa_factor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_code" ADD CONSTRAINT "mfa_recovery_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mfa_factor_user" ON "mfa_factor" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_mfa_recovery_code_factor_hash" ON "mfa_recovery_code" USING btree ("factor_id","code_hash");