CREATE TABLE "user_builder_fees" (
	"user_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"rate" integer NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_builder_fees_user_id_strategy_pk" PRIMARY KEY("user_id","strategy"),
	CONSTRAINT "user_builder_fees_rate_range" CHECK ("user_builder_fees"."rate" >= 0 and "user_builder_fees"."rate" <= 10)
);
--> statement-breakpoint
ALTER TABLE "user_builder_fees" ADD CONSTRAINT "user_builder_fees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_builder_fees" ADD CONSTRAINT "user_builder_fees_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;