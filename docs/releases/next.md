# vTBD (sau v2.19.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.19.0` (2026-11-26). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- SoDEX rewards: trang `/rewards` và tab SoPoints (#548 qua #554, DEC-397): mục Rewards ở vị trí 2 có chip New (Portfolio xuống ngay trên Settings; mobile: Rewards đầu More, thanh dưới giữ nguyên), khối mời ký + bảng "This sign-in", dữ liệu công khai (tuần, cặp có hệ số nhân, live feed), tab SoPoints (tổng điểm, tier, hạng, weekly pool, weekly performance) và các trạng thái hết hạn / tải / rỗng / lỗi mạng / 429 / lỗi nghiệp vụ / sai ví; hook dữ liệu dùng chung `features/rewards/queries.ts`. Tab Blind Boxes ẩn tới #550. Vẫn sau `REWARDS_ENABLED` (mặc định **tắt**): tắt thì sidebar, Overview và route như cũ. Không migration, không biến môi trường mới.
- SoDEX rewards: thẻ SoDEX rewards trên Overview thay thẻ Trading Agent khi công tắc bật (#549, **chưa merge**, DEC-397 phương án B): chưa ký (tuần, LIVE, pool, Next distribution, cặp hệ số cao nhất + "+N more", Sign with wallet), đã ký (điểm · tier · rank, số box chờ claim, box trong backpack, tuần này, Next distribution, Open Rewards), dòng job từ `jobs?active=true` (chỉ đọc; View → `/rewards?tab=boxes`), hết hạn / lỗi / 429 / tải. Nút Claim ẩn tới #551. Cùng PR: theo dữ liệu thật của Rewards API, tab SoPoints bỏ Base / Boost (SoDEX không trả), tier hiện nguyên tên (EPIC, DIAMOND…), `nextTierPoints` là ngưỡng tổng nên có thanh tiến độ và "{points} points to {tier}", nhãn LIVE ở bảng tuần theo `isLive`; schema zod `sopoints/summary`, `week/list` thêm trường thật. Công tắc tắt: Overview như cũ. Không migration, không biến môi trường mới.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
