# vTBD (sau v2.13.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.13.0` (2026-11-20, `main` f675acc). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi cho người dùng (các việc dưới đây chỉ thuộc Signal research, trang của team).

Not financial advice. Past results are not a forecast.

## Kỹ thuật

**Signal research (chỉ team, paper trading, không bao giờ gửi lệnh tới SoDEX)**
- Live drop chỉ thả tín hiệu (#371): chỉ bài qua Score mới rơi xuống phễu và chạy các bước; bài bị loại ở Collect / Normalize / Score chỉ có badge NEW và cộng vào số đếm. Mỗi đợt có một dòng "{n} new articles · {s} signals · {d} dropped"; hàng đợi chạy lần lượt từng tín hiệu, bước ngắn hơn.
- Danh sách research wallets (#372, DEC-347): khối "Research wallets (top {K})" trong Bots & labels (hạng, địa chỉ, lần đọc gần nhất, set version ở tiêu đề); thẻ H1 của trace hiện link tới ví cùng chiều / ngược chiều (tối đa 3, "+N more"). Người xem không có AI Desk thì không có link (ẩn cột Trader page) và có dòng "Turn on AI Desk to open trader pages"; không bao giờ dẫn tới trang 403. Endpoint chỉ đọc `GET /admin/signal-research/research-wallets`, không gọi Hyperliquid.

**Migration (chạy khi deploy)**
- `0053_sr_context_wallet_addresses` (#372): thêm cột nullable `signal_contexts.h1_agreeing_addresses`, `h1_opposing_addresses` (`text[]`). Tương thích ngược: snapshot cũ để null và web hiện số lượng như trước.

**Biến môi trường mới:** chưa có.
