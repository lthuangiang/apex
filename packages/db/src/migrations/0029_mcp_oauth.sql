CREATE TABLE "mcp_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_id" uuid,
	"user_id" uuid,
	"client_id" text,
	"endpoint" text NOT NULL,
	"tool" text NOT NULL,
	"args_hash" text,
	"duration_ms" integer,
	"status" text NOT NULL,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"scope" text[] NOT NULL,
	"resource" text NOT NULL,
	"access_hash" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_hash" text NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"redirect_uris" text[] NOT NULL,
	"fetched_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text[] NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_calls_created_idx" ON "mcp_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mcp_calls_user_idx" ON "mcp_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tokens_access_hash_key" ON "mcp_tokens" USING btree ("access_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tokens_refresh_hash_key" ON "mcp_tokens" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "mcp_tokens_user_client_idx" ON "mcp_tokens" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "mcp_tokens_family_idx" ON "mcp_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "oauth_clients_last_used_idx" ON "oauth_clients" USING btree ("last_used_at");