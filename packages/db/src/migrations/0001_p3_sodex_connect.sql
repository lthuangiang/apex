CREATE TABLE "sodex_signature_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"action" text NOT NULL,
	"api_key_id" uuid,
	"message" jsonb NOT NULL,
	"status" text NOT NULL,
	"sodex_error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "builder_approvals" ALTER COLUMN "max_fee_rate_spot" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "builder_approvals" ALTER COLUMN "max_fee_rate_perps" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sodex_signature_requests" ADD CONSTRAINT "sodex_signature_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sodex_signature_requests" ADD CONSTRAINT "sodex_signature_requests_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sodex_signature_requests" ADD CONSTRAINT "sodex_signature_requests_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sodex_signature_requests_user_id_idx" ON "sodex_signature_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "sodex_signature_requests_account_idx" ON "sodex_signature_requests" USING btree ("sodex_account_id");--> statement-breakpoint
CREATE INDEX "sodex_signature_requests_api_key_idx" ON "sodex_signature_requests" USING btree ("api_key_id");