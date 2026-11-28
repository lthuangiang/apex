# vTBD (sau v2.22.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.22.0` (2026-11-27). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- **US Market + SoDEX Wealth, phần api (#589, chưa merge):** client chỉ đọc SoDEX Wealth (allowlist GET, chung bucket IP, ưu tiên thấp), zod cho Wealth API, quy tắc độ sâu sổ lệnh ở `packages/shared` (`Thin` < 10.000 USD, `Very thin` < 1.000 USD theo phía mỏng hơn), `GET /api/v1/markets/us`, `GET /api/v1/wealth/me`, `features.usMarket` (DEC-402).
- **US Market, phần web (#591, chưa merge):** trang `/markets/us` (khối Anthropic `ANT-USD` / `vANT_vUSDC` với giá, khối lượng hoặc "Last trade", trạng thái sổ, độ sâu 10 mức, nhãn `Thin` / `Very thin`, vị thế lớn nhất cho bot mới, chip chiến lược; dải "Your SoDEX Wealth"; khối SoDEX Wealth funds; khối US fund tokens "Watching"), banner ở Strategy Lab, nhãn "Trades …" và "on sells" trên thẻ catalog, bảng độ sâu + dòng "Largest position" trong form tạo bot cho market trong `features.depthCapMarkets`, câu lỗi `order_book_depth` của server. Ẩn hết khi `features.usMarket` tắt (DEC-402).

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** `US_MARKET_ENABLED` (api, mặc định `true`), `WEALTH_READ_MAX_WEIGHT_PER_MIN` (api, mặc định `400`, tuỳ chọn); xem `docs/DEPLOY.md` mục 2.24.
