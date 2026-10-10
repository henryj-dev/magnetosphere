CREATE TABLE `usage_daily` (
	`key_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	`day` varchar(10) NOT NULL,
	`cost_usd` decimal(12,6) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `usage_daily_key_id_day_pk` PRIMARY KEY(`key_id`,`day`)
);
--> statement-breakpoint
ALTER TABLE `api_keys` ADD `budget_at` datetime(3);