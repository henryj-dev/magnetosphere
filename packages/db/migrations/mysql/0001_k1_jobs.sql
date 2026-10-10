ALTER TABLE `job_leases` ADD `fence` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_leases` ADD `last_slot` bigint;--> statement-breakpoint
ALTER TABLE `omniroute_jobs` ADD `failed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `omniroute_jobs` ADD `generation` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `omniroute_jobs` ADD `interrupts` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `omniroute_jobs` ADD `key_id` varchar(36);--> statement-breakpoint
CREATE INDEX `idx_omniroute_jobs_key` ON `omniroute_jobs` (`key_id`,`done_at`);