CREATE TABLE `mfa_enrollment_grant` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`token_hash` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`purpose` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`issued_by` varchar(36),
	`auth_version` int NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`revoked_at` datetime(3),
	CONSTRAINT `mfa_enrollment_grant_id` PRIMARY KEY(`id`),
	CONSTRAINT `mfa_enrollment_grant_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `mfa_factor` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`kind` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`state` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`secret_enc` text NOT NULL,
	`period_s` int NOT NULL,
	`digits` int NOT NULL,
	`algorithm` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`last_used_step` bigint,
	`pending_session_id` varchar(36),
	`pending_auth_version` int,
	`pending_expires_at` datetime(3),
	`active_slot` varchar(36),
	`pending_slot` varchar(36),
	`created_at` datetime(3) NOT NULL,
	`activated_at` datetime(3),
	`revoked_at` datetime(3),
	`revoked_reason` varchar(32),
	CONSTRAINT `mfa_factor_id` PRIMARY KEY(`id`),
	CONSTRAINT `mfa_factor_active_slot_unique` UNIQUE(`active_slot`),
	CONSTRAINT `mfa_factor_pending_slot_unique` UNIQUE(`pending_slot`)
);
--> statement-breakpoint
CREATE TABLE `mfa_proof` (
	`id` varchar(36) NOT NULL,
	`token_hash` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`session_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`auth_version` int NOT NULL,
	`factor_id` varchar(36) NOT NULL,
	`purpose` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`target` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	CONSTRAINT `mfa_proof_id` PRIMARY KEY(`id`),
	CONSTRAINT `mfa_proof_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `mfa_recovery_code` (
	`id` varchar(36) NOT NULL,
	`factor_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`code_hash` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`used_at` datetime(3),
	`used_session_id` varchar(36),
	CONSTRAINT `mfa_recovery_code_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_mfa_recovery_code_factor_hash` UNIQUE(`factor_id`,`code_hash`)
);
--> statement-breakpoint
ALTER TABLE `session` ADD `mfa_verified_at` datetime(3);--> statement-breakpoint
ALTER TABLE `session` ADD `mfa_factor_id` varchar(36);--> statement-breakpoint
ALTER TABLE `session` ADD `mfa_method` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;--> statement-breakpoint
ALTER TABLE `session` ADD `mfa_policy_version` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;--> statement-breakpoint
ALTER TABLE `mfa_enrollment_grant` ADD CONSTRAINT `mfa_enrollment_grant_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mfa_factor` ADD CONSTRAINT `mfa_factor_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mfa_proof` ADD CONSTRAINT `mfa_proof_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mfa_proof` ADD CONSTRAINT `mfa_proof_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mfa_recovery_code` ADD CONSTRAINT `mfa_recovery_code_factor_id_mfa_factor_id_fk` FOREIGN KEY (`factor_id`) REFERENCES `mfa_factor`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mfa_recovery_code` ADD CONSTRAINT `mfa_recovery_code_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_mfa_factor_user` ON `mfa_factor` (`user_id`);