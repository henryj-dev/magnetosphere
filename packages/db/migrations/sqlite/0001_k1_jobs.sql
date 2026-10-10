ALTER TABLE `job_leases` ADD `fence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_leases` ADD `last_slot` integer;--> statement-breakpoint
ALTER TABLE `omniroute_jobs` ADD `failed_at` integer;--> statement-breakpoint
ALTER TABLE `omniroute_jobs` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `omniroute_jobs` ADD `interrupts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `omniroute_jobs` ADD `key_id` text;--> statement-breakpoint
CREATE INDEX `idx_omniroute_jobs_key` ON `omniroute_jobs` (`key_id`,`done_at`);