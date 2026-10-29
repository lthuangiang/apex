CREATE TABLE "ai_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"context" text NOT NULL,
	"engine_id" text NOT NULL,
	"role" text NOT NULL,
	"strategy" text NOT NULL,
	"market" text NOT NULL,
	"capital" numeric(38, 18) NOT NULL,
	"values" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"basis" text NOT NULL,
	"inputs_version" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"goal" text NOT NULL,
	"capital" numeric(38, 18) NOT NULL,
	"max_drop" text NOT NULL,
	"markets" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_suggestions_user_idx" ON "ai_suggestions" USING btree ("user_id","computed_at");