# vTBD (sau v2.18.2)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.2` (2026-11-24). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Rules `news-v5` (#506, `DEC-TBD-sr-listing-major-asset`; **chưa merge**): tin listing trên BTC / ETH bị loại ở Score với `LISTING_MAJOR_ASSET` ("Listing on BTC or ETH"). Số nhãn, số lệnh và cổng đếm lại từ 0; lệnh v4 là lịch sử. Bài v4 còn `collected` / `pending` lúc deploy chuyển sang v5 ở chu kỳ đầu. Không đổi prompt.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
