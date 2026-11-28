-- #594 (DEC-404): bảng wealth_watch cho cảnh báo SoDEX Wealth. Chỉ thêm bảng mới; bản api / scheduler trước PR này
-- không đọc bảng này, nên migrate trước hoặc rollback không cần làm gì. Không cột nào chứa vị thế, số tiền hay địa chỉ:
-- fund_marks / exec_marks chỉ giữ khoá đã băm và trạng thái SoDEX đã thấy.
CREATE TABLE "wealth_watch" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"baseline_pending" boolean DEFAULT true NOT NULL,
	"fund_marks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"exec_marks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"has_plans" boolean DEFAULT false NOT NULL,
	"plans_checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wealth_watch" ADD CONSTRAINT "wealth_watch_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wealth_watch" ADD CONSTRAINT "wealth_watch_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wealth_watch_next_check_idx" ON "wealth_watch" USING btree ("next_check_at");