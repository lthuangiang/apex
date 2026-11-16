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
10. Thêm sau thiết kế (DEC-287): mỗi nhãn dòng của ba khối và tiêu đề cột 390 px có nút ⓘ (aria-label "About {nhãn}", giải thích ở `marketHours.help.*`, DevOps duyệt câu chữ), hiện khi rê chuột, focus hoặc chạm, Esc để đóng. Dòng ước tính đổi tên thành "Estimated cost per $1M (model, floor)" vì nó không tính cắt vị thế và lệnh taker.
11. Thêm sau thiết kế (DEC-287): khối 1 có thêm "Largest 1-min range (bp)" (nến có range lớn nhất trong kỳ của giờ đó) và "Largest 15-min move (bp)" ((close cao nhất − close thấp nhất) ÷ close thấp nhất trong cửa sổ 15 phút bắt đầu trong giờ đó), vì trung vị che mất cú sốc hiếm. Tooltip: "{value} bp · {date time} (your time zone)" và "{value} bp · starts {date time}". Thang màu riêng 4 bậc tím (dưới 25 · 25–50 · 50–100 · từ 100 bp ▲). 390 px: cả hai nằm trong chi tiết giờ.
12. Chỉnh giao diện sau thiết kế (người dùng yêu cầu, 2026-11-16): ô múi giờ + "Show in UTC" nằm trong thẻ bộ lọc (không nằm cạnh cụm Mainnet / chuông của thanh trên cùng). Heatmap: 7 ngày dòng cao 28 px, nhãn "Tue, Nov 10"; 30 ngày dòng gọn 14 px, nhãn "Nov 10", mọi ô vẫn có tooltip; các ngày đầu kỳ chưa có nến nào bị ẩn và tiêu đề khối 1 hiện "Data since {date}". Mốc giờ: chip nhỏ trên số giờ + một đường dọc mảnh liền qua các nhóm dòng (thay khung cam đậm). "How to read this" là danh sách 3 mục có biểu tượng (3 cột trên desktop), mở sẵn trên desktop, đóng sẵn ở 390 px như artboard Mobile. Cột nhãn 272 px để không nhãn nào xuống dòng ở 1440.
13. Chỉ trên trang này (người dùng yêu cầu, 2026-11-16): "Cost per $1M" rút gọn thành "CPM" ở nhãn dòng, chú giải và tiêu đề cột 390 px ("Est. CPM (model, floor)", "Est. CPM" trong chi tiết giờ). How to read this và "How these numbers are calculated" có câu "CPM = cost per $1M of volume (fees plus price loss)."; câu giải thích ⓘ của các dòng CPM bắt đầu bằng "CPM (cost per $1M of volume): …". Nơi khác trong app giữ "Cost per $1M".
