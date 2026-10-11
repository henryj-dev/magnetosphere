ALTER TABLE "session" ADD COLUMN "credential_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "signup_origin" varchar(16) DEFAULT 'legacy' NOT NULL;