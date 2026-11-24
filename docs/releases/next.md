# vTBD (sau v2.18.2)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.2` (2026-11-24). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Rules `news-v5` (#506, DEC-383; **chưa merge**): tin listing trên BTC / ETH bị loại ở Score với `LISTING_MAJOR_ASSET` ("Listing on BTC or ETH"); delisting giữ nguyên. Bài v4 còn `collected` / `pending` lúc deploy chuyển sang v5 ở chu kỳ đầu.
- **Đếm lại từ 0 chỉ một lần:** Claude reader v6 (#505, DEC-382, PR #510) và Rules v5 (#506) đi chung một hotfix, nên cổng 50 nhãn, số lệnh và tổng kết chỉ đếm lại từ 0 một lần, ở lần deploy này. Nhãn và lệnh của reader v5 / Rules v4 giữ làm lịch sử. Nhãn "New in v6" (hộp reader và hộp Not counted) và chip "v4 → v5" hiện 14 ngày tính từ lúc reader v6 chạy.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
