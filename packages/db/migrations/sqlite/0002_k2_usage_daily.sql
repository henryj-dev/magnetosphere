CREATE TABLE `usage_daily` (
	`key_id` text NOT NULL,
	`day` text NOT NULL,
	`cost_usd` real NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`key_id`, `day`)
);
--> statement-breakpoint
ALTER TABLE `api_keys` ADD `budget_at` integer;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `budget_month` text;