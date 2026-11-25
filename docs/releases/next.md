# vTBD (sau v2.18.4)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.4` (2026-11-24). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Market Making giữ nguyên lệnh đóng rc khi giá đích không đổi (#517 PR B, DEC-390; **chưa merge**): không còn huỷ rồi đặt lại lệnh đóng reduce-only mỗi nhịp làm mới; giá đổi thì vẫn huỷ rồi mới đặt (DEC-257). Bộ chặn tự khớp và các chốt vị thế không đổi.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
