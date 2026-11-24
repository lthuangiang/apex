# vTBD (sau v2.18.3)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.3` (2026-11-24). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Overview cache Realized PnL (60 s, "All" 5 phút, theo account) và sparkline watchlist (5 phút, theo market) để giảm weight REST của SoDEX trên IP egress (#494 PR1, DEC-387; **chưa merge**).

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
