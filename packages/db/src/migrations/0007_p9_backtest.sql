CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"market" text NOT NULL,
	"params_hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"period_days" integer NOT NULL,
	"data_version" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backtest_runs_cache_idx" ON "backtest_runs" USING btree ("strategy","market","params_hash","period_days","data_version");--> statement-breakpoint
CREATE INDEX "backtest_runs_user_idx" ON "backtest_runs" USING btree ("user_id","created_at");