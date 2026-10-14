ALTER TABLE "session" ADD COLUMN "auth_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "auth_version" integer DEFAULT 0 NOT NULL;