# vTBD (sau v2.18.6)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.6` (2026-11-25). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- marketdata: theo dõi ví leader (Copy Trading SoDEX, Hyperliquid Following / H1 / copy) bật ngay khi lên leader, backfill nến chạy nền và huỷ được; sửa sự cố vòng poll ví đứng từ 24/11 09:02 UTC (#531, DEC-TBD-marketdata-start-order; **chưa merge**). Sau deploy, bot copy có leader đã đóng / giảm vị thế trong lúc mất sẽ đóng / giảm ngay ("Catch up").

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
