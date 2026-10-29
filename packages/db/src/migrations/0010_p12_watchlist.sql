CREATE TABLE "watchlist_items" (
	"user_id" uuid NOT NULL,
	"market" text NOT NULL,
	"engine" text NOT NULL,
	"position" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_items_user_id_market_pk" PRIMARY KEY("user_id","market")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "watchlist_seeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;