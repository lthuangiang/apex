# vTBD (sau v2.21.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.21.0` (2026-11-27). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- SoDEX rewards: chẩn đoán lỗi bật "New box alerts" (#582, **chưa merge**, Refs #558): `REWARDS_WATCH_UNAVAILABLE` kèm `details.cause`: với signer là `http_<status>` / `timeout` / `network` / `bad_response`, với gateway là mã con của client chỉ đọc (`http_status` + `status`, `schema`, `business` + `businessCode`…). api ghi một dòng warn `rewards watch: enable failed` cho mọi lần bật hỏng (kể cả 4xx), không token, không địa chỉ ví. Banner "Couldn’t turn on alerts." hiện "Reference: {8 ký tự đầu traceId}" (khớp `reqId` trong log api; câu mới chờ PM duyệt). Signer log warn khi thiếu khoá transit rewards. Cách đọc mã và sửa: `docs/DEPLOY.md` 2.23. Không migration, không biến môi trường mới.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
