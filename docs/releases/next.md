# vTBD (sau v2.20.0)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.20.0` (2026-11-26). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- SoDEX rewards: sửa hiển thị số (**chưa merge**, Refs #546, PM xem prod v2.20.0 và đối chiếu trang SoPoints của SoDEX): bảng Weekly performance và dòng "This week" của thẻ Overview không còn hiện 0 cho tuần chưa chốt: tuần `isLive` → chip "In progress", tuần đã kết thúc mà `pointsStatus` khác CONFIRMED → chip "Snapshot done" (không số); hạng 0 / thiếu → "–" mờ; tuần CONFIRMED có 0 thật vẫn hiện 0. Mọi số USD trong Rewards (khối lượng tuần, phần thưởng, tổng kết, history) dùng một hàm: có phần lẻ thì 2 chữ số ("$296,474.70"), số nguyên không phần lẻ ("$0", "$84,300"). Cột From (Backpack / History): source / reason lạ hiện nguyên chuỗi viết hoa chữ đầu ("manual" → "Manual"). Nhãn phụ Weekly pool thành "Weekly pool · from SoDEX" (API trả 1,000,000, trang SoDEX ghi 900,000, chưa rõ). Trang chẩn đoán liệt kê giá trị khác nhau của `status` / `pointsStatus` / `isLive` trong week/list. Không migration, không biến môi trường mới.

**Migration (chạy khi deploy):** không có.

**Biến môi trường mới:** không có.
