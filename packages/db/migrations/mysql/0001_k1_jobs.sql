ALTER TABLE `job_leases` ADD `fence` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `omniroute_jobs` ADD `failed_at` datetime(3);