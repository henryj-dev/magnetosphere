ALTER TABLE `job_leases` ADD `fence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `omniroute_jobs` ADD `failed_at` integer;