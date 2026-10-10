ALTER TABLE "job_leases" ADD COLUMN "fence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "omniroute_jobs" ADD COLUMN "failed_at" timestamp;