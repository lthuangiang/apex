# vTBD (sau v2.18.3)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.3` (2026-11-24). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Cảnh báo team `sodex_ws_lag` (#518, DEC-386; **chưa merge**): scheduler báo "SoDEX order updates delayed" khi trong 5 phút có ≥ 2 tin `accountOrderUpdate` của SoDEX với E − T > 5 s (đọc `sodex_calls`, chỉ chạy khi recorder ghi dòng WS `ok`). Không đổi hành vi bot, không thêm request SoDEX.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
