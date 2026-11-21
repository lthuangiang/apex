# vTBD (sau v2.15.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.15.0` (2026-11-21). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Signal research: đổi version Rules / reader không còn ẩn dữ liệu cũ. Feed và phễu theo khoảng Last 24 h / 7 days / 30 days gồm mọi version (chip "Rules vN", dòng ngăn cách, câu tóm tắt), trace bài cũ đọc theo luật của bài (banner, "counted under vN"), Paper trades có Current rules / All rules; Is it working? giữ nguyên (#413, DEC-357). **Chưa merge.**
- Idempotency-Key: jobs đánh dấu dòng đang chạy quá `IDEMPOTENCY_ABANDONED_AFTER_MIN` phút (mặc định 10) là `failed_unknown` / `ABANDONED`; request lặp lại nhận 409 `unknown`, không chạy lại, không xoá key (#319, DEC-356). **Chưa merge.**
- Backtest / Review this run / What-if: kết quả đổi khi stop của sàn và lệnh thoát khớp cùng nến (#412), lệnh reduce-only không còn đảo chiều vị thế.
- CI: test của package phụ thuộc chạy lại khi dependency đổi (bỏ `turbo run test --only`; ví dụ đổi `@drift/strategies` thì chạy lại test engine / backtest), PR chỉ đổi docs vẫn dùng cache (#414, DEC-358).
- Signal research: Claude reader v5 (`news-classifier-v5`): chỉ thêm 2 ví dụ ngược trong prompt (cổ phiếu lên sàn không phải `listing`, quỹ mua cổ phiếu Strategy không phải `treasury_buy`), Rules giữ `news-v4`; nhãn và lệnh của reader mới đếm lại từ 0 (#399, DEC-TBD-sr-reader-v5). **Chưa merge.**
- Signal research: random baseline phát lại nến từ phút sau lúc vào lệnh thật (`opened_clock_at`), không từ đầu chu kỳ; lệnh cũ không có cột này giữ `opened_at`, baseline đã lưu không tính lại (#405, DEC-354). **Chưa merge.**

**Migration (chạy khi deploy):** `0057_sr_articles_collected_idx` (index `signal_articles(collected_at)`, #413).

**Biến môi trường mới:** `IDEMPOTENCY_ABANDONED_AFTER_MIN` (jobs, tuỳ chọn, mặc định 10; DEPLOY mục 2.17).
