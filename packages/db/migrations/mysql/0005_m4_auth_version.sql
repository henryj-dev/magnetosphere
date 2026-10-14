ALTER TABLE `session` ADD `auth_version` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `auth_version` int DEFAULT 0 NOT NULL;