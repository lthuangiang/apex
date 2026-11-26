-- #558 PR1 (DEC-398): bảng rewards_watch cho báo box mới của SoDEX rewards. Chỉ thêm bảng mới; bản api / scheduler
-- trước PR này không đọc bảng này, nên migrate trước hoặc rollback không cần làm gì. token_ciphertext là JWT đã mã hoá
-- bằng Vault transit (chỉ signer giải mã); không cột nào chứa token rõ.
CREATE TABLE "rewards_watch" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"pause_reason" text,
	"token_ciphertext" text,
	"kms_key_ref" text,
	"token_exp" timestamp with time zone NOT NULL,
	"token_iat" timestamp with time zone,
	"token_aud" jsonb,
	"token_iss" text,
	"jti8" text,
	"ledger_mark_ts_ms" bigint,
	"ledger_mark_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"granted_mark" integer,
	"draw_rounds_seen" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"baseline_pending" boolean DEFAULT true NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_watch_active_has_token" CHECK ("rewards_watch"."status" <> 'active' or ("rewards_watch"."token_ciphertext" is not null and "rewards_watch"."pause_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "rewards_watch" ADD CONSTRAINT "rewards_watch_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards_watch" ADD CONSTRAINT "rewards_watch_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rewards_watch_status_next_check_idx" ON "rewards_watch" USING btree ("status","next_check_at");