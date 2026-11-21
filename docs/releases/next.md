# vTBD (sau v2.14.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.14.0` (2026-11-20, `main` 0596de0). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

**Signal research (chỉ team, paper trading, không bao giờ gửi lệnh tới SoDEX)**
- Chu kỳ tin chỉnh bằng env (#394, DEC-352, **chưa merge**):
  - `SIGNAL_NEWS_CYCLE_MINUTES` (1–5, mặc định 5) cho scheduler; đặt 1 thì cả vòng Collect → Decide chạy mỗi phút. Giá trị sai → 5 kèm cảnh báo.
  - Tôn trọng 20 request / phút của SoSoValue: scheduler tự chặn (đếm cả trang sau); HTTP 429 / `code` 42901 → dừng chu kỳ, nguồn `rate_limited` ("Delayed"), không lưu bài của chu kỳ đó, con trỏ không tiến, chu kỳ sau thử lại.
  - Trần gọi Claude chia theo chu kỳ (50 mỗi 5 phút → 10 mỗi chu kỳ 1 phút), ngưỡng Live của nguồn SoSoValue = chu kỳ + 2 phút.
  - API `summary` có `cycleMinutes` (bỏ `funnel.pollSecs`), đọc từ Redis `sr:lane` do scheduler ghi; `funnel.soso.limit` là trần tháng scheduler đang dùng. Web (drawer Overview, ô "Where the time goes") lấy số phút từ API, plural ICU ("Every minute"), thiếu thì "Not available".

**Migration (chạy khi deploy):** chưa có.

**Biến môi trường mới:**
- `SIGNAL_NEWS_CYCLE_MINUTES` (scheduler, mặc định `5`; #394). Thêm vào khối `environment` của `scheduler` trong `/opt/drift/docker-compose.yml`: `SIGNAL_NEWS_CYCLE_MINUTES: ${SIGNAL_NEWS_CYCLE_MINUTES:-5}`. Chạy 1 phút cần `SIGNAL_SOSO_MONTHLY_LIMIT` khoảng `60000`; chỉ nâng khi người dùng đã xác nhận quota thật của key (`docs/DEPLOY.md` mục 2.16).
