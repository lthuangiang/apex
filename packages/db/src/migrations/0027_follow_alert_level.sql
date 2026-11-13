CREATE TABLE "leader_position_alert_state" (
	"source" text NOT NULL,
	"address" text NOT NULL,
	"coin" text NOT NULL,
	"last_alert_at" timestamp with time zone NOT NULL,
	CONSTRAINT "leader_position_alert_state_source_address_coin_pk" PRIMARY KEY("source","address","coin")
);
--> statement-breakpoint
ALTER TABLE "leader_follows" ADD COLUMN "alert_level" text DEFAULT 'big_moves' NOT NULL;