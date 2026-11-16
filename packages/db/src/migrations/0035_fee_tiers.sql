CREATE TABLE "user_fee_tiers" (
	"user_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"rate" integer NOT NULL,
	"volume" numeric(38, 18) NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_fee_tiers_user_id_strategy_pk" PRIMARY KEY("user_id","strategy"),
	CONSTRAINT "user_fee_tiers_rate_range" CHECK ("user_fee_tiers"."rate" >= 1 and "user_fee_tiers"."rate" <= 10)
);
--> statement-breakpoint
ALTER TABLE "user_fee_tiers" ADD CONSTRAINT "user_fee_tiers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;