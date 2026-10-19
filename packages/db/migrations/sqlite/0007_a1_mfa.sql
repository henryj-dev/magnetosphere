CREATE TABLE `mfa_enrollment_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`issued_by` text,
	`auth_version` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mfa_enrollment_grant_token_hash_unique` ON `mfa_enrollment_grant` (`token_hash`);--> statement-breakpoint
CREATE TABLE `mfa_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`secret_enc` text NOT NULL,
	`period_s` integer NOT NULL,
	`digits` integer NOT NULL,
	`algorithm` text NOT NULL,
	`last_used_step` integer,
	`pending_session_id` text,
	`pending_auth_version` integer,
	`pending_expires_at` integer,
	`active_slot` text,
	`pending_slot` text,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	`revoked_at` integer,
	`revoked_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mfa_factor_active_slot_unique` ON `mfa_factor` (`active_slot`);--> statement-breakpoint
CREATE UNIQUE INDEX `mfa_factor_pending_slot_unique` ON `mfa_factor` (`pending_slot`);--> statement-breakpoint
CREATE INDEX `idx_mfa_factor_user` ON `mfa_factor` (`user_id`);--> statement-breakpoint
CREATE TABLE `mfa_proof` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`auth_version` integer NOT NULL,
	`factor_id` text NOT NULL,
	`purpose` text NOT NULL,
	`target` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mfa_proof_token_hash_unique` ON `mfa_proof` (`token_hash`);--> statement-breakpoint
CREATE TABLE `mfa_recovery_code` (
	`id` text PRIMARY KEY NOT NULL,
	`factor_id` text NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`used_session_id` text,
	FOREIGN KEY (`factor_id`) REFERENCES `mfa_factor`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_mfa_recovery_code_factor_hash` ON `mfa_recovery_code` (`factor_id`,`code_hash`);--> statement-breakpoint
ALTER TABLE `session` ADD `mfa_verified_at` integer;--> statement-breakpoint
ALTER TABLE `session` ADD `mfa_factor_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `mfa_method` text;--> statement-breakpoint
ALTER TABLE `session` ADD `mfa_policy_version` text;