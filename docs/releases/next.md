# vTBD (sau v2.21.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.21.0` (2026-11-27). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

- Rewards: your rewards sign-in now stays in this browser until it expires or you sign out, so new tabs no longer ask your wallet to sign again. Other open tabs follow sign-in and sign-out. You sign in once more after this update. (#584, **chưa merge**)

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- SoDEX rewards, báo box mới: `REWARDS_WATCH_INTERVAL_MIN` (scheduler) nhận **1–60** phút (trước 5–60), mặc định vẫn 15, mẫu compose không đổi (#585; Refs #558). Giá trị sai vẫn về 15 nhưng có một dòng log warn lúc khởi động (`REWARDS_WATCH_INTERVAL_MIN invalid ...`, kèm `received` / `using`). Mỗi lượt một user ≈ 6 weight (treasures 1 + ledger 5), trần riêng `REWARDS_WATCH_MAX_WEIGHT_PER_MIN` = 120 → số user đọc kịp ≈ 20 × số phút chu kỳ (2 phút ≈ 40 user); vượt thì chu kỳ thực tế dài ra, không lỗi (`docs/DEPLOY.md` 2.23). **Khi deploy:** muốn báo box mới mỗi 2 phút thì đặt `REWARDS_WATCH_INTERVAL_MIN=2` trong `/opt/drift/.env` rồi `docker compose up -d scheduler`.
- SoDEX rewards: chẩn đoán lỗi bật "New box alerts" (#582 qua #583, Refs #558): `REWARDS_WATCH_UNAVAILABLE` kèm `details.cause`: với signer là `http_<status>` / `timeout` / `network` / `bad_response`, với gateway là mã con của client chỉ đọc (`http_status` + `status`, `schema`, `business` + `businessCode`…). api ghi một dòng warn `rewards watch: enable failed` cho mọi lần bật hỏng (kể cả 4xx), không token, không địa chỉ ví. Banner "Couldn’t turn on alerts." hiện "Reference: {8 ký tự đầu traceId}" (khớp `reqId` trong log api; câu đã được PM duyệt). Signer log warn khi thiếu khoá transit rewards. Script deploy (`build-push.sh --deploy-only`) từ chối compose có khoảng trắng sau `\` nối dòng và báo lỗi khi `vault-init` không `healthy` sau `up -d` (nguyên nhân #582 trên prod: khoảng trắng thừa làm script `vault-init` lỗi cú pháp, policy `signer` không được ghi → Vault 403, và vòng tự unseal không chạy). Cách đọc mã và sửa: `docs/DEPLOY.md` 2.23. Không migration, không biến môi trường mới.
- Rewards: JWT đăng nhập rewards chuyển từ `sessionStorage` sang `localStorage` theo ví, xoá khi `exp` qua, đồng bộ tab qua sự kiện `storage`, dọn key cũ trong `sessionStorage` (DEC-401, #584, **chưa merge**). Không migration, không biến môi trường mới.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
