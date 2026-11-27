# vTBD (sau v2.21.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.21.0` (2026-11-27). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

- Rewards: your rewards sign-in now stays in this browser until it expires or you sign out, so new tabs no longer ask your wallet to sign again. Other open tabs follow sign-in and sign-out. You sign in once more after this update. (#584, **chưa merge**)

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Rewards: JWT đăng nhập rewards chuyển từ `sessionStorage` sang `localStorage` theo ví, xoá khi `exp` qua, đồng bộ tab qua sự kiện `storage`, dọn key cũ trong `sessionStorage` (DEC-401, #584, **chưa merge**). Không migration, không biến môi trường mới.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
