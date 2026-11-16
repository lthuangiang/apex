# Ops page redesign (người dùng duyệt 2026-11-16)

Nguồn: canvas "Ops page redesign" (https://claude.ai/artifact/8eRHikEqQrWxNxsKAKgtzK). Người dùng duyệt qua ảnh chụp (`shots/`, số mẫu). Thay bố cục trang Ops cũ (DEC-276).

| File | Nội dung | Phạm vi |
|---|---|---|
| `Main.dc.html` | Trang desktop: mục đích, 6 ô tóm tắt, "Look at these first", "How to read this page", tab Market Making / Volume Builder, dòng mở chi tiết | **Code** |
| `MarketMaking.dc.html`, `VolumeBuilder.dc.html` | Biểu đồ và hướng dẫn cột cho từng chiến lược | **Code** |
| `RowExpanded.dc.html` | Dòng bot mở chi tiết | **Code** |
| `Mobile.dc.html` | 390 px | **Code** |
| `States.dc.html` | Loading / Empty / Error (gồm 403) / Stale | **Code** |
| `Notes.dc.html` | Nguồn dữ liệu từng chỉ số, ngưỡng, "needs data", ghi chú build | Tham khảo |
| `shots/*.jpg` | Ảnh chụp các artboard (số mẫu) | Tham khảo |

Quyết định chốt (DevOps theo ý người dùng 2026-11-16):
1. **Danh sách bot, bộ lọc "Show":**
   - **Active (mặc định):** bot Market Making / Volume Builder tiền thật của mọi user ở trạng thái running, paused, stopping, cộng bot stopped hoặc archived có mốc dừng trong **7 ngày** qua (mốc lấy từ outbox `user.<account>.bot`, không dùng `updated_at`).
   - **All bots:** mọi bot Market Making / Volume Builder tiền thật, gồm cả bot dừng lâu và archived; phân trang 50 bot; ô tìm theo tên bot, market, user id; giữ trên URL `?show=all`.
   - Không bao giờ hiện bot paper và bot draft.
2. **Nhãn:** Problem / Check / Healthy theo quy tắc trên canvas. Ngưỡng ghi "proposal" dùng làm mức ban đầu. Bot không chạy hiện "Not running" / "Archived", trừ khi còn cảnh báo đang mở.
3. **Thứ tự:** Problem → Check → Healthy → Not running → Archived; trong mỗi nhóm, volume 1 giờ giảm dần.
4. **Cost / $1M:** tính theo 24 giờ fill (công thức như Market hours, DEC-283). Ở chế độ All bots, bot không chạy hiện Cost / $1M cả đời bot.
5. **Chủ bot:** id ngắn `··` + 8 ký tự cuối, link `/admin/users/:id`; không email.
6. **Giờ** theo múi giờ trình duyệt (như Market hours), không phải UTC như trên canvas.
7. **Phần chi tiết:** 5 quyết định / cảnh báo gần nhất, bỏ qua dòng "Order requests".
8. **"Needs data"** (chưa làm đợt này): số lần bỏ qua vào lệnh đếm chính xác; request/phút của Volume Builder và của Market Making khi tắt Smart quoting (hiện "n/a"); P6.
9. Thiếu dữ liệu → "Not available" / "n/a", không bao giờ 0. Trang chỉ đọc.
