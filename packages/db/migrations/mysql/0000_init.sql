CREATE TABLE `account` (
	`id` varchar(36) NOT NULL,
	`account_id` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`provider_id` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` datetime(3),
	`refresh_token_expires_at` datetime(3),
	`scope` text,
	`password` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `account_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`omniroute_key_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`key_preview` varchar(16) NOT NULL,
	`label` varchar(255),
	`state` varchar(16) NOT NULL,
	`disabled_reason` varchar(16),
	`sync_state` varchar(16) NOT NULL DEFAULT 'synced',
	`budget_usd` decimal(12,6),
	`created_at` datetime(3) NOT NULL,
	`deleted_at` datetime(3),
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_keys_omniroute_key_id_unique` UNIQUE(`omniroute_key_id`)
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`value` text NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`updated_by` varchar(36),
	CONSTRAINT `app_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` varchar(36) NOT NULL,
	`actor_id` varchar(36),
	`action` varchar(64) NOT NULL,
	`target` varchar(255),
	`detail` text,
	`ip` varchar(64),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` varchar(36) NOT NULL,
	`email` varchar(255),
	`token_hash` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`role` varchar(16) NOT NULL DEFAULT 'member',
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_by` varchar(36) NOT NULL,
	CONSTRAINT `invites_id` PRIMARY KEY(`id`),
	CONSTRAINT `invites_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `job_leases` (
	`name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`holder` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`locked_until` datetime(3) NOT NULL,
	CONSTRAINT `job_leases_name` PRIMARY KEY(`name`)
);
--> statement-breakpoint
CREATE TABLE `omniroute_jobs` (
	`id` varchar(36) NOT NULL,
	`action` varchar(64) NOT NULL,
	`payload` text NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` text,
	`next_run_at` datetime(3) NOT NULL,
	`done_at` datetime(3),
	CONSTRAINT `omniroute_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` varchar(36) NOT NULL,
	`key` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`count` int NOT NULL,
	`last_request` bigint NOT NULL,
	CONSTRAINT `rate_limit_id` PRIMARY KEY(`id`),
	CONSTRAINT `rate_limit_key_unique` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` varchar(36) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`token` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` varchar(36) NOT NULL,
	CONSTRAINT `session_id` PRIMARY KEY(`id`),
	CONSTRAINT `session_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `sso_provider` (
	`id` varchar(36) NOT NULL,
	`issuer` text NOT NULL,
	`oidc_config` text,
	`saml_config` text,
	`user_id` varchar(36),
	`provider_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`organization_id` text,
	`domain` text NOT NULL,
	CONSTRAINT `sso_provider_id` PRIMARY KEY(`id`),
	CONSTRAINT `sso_provider_provider_id_unique` UNIQUE(`provider_id`)
);
--> statement-breakpoint
CREATE TABLE `sso_provider_settings` (
	`provider_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`display_name` varchar(255) NOT NULL,
	`show_button` boolean NOT NULL DEFAULT true,
	`enabled` boolean NOT NULL DEFAULT true,
	`jit_enabled` boolean NOT NULL DEFAULT true,
	`default_role` varchar(16) NOT NULL DEFAULT 'member',
	`default_limit_usd` decimal(12,6),
	`default_max_keys` int,
	`group_claim` varchar(255),
	`admin_groups` text,
	CONSTRAINT `sso_provider_settings_provider_id` PRIMARY KEY(`provider_id`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` varchar(36) NOT NULL,
	`name` text NOT NULL,
	`email` varchar(255) NOT NULL,
	`email_verified` boolean NOT NULL DEFAULT false,
	`image` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`role` varchar(16) NOT NULL DEFAULT 'member',
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`monthly_limit_usd` decimal(12,6),
	`max_keys` int,
	`is_bootstrap_admin` boolean NOT NULL DEFAULT false,
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` varchar(36) NOT NULL,
	`identifier` varchar(768) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`value` text NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `verification_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `account` ADD CONSTRAINT `account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `session` ADD CONSTRAINT `session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sso_provider` ADD CONSTRAINT `sso_provider_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_user` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_created` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_omniroute_jobs_due` ON `omniroute_jobs` (`done_at`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);