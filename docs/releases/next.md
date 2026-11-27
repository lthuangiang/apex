# vTBD (sau v2.21.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.21.0` (2026-11-27). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- SoDEX rewards, báo box mới: `REWARDS_WATCH_INTERVAL_MIN` (scheduler) nhận **1–60** phút (trước 5–60), mặc định vẫn 15, mẫu compose không đổi (#585; Refs #558). Giá trị sai vẫn về 15 nhưng có một dòng log warn lúc khởi động (`REWARDS_WATCH_INTERVAL_MIN invalid ...`, kèm `received` / `using`). Mỗi lượt một user ≈ 6 weight (treasures 1 + ledger 5), trần riêng `REWARDS_WATCH_MAX_WEIGHT_PER_MIN` = 120 → số user đọc kịp ≈ 20 × số phút chu kỳ (2 phút ≈ 40 user); vượt thì chu kỳ thực tế dài ra, không lỗi (`docs/DEPLOY.md` 2.23). **Khi deploy:** muốn báo box mới mỗi 2 phút thì đặt `REWARDS_WATCH_INTERVAL_MIN=2` trong `/opt/drift/.env` rồi `docker compose up -d scheduler`.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
