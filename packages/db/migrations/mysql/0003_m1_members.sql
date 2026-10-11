ALTER TABLE `invites` ADD `revoked_at` datetime(3);--> statement-breakpoint
ALTER TABLE `invites` ADD `used_by` varchar(36);--> statement-breakpoint
ALTER TABLE `user` ADD `deleted_at` datetime(3);--> statement-breakpoint
CREATE INDEX `idx_invites_expires` ON `invites` (`expires_at`);