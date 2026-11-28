# vTBD (sau v2.22.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.22.0` (2026-11-27). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

- Thin order books: on markets where the top 10 price levels on one side add up to less than 10,000 USD, an order that fills at once to open or add is cut to 25% of the side it takes (Decisions shows "Order reduced" with the old and new size), or waits when that side is empty. Closing orders, stop loss, take profit and Stop are never cut or held. New bots, and edits that raise a bot's size, can't be larger than the thinner side of the book. (**chưa merge**, #590)

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- **Đường tiền thật.** Giới hạn theo sổ lệnh (DEC-402 mục 5, **chưa merge**, #590; Refs #588), chỉ market `Thin` / `Very thin` (notional 10 mức một phía < 10.000 USD), không theo công tắc nào, bot paper không áp:
  - engine: lệnh khớp ngay để vào / tăng vị thế bị cắt về 25% notional 10 mức phía nó ăn hoặc chờ (sổ rỗng, trần dưới min size); lệnh đóng / reduce-only / SL / TP / Stop và lệnh maker không đổi. Bước có lệnh vào đọc sổ 10 mức (`/markets/{symbol}/orderbook?limit=10`, weight marketInfo) qua bucket IP chung, cache 3 s theo market, dùng lại lần đọc của Volume Farm / Rebalancing / news nếu còn mới; chỉ bước có lệnh vào khớp ngay mới đọc;
  - api: tạo bot, sửa bot làm tăng vốn và bản nháp MCP bị từ chối khi tổng vị thế tối đa lớn hơn phía mỏng hơn (hoặc sổ rỗng một phía); đọc sổ lỗi thì trả `SODEX_UNAVAILABLE`. Cache 30 s theo market.
  - Bot đang chạy không bị dừng; sửa không tăng vốn không bị chặn.
  - **Khi deploy:** không migration, không biến môi trường mới, không đổi compose. Sau deploy xem log engine có `entry held: order book depth unknown` (đọc sổ lỗi) và Decisions "Order reduced" / "Waiting: order book …" của bot trên market mỏng; market lớn (BTC, ETH…) không được có dòng nào trong số này.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
