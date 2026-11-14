CREATE TABLE "mid_1s" (
	"market" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"mid" numeric(38, 18) NOT NULL,
	CONSTRAINT "mid_1s_market_ts_pk" PRIMARY KEY("market","ts")
);
--> statement-breakpoint
CREATE TABLE "mm_market_hourly" (
	"market" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"notional" numeric(38, 18) NOT NULL,
	"markout_notional" numeric(38, 18) NOT NULL,
	"trades" integer NOT NULL,
	"spread_ticks" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mm_market_hourly_market_hour_pk" PRIMARY KEY("market","hour")
);
