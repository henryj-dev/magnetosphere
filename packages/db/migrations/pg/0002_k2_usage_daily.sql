CREATE TABLE "usage_daily" (
	"key_id" varchar(255) NOT NULL,
	"day" varchar(10) NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "usage_daily_key_id_day_pk" PRIMARY KEY("key_id","day")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "budget_at" timestamp;