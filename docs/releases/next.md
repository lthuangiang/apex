# vTBD (sau v2.14.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.14.0` (2026-11-20, `main` 0596de0). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

**Signal research (chỉ team, paper trading, không bao giờ gửi lệnh tới SoDEX)**
- Claude reader v4 + Rules v4 (#395, gộp #323, DEC-TBD-sr-reader-v4; mockup `docs/mockups/signal-research/reader-v4.html`; **chưa merge**).
  - Prompt `news-classifier-v4`: lỗ hổng được công bố / đã vá mà không mất tiền → none; tiền bị chuyển / rửa từ vụ hack cũ → none; khai thác thật trên chính chain (vd ETH bị mint) → hack_exploit coin đó; nhắc lại luật coin bị đánh cắp; thêm một ETF hoặc ETF ở sàn nhỏ cho coin đã có ETF → none.
  - Rules `news-v4`: luật mới `ETF_MAJOR_ASSET`, tin ETF (approved, delayed or rejected) trên BTC / ETH bị loại ở Score ("ETF on BTC or ETH"). Số nhãn, số lệnh và cổng đếm lại từ 0; lệnh v3 là lịch sử.
  - Bài v3 còn `collected` / `pending` lúc deploy được chuyển sang v4 ở chu kỳ đầu (cùng event của chúng), không bài nào bị bỏ rơi.
  - Web: hai hộp mới ở tab News types (nhãn "New in v4" ẩn sau 14 ngày tính từ lúc v4 chạy), thẻ "Claude reader v3 · Retired {date}" ở Is it working?, lý do loại mới trong phễu và trace.
  - Is it working? ngay sau khi đổi: "0 / 100 · new rules and reader, count starts again" và pill "Collecting".
  - API `/classifiers` thêm `closedTrades`. Script đánh giá prompt `signals:eval-classifier` (không chạy trong CI).

**Migration (chạy khi deploy):** chưa có.

**Biến môi trường mới:** chưa có.
