-- Signal research: nhãn phân loại (#304, DEC-328 mục 2). Một nhãn mỗi người mỗi bài (unique article_id, labeled_by), sửa
-- được; Wrong bắt buộc lý do, Right không có lý do; ghi chú ≤ 500 ký tự. Precision theo classifier_version (prompt
-- version của bài lúc gắn nhãn). Không FK tới signal_articles (như các bảng signal khác).
CREATE TABLE "signal_classification_labels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_id" text NOT NULL,
	"classifier_version" text NOT NULL,
	"labeled_by" uuid NOT NULL,
	"verdict" text NOT NULL,
	"reason" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_classification_labels_verdict_ck" CHECK ("signal_classification_labels"."verdict" in ('right', 'wrong')),
	CONSTRAINT "signal_classification_labels_reason_ck" CHECK (("signal_classification_labels"."verdict" = 'wrong' and "signal_classification_labels"."reason" in ('person_not_company', 'wrong_type', 'wrong_asset', 'passing_mention', 'promotional', 'other')) or ("signal_classification_labels"."verdict" = 'right' and "signal_classification_labels"."reason" is null)),
	CONSTRAINT "signal_classification_labels_note_ck" CHECK ("signal_classification_labels"."note" is null or char_length("signal_classification_labels"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "signal_classification_labels" ADD CONSTRAINT "signal_classification_labels_labeled_by_users_id_fk" FOREIGN KEY ("labeled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_classification_labels_article_user_uq" ON "signal_classification_labels" USING btree ("article_id","labeled_by");--> statement-breakpoint
CREATE INDEX "signal_classification_labels_classifier_idx" ON "signal_classification_labels" USING btree ("classifier_version","article_id");