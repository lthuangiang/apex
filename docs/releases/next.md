# vTBD (sau v2.16.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.16.0` (2026-11-22). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

Chưa có thay đổi.
- Bot `news_signal` mainnet chọn đòn bẩy 1 / 5 / 10 / 20× isolated (trần 200 USDC giá trị vị thế giữ nguyên); engine đặt đúng mức, bỏ tín hiệu `LEVERAGE_NOT_SET` khi market không cho mức đó hoặc SoDEX từ chối, và `SL_BEYOND_LIQUIDATION` khi SL nằm quá gần giá thanh lý ước tính (< 1.5 ×); start check margin = size × Max open trades ÷ đòn bẩy (#458, DEC-373). Phần web ở PR riêng. **Chưa merge.**

**Migration (chạy khi deploy):** `0060_news_trade_leverage` (cột `news_signal_trades.leverage`, chỉ thêm, #458).

**Biến môi trường mới:** không có.
