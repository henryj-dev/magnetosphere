ALTER TABLE `session` ADD `credential_fingerprint` text;--> statement-breakpoint
ALTER TABLE `user` ADD `signup_origin` text DEFAULT 'legacy' NOT NULL;