# vTBD (sau v2.15.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.15.0` (2026-11-21). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Signal Research ra menu chính (BETA) cho vài tài khoản test: cờ `users.signal_research` (mặc định tắt, team bật ở Admin › Users, có audit), route `/signal-research` dùng lại trang Signal research của team (người dùng test chỉ không thấy Claude cost), My versions (version riêng, tối đa 3 chạy mỗi chủ, chỉ chủ thấy, không tính vào cổng của team), người dùng test chấm nhãn được nhưng cổng chỉ tính nhãn team (#423, DEC-361).
- Signal research: đổi version Rules / reader không còn ẩn dữ liệu cũ. Feed và phễu theo khoảng Last 24 h / 7 days / 30 days gồm mọi version (chip "Rules vN", dòng ngăn cách, câu tóm tắt), trace bài cũ đọc theo luật của bài (banner, "counted under vN"), Paper trades có Current rules / All rules; Is it working? giữ nguyên (#413, DEC-357).
- Idempotency-Key: jobs đánh dấu dòng đang chạy quá `IDEMPOTENCY_ABANDONED_AFTER_MIN` phút (mặc định 10) là `failed_unknown` / `ABANDONED`; request lặp lại nhận 409 `unknown`, không chạy lại, không xoá key (#319, DEC-356).
- Backtest / Review this run / What-if: kết quả đổi khi stop của sàn và lệnh thoát khớp cùng nến (#412), lệnh reduce-only không còn đảo chiều vị thế.
- CI: test của package phụ thuộc chạy lại khi dependency đổi (bỏ `turbo run test --only`; ví dụ đổi `@drift/strategies` thì chạy lại test engine / backtest), PR chỉ đổi docs vẫn dùng cache (#414, DEC-358).
- Signal research: random baseline phát lại nến từ phút sau lúc vào lệnh thật (`opened_clock_at`), không từ đầu chu kỳ; lệnh cũ không có cột này giữ `opened_at`, baseline đã lưu không tính lại (#405, DEC-354).
- Retention 45 ngày của scheduler bỏ thêm `bot_events.payload.quote` (snapshot báo giá Market Making, DEC-312); dòng Decisions và phần còn lại của payload giữ nguyên. Lượt đầu tự tạo index `bot_events_quote_idx` bằng CONCURRENTLY, không cần bước tay (#259, DEC-363, DEPLOY 2.14).

**Migration (chạy khi deploy):** `0057_sr_articles_collected_idx` (index `signal_articles(collected_at)`, #413); `0058_sr_menu_beta` (`users.signal_research`, `signal_bot_versions.owner_user_id` + trigger trần 3 version theo chủ, `signal_classification_labels.labeler`; #423).

**Bật Signal Research cho tài khoản test (#423):** sau deploy, team vào Admin › Users, cột **Signal Research**, bấm **Turn on** ở dòng của tài khoản đó (ghi audit `admin.signal_research`). Người đó tải lại trang sẽ thấy mục Signal Research · BETA ngay sau AI Desk. Tắt bằng **Turn off**: mục biến mất, route trả Not found, API trả 403 ngay, version đang chạy của họ tự pause (audit `signal_research_disabled`). Bật lại không tự resume; người đó tự Resume từng version.

**Biến môi trường mới:** `IDEMPOTENCY_ABANDONED_AFTER_MIN` (jobs, tuỳ chọn, mặc định 10; DEPLOY mục 2.17).
