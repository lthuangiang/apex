# Market hours (người dùng duyệt 2026-11-16)

Nguồn: canvas "Market hours (team Ops)" (https://claude.ai/artifact/MFknE1z9LgnYWjc8hCbacF, bản 1794820773-1146). Kế hoạch: Bước 0 của việc "tạm dừng bot ở giờ biến động" (team Ops xem số trên prod trước khi quyết định). Mọi số trên artboard là số mẫu.

| File | Nội dung | Phạm vi |
|---|---|---|
| `Main.dc.html` | Trang desktop: bộ lọc, How to read this, 3 khối theo giờ (tweak `tz`, `audience`, `state`) | **Code** |
| `Mobile.dc.html` | 390 px: 24 dòng giờ, chạm để xem chi tiết | **Code** |
| `Loading.dc.html`, `Empty.dc.html`, `Error.dc.html` | Trạng thái | **Code** |
| `London.dc.html` | Ví dụ múi giờ UTC+0 | Tham khảo (kiểm tra múi giờ) |
| `KolkataPublic.dc.html` | Bản public sau này (UTC+5:30, chỉ bot của người xem) | Tham khảo, CHƯA code |
| `canvas.json` | Bố cục và ghi chú | Tham khảo |

Quy tắc chốt:
1. Route `/admin/market-hours`, team-only, nav "Market hours" ngay sau "Ops" dưới TEAM.
2. Múi giờ lấy từ trình duyệt (Intl), có nút "Show in UTC". API nhận `tz` (tên IANA, kiểm bằng zod) và gom theo giờ địa phương trong Postgres (`AT TIME ZONE`); "ngày" trong quy tắc "nóng" là ngày địa phương; tz sai → lỗi C6, web dùng UTC.
3. Mốc định nghĩa theo UTC (00, 02, 08, 09, 16 UTC), hiển thị "giờ địa phương · UTC". "US stock open" = 09:30 America/New_York theo ngày thật. Không đặt tên phiên nào khác.
4. "Nóng": trung vị range 1 phút của giờ đó > 2× trung vị range 1 phút của cả ngày đó.
5. "Thin sample": ô dưới 3 giờ-bot. Thiếu dữ liệu → "Not available" / "n/a", không bao giờ 0.
6. Nguồn: khối 1 = `candles_1m`; khối 2 = `mm_market_hourly` (giữ 90 ngày, DEC của #169); khối 3 = `fills` của bot Market Making / Volume Builder tiền thật (team: mọi user; public sau này: chỉ bot của người xem).
7. Thời gian giữ: nến và fill hiện "Available since {date}" (ngày dữ liệu thật đầu tiên); markout hiện "Kept for 90 days."
8. Trang chỉ đọc: "nothing on this page pauses or changes bots". Không dự báo.
9. Thêm sau thiết kế (người dùng duyệt, DEC-286): khối 1 có thêm dòng "Estimated cost per $1M (model)" cho mỗi giờ (mô hình chung với thẻ chi phí Market Making, DEC-228), cùng 4 bậc màu cam với Cost per $1M của khối 3; 390 px hiện trong chi tiết giờ ("Est. / $1M"). Tiền dưới $10 ở khối 3 hiện cent ("$0.31").
10. Thêm sau thiết kế (DEC-TBD-market-hours-help): mỗi nhãn dòng của ba khối và tiêu đề cột 390 px có nút ⓘ (aria-label "About {nhãn}", giải thích ở `marketHours.help.*`, DevOps duyệt câu chữ), hiện khi rê chuột, focus hoặc chạm, Esc để đóng. Dòng ước tính đổi tên thành "Estimated cost per $1M (model, floor)" vì nó không tính cắt vị thế và lệnh taker.
