ALTER TABLE "invites" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "used_by" varchar(36);--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_invites_expires" ON "invites" USING btree ("expires_at");