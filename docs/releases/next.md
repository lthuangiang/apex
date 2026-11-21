# vTBD (sau v2.15.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.15.0` (2026-11-21). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Signal research: đổi version Rules / reader không còn ẩn dữ liệu cũ. Feed và phễu theo khoảng Last 24 h / 7 days / 30 days gồm mọi version (chip "Rules vN", dòng ngăn cách, câu tóm tắt), trace bài cũ đọc theo luật của bài (banner, "counted under vN"), Paper trades có Current rules / All rules; Is it working? giữ nguyên (#413, DEC-TBD-sr-history-across-versions). **Chưa merge.**
- Signal research: random baseline phát lại nến từ phút sau lúc vào lệnh thật (`opened_clock_at`), không từ đầu chu kỳ; lệnh cũ không có cột này giữ `opened_at`, baseline đã lưu không tính lại (#405, DEC-354). **Chưa merge.**

**Migration (chạy khi deploy):** `0057_sr_articles_collected_idx` (index `signal_articles(collected_at)`, #413).

**Biến môi trường mới:** chưa có.
