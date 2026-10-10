ALTER TABLE "job_leases" ADD COLUMN "fence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_leases" ADD COLUMN "last_slot" bigint;--> statement-breakpoint
ALTER TABLE "omniroute_jobs" ADD COLUMN "failed_at" timestamp;--> statement-breakpoint
ALTER TABLE "omniroute_jobs" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "omniroute_jobs" ADD COLUMN "interrupts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "omniroute_jobs" ADD COLUMN "key_id" varchar(36);--> statement-breakpoint
CREATE INDEX "idx_omniroute_jobs_key" ON "omniroute_jobs" USING btree ("key_id","done_at");