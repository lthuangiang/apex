# vTBD (sau v2.18.4)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.4` (2026-11-24). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Market Making: mọi bot báo giá theo sổ WS của SoDEX (như Volume Builder), tuổi sổ là tuổi thật, sổ cũ quá 1,5 s thì không đặt lệnh mở mới, lệnh đóng reduce-only vẫn đặt; giảm lệnh bị từ chối PostOnly (#517 PR A, DEC-389; **chưa merge**).

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
