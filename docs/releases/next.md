# vTBD (sau v2.15.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.15.0` (2026-11-21). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Signal research: random baseline phát lại nến từ phút sau lúc vào lệnh thật (`opened_clock_at`), không từ đầu chu kỳ; lệnh cũ không có cột này giữ `opened_at`, baseline đã lưu không tính lại (#405, DEC-TBD-sr-baseline-entry-clock). **Chưa merge.**

**Migration (chạy khi deploy):** chưa có.

**Biến môi trường mới:** chưa có.
