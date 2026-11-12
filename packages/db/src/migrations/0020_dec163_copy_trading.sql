CREATE TABLE "leader_alert_state" (
	"source" text NOT NULL,
	"address" text NOT NULL,
	"coin" text NOT NULL,
	"last_alert_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leader_alert_state_source_address_coin_pk" PRIMARY KEY("source","address","coin")
);
--> statement-breakpoint
CREATE TABLE "leader_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"address" text NOT NULL,
	"coin" text NOT NULL,
	"market" text,
	"kind" text NOT NULL,
	"position_before" numeric(38, 18) NOT NULL,
	"position_after" numeric(38, 18) NOT NULL,
	"notional" numeric(38, 18) NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"realized" numeric(38, 18),
	"at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"last_tid" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leader_follows" (
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leader_follows_user_id_source_address_pk" PRIMARY KEY("user_id","source","address")
);
--> statement-breakpoint
CREATE TABLE "leader_stats_daily" (
	"source" text NOT NULL,
	"address" text NOT NULL,
	"date" date NOT NULL,
	"stats" jsonb NOT NULL,
	"hidden" text[] NOT NULL,
	"tabs" text[] NOT NULL,
	"steady_score" double precision,
	"profit" numeric(38, 18) NOT NULL,
	"typical_hold_ms" bigint,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leader_stats_daily_source_address_date_pk" PRIMARY KEY("source","address","date")
);
--> statement-breakpoint
CREATE TABLE "leader_wallets" (
	"source" text NOT NULL,
	"address" text NOT NULL,
	"display_name" text,
	"is_vault" boolean,
	"account_value" numeric(38, 18),
	"leaderboard_pnl_30d" numeric(38, 18),
	"last_on_leaderboard_at" timestamp with time zone,
	"fill_cursor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leader_wallets_source_address_pk" PRIMARY KEY("source","address")
);
--> statement-breakpoint
CREATE TABLE "leaderboard_runs" (
	"date" date PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"candidates" integer,
	"computed" integer,
	"error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leader_follows" ADD CONSTRAINT "leader_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leader_events_addr_at_idx" ON "leader_events" USING btree ("source","address","at");--> statement-breakpoint
CREATE UNIQUE INDEX "leader_events_dedupe" ON "leader_events" USING btree ("source","address","last_tid");--> statement-breakpoint
CREATE INDEX "leader_follows_wallet_idx" ON "leader_follows" USING btree ("source","address");--> statement-breakpoint
CREATE INDEX "leader_stats_daily_date_idx" ON "leader_stats_daily" USING btree ("date");