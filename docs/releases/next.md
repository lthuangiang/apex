# vTBD (sau v2.19.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.19.0` (2026-11-26). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- SoDEX rewards: trang `/rewards` và tab SoPoints (#548, **chưa merge**, DEC-397): mục Rewards ở vị trí 2 có chip New (Portfolio xuống ngay trên Settings; mobile: Rewards đầu More, thanh dưới giữ nguyên), khối mời ký + bảng "This sign-in", dữ liệu công khai (tuần, cặp có hệ số nhân, live feed), tab SoPoints (tổng điểm, tier, hạng, weekly pool, weekly performance) và các trạng thái hết hạn / tải / rỗng / lỗi mạng / 429 / lỗi nghiệp vụ / sai ví; hook dữ liệu dùng chung `features/rewards/queries.ts`. Tab Blind Boxes ẩn tới #550. Vẫn sau `REWARDS_ENABLED` (mặc định **tắt**): tắt thì sidebar, Overview và route như cũ. Không migration, không biến môi trường mới.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
