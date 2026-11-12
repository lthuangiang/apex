CREATE TABLE "desk_ai_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"local_date" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_ai_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"local_date" text NOT NULL,
	"question" text,
	"answer" jsonb NOT NULL,
	"source" text NOT NULL,
	"fallback" text,
	"model" text,
	"prompt_version" text NOT NULL,
	"fact_ids" text[] NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(18, 8),
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_ai_usage" (
	"user_id" uuid NOT NULL,
	"local_date" text NOT NULL,
	"questions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desk_ai_usage_user_id_local_date_pk" PRIMARY KEY("user_id","local_date")
);
--> statement-breakpoint
ALTER TABLE "desk_ai_conversations" ADD CONSTRAINT "desk_ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_ai_turns" ADD CONSTRAINT "desk_ai_turns_conversation_id_desk_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."desk_ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_ai_turns" ADD CONSTRAINT "desk_ai_turns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_ai_usage" ADD CONSTRAINT "desk_ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desk_ai_conversations_user_idx" ON "desk_ai_conversations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_ai_conversations_brief" ON "desk_ai_conversations" USING btree ("user_id","local_date") WHERE kind = 'brief';--> statement-breakpoint
CREATE INDEX "desk_ai_turns_conversation_idx" ON "desk_ai_turns" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "desk_ai_turns_quota_idx" ON "desk_ai_turns" USING btree ("user_id","local_date");