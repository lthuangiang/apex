-- #530 PR2 (DEC-393): một bài nêu nhiều coin có một snapshot ngữ cảnh cho MỖI coin. Thay chỉ mục duy
-- nhất theo bài bằng chỉ mục duy nhất (bài, market). Dữ liệu cũ một dòng mỗi bài vẫn hợp lệ; không đổi dòng nào.
DROP INDEX "signal_contexts_article_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "signal_contexts_article_market_uq" ON "signal_contexts" USING btree ("article_id","market");