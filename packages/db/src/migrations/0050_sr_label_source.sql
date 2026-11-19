-- Signal research: nguồn nhãn phân loại (#348, DEC-340, bổ sung DEC-333). Cổng precision chỉ tính nhãn
-- `random` (gắn từ luồng labels/next với token server cấp); nhãn gắn từ trace bị lệch (người gắn tự chọn bài, đã thấy kết
-- quả lệnh) nên là `trace`. Nhãn đã có trước migration này nhận `trace` qua DEFAULT: không chứng minh được bài nào được
-- chọn ngẫu nhiên. signal_label_tokens: token dùng một lần của labels/next, chỉ lưu sha256.
CREATE TABLE "signal_label_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"article_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_classification_labels" ADD COLUMN "source" text DEFAULT 'trace' NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_label_tokens" ADD CONSTRAINT "signal_label_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_label_tokens_hash_uq" ON "signal_label_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "signal_label_tokens_expires_idx" ON "signal_label_tokens" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "signal_classification_labels" ADD CONSTRAINT "signal_classification_labels_source_ck" CHECK ("signal_classification_labels"."source" in ('random', 'trace'));