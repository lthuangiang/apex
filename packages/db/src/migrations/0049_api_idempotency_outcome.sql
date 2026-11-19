-- Idempotency-Key (#316): handler lỗi khi có thể đã có tác dụng phụ thì giữ dòng với outcome = failed_unknown + mã lỗi,
-- không chạy lại. Chỉ thêm cột nullable: dòng cũ (null) đọc như trước.
ALTER TABLE "idempotency_keys" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "error_code" text;