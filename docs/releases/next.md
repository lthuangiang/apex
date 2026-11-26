# vTBD (sau v2.20.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.20.0` (2026-11-26). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

- SoDEX rewards alerts (still being tested by the team): a weekly SoDEX summary after each snapshot (volume, open interest, account value, boosted pairs and when points arrive) and your weekly SoPoints once SoDEX confirms them (points, rank, total, tier and what is left to the next tier), on Telegram and in the bell.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- SoDEX rewards: tin tuần trên Telegram và chuông (#567, **chưa merge**; Refs #546, DEC-398): hai loại thông báo mới trong nhóm `rewards` cho user đang bật báo box mới. (1) `rewards_week_snapshot`: tuần vừa kết thúc ở `status` COMPLETED (đọc lại 10 phút, quá 24 giờ sau `weekEndTime` thì bỏ) → khoảng ngày, Perps / Spot volume, Open interest, Account value, Vault, Wealth TVL, cặp có hệ số nhân cao nhất + "and N more", giờ chia điểm. (2) `rewards_week_points`: từ 30 phút trước `distributionTime`, mỗi 10 phút tới khi `pointsStatus` CONFIRMED (quá 6 giờ thì bỏ, không gửi tin trống) → điểm tuần, rank / tổng người / percentile, tổng điểm, tier, tier kế + số còn thiếu (đọc thêm `sopoints/summary`). Lịch bám mốc SoDEX trả trong `sopoints/week/list` (client chỉ đọc, allowlist GET), không hard-code giờ; mỗi tuần một tin mỗi loại cho mỗi user (mốc ở DB + `dedupeKey` `rw:snapshot:<weekNo>` / `rw:points:<weekNo>`); dùng chung ngân sách weight / 401 (tạm dừng) / 429 của #558. Quy tắc 8: thiếu trường thì bỏ dòng, 0 thật hiện "$0.00", thứ hạng 0 coi như thiếu; không trường squad, không địa chỉ ví; giờ theo múi giờ hồ sơ người nhận. Email (mặc định tắt) chỉ có câu ngắn. Vẫn sau `REWARDS_WATCH_ENABLED` (mặc định **tắt**).

**Migration (chạy khi deploy):** `0065_rewards_watch_weekly` (#567): chỉ thêm ba cột nullable vào `rewards_watch`; rollback không cần làm gì (`docs/DEPLOY.md` 2.23).

**Biến môi trường mới:** không có.
