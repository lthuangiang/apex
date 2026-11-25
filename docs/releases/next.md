# vTBD (sau v2.18.5)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.5` (2026-11-25). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

- Trading Agent: the Open orders tile now shows the bot's Long or Short position with its unrealized PnL (before fees), and for Volume Builder the Last decision tile shows the hold time with a countdown (#527, **chưa merge**).

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- `GET /api/v1/bots/:id` thêm `positionShown`, `position`, `pendingOrder`, `hold` (#527; **chưa merge**): vị thế theo sổ của bot một sổ, lãi chưa chốt theo giá khớp gần nhất `md:last` (như Profit since start), thời gian giữ của Volume Builder. Không đổi engine, không thêm request SoDEX.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
