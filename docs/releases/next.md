# vTBD (sau v2.22.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.22.0` (2026-11-27). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

- Thin order books: on the Anthropic and fund token markets, when the top 10 price levels on one side add up to less than 10,000 USD, an order that fills at once to open or add is cut to 25% of the side it takes (Decisions shows "Order reduced" with the old and new size), or waits when that side is empty. Closing orders, stop loss, take profit and Stop are never cut or held. New bots, and edits that raise a bot's size, can't be larger than the thinner side of the book. (**chưa merge**, #590)

- Portfolio › My Wealth: a read-only view of what you hold on SoDEX Wealth (totals, funds you hold, activity), read from SoDEX for your wallet with no signature. DeskLabs never invests, redeems or moves funds; use SoDEX Wealth with your own wallet for that. (**chưa merge**, #592)

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- **US Market + SoDEX Wealth, phần api (#589, chưa merge):** client chỉ đọc SoDEX Wealth (allowlist GET, chung bucket IP, ưu tiên thấp), zod cho Wealth API, quy tắc độ sâu sổ lệnh ở `packages/shared` (`Thin` < 10.000 USD, `Very thin` < 1.000 USD theo phía mỏng hơn), `GET /api/v1/markets/us`, `GET /api/v1/wealth/me`, `features.usMarket` (DEC-402).
- **Portfolio › My Wealth (#592, chưa merge; Refs #588):** tab chỉ đọc trong Portfolio (ẩn khi `features.usMarket` false). api: cache `/wealth/me` 30 s → 90 s theo địa chỉ; mặc định chỉ 4 lời gọi Wealth (80 weight, giả định 20 / lời gọi chưa đo), `recurring-buys` / `pnl-history` chỉ khi `?include=`; hết ngân sách weight của chính DeskLabs → 429 `RATE_LIMITED` `details.reason = "sodex_wealth_budget"` + `retryAfterMs`, web hiện "SoDEX Wealth is busy". Không migration, không biến môi trường mới.
- **Đường tiền thật.** Giới hạn theo sổ lệnh (DEC-402 mục 5 và bổ sung 2026-11-28, **chưa merge**, #590; Refs #588). Chỉ áp cho market trong `DEPTH_CAP_MARKETS` (mặc định `ANT-USD`, `vANT_vUSDC` và 8 cặp token quỹ), và chỉ khi sổ của market đó đang `Thin` / `Very thin` / rỗng. Market ngoài danh sách không đổi gì: không đọc sổ, không cắt, không kiểm lúc tạo / sửa. Bot paper không áp:
  - engine: lệnh khớp ngay để vào / tăng vị thế bị cắt về 25% notional 10 mức phía nó ăn hoặc chờ (sổ rỗng, trần dưới min size); lệnh đóng / reduce-only / SL / TP / Stop và lệnh maker không đổi, lệnh đóng gửi nguyên khối lượng (không "đóng nhiều phần"). Chỉ bước có lệnh vào khớp ngay ở market trong danh sách mới đọc sổ 10 mức (weight marketInfo, bucket IP chung, cache 3 s, dùng lại lần đọc sẵn có);
  - api: tạo bot, sửa bot làm tăng vốn và bản nháp MCP ở market trong danh sách bị từ chối khi tổng vị thế tối đa lớn hơn phía mỏng hơn (hoặc sổ rỗng một phía); đọc sổ lỗi thì `SODEX_UNAVAILABLE`. Cache 30 s. `GET /api/v1/features` trả `depthCapMarkets` (danh sách đang hiệu lực) cho web;
  - bot đang chạy không bị dừng; sửa không tăng vốn không bị chặn.
  - **Khi deploy:** không migration. Biến mới `DEPTH_CAP_MARKETS` (engine + api, xem `docs/DEPLOY.md` mục 2.25); không đặt thì dùng danh sách mặc định, mẫu compose truyền `default`. Đặt cùng một giá trị cho engine và api. Sau deploy xem log engine `entry held: order book depth unknown` và Decisions "Order reduced" / "Waiting: order book …" của bot ANT / token quỹ; market khác không được có dòng nào trong số này.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** `US_MARKET_ENABLED` (api, mặc định `true`), `WEALTH_READ_MAX_WEIGHT_PER_MIN` (api, mặc định `400`, tuỳ chọn); xem `docs/DEPLOY.md` mục 2.24. `DEPTH_CAP_MARKETS` (engine + api, mặc định danh sách ANT + 8 cặp token quỹ; trống = tắt; `*` = mọi market); xem `docs/DEPLOY.md` mục 2.25.
