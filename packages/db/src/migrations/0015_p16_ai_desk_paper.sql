CREATE TABLE "paper_accounts" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"capital" numeric(38, 18) NOT NULL,
	"cash" numeric(38, 18) NOT NULL,
	"positions" jsonb NOT NULL,
	"fees" numeric(38, 18) DEFAULT '0' NOT NULL,
	"funding" numeric(38, 18) DEFAULT '0' NOT NULL,
	"fills" integer DEFAULT 0 NOT NULL,
	"peak_equity" numeric(38, 18) NOT NULL,
	"max_drawdown" numeric(38, 18) DEFAULT '0' NOT NULL,
	"start_price" numeric(38, 18),
	"started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_fills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"size" numeric(38, 18) NOT NULL,
	"fee" numeric(38, 18) NOT NULL,
	"is_maker" boolean NOT NULL,
	"filled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_snapshots" (
	"bot_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"equity" numeric(38, 18) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD COLUMN "not_suggested" jsonb;--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD COLUMN "max_drop" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "mode" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ai_desk" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_snapshots" ADD CONSTRAINT "paper_snapshots_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_fills_bot_idx" ON "paper_fills" USING btree ("bot_id","filled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_snapshots_key" ON "paper_snapshots" USING btree ("bot_id","at");