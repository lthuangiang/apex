CREATE TABLE "builder_balance_snapshots" (
	"date" date NOT NULL,
	"engine" text NOT NULL,
	"balance" numeric(38, 18) NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	CONSTRAINT "builder_balance_snapshots_date_engine_pk" PRIMARY KEY("date","engine")
);
--> statement-breakpoint
CREATE TABLE "builder_revenue_daily" (
	"date" date NOT NULL,
	"engine" text NOT NULL,
	"from_fills" numeric(38, 18) NOT NULL,
	"fills" integer NOT NULL,
	"notional" numeric(38, 18) NOT NULL,
	"balance_delta" numeric(38, 18),
	"difference" numeric(38, 18),
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_revenue_daily_date_engine_pk" PRIMARY KEY("date","engine")
);
--> statement-breakpoint
CREATE TABLE "equity_snapshots" (
	"sodex_account_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"equity" numeric(38, 18) NOT NULL,
	CONSTRAINT "equity_snapshots_sodex_account_id_at_pk" PRIMARY KEY("sodex_account_id","at")
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_settings_user_id_type_channel_pk" PRIMARY KEY("user_id","type","channel")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"channel" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"data" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_limits" (
	"sodex_account_id" uuid PRIMARY KEY NOT NULL,
	"daily_loss_pct" numeric(10, 4),
	"max_drawdown_pct" numeric(10, 4),
	"per_trade_pct" numeric(10, 4),
	"max_leverage" numeric(10, 4),
	"max_positions" integer,
	"enforced" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "risk_alerts_account_idx" ON "risk_alerts" USING btree ("sodex_account_id","occurred_at");