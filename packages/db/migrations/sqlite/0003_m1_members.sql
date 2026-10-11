ALTER TABLE `invites` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `invites` ADD `used_by` text;--> statement-breakpoint
CREATE INDEX `idx_invites_expires` ON `invites` (`expires_at`);--> statement-breakpoint
ALTER TABLE `user` ADD `deleted_at` integer;