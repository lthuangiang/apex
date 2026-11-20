# vTBD (sau v2.13.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.13.0` (2026-11-20, `main` f675acc). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi cho người dùng (các việc dưới đây chỉ thuộc Signal research, trang của team).

Not financial advice. Past results are not a forecast.

## Kỹ thuật

**Signal research (chỉ team, paper trading, không bao giờ gửi lệnh tới SoDEX)**
- **Chưa merge.** Live drop chỉ thả tín hiệu: bài mới bị loại sớm không còn rơi xuống phễu từng bài, mà gom thành tóm tắt theo đợt.
- **Chưa merge.** Danh sách research wallets: xem bộ ví H1 đang dùng (theo phiên bản), link tới ví trong thẻ H1 của trace; kèm migration `0053`.

**Migration (chạy khi deploy)**
- **Chưa merge.** `0053`: thuộc việc danh sách research wallets. Tên file và nội dung ghi khi PR merge; kiểm tra tương thích ngược trước khi release (`docs/DEPLOY.md` mục 2.16 ghi chú bản sau).

**Biến môi trường mới:** chưa có.
