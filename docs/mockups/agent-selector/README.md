# Trading Agent bot selector (người dùng chọn phương án A, 2026-11-16)

Nguồn: canvas "Trading Agent bot selector" (https://claude.ai/artifact/2Aa7bPSMJ7YbKaFZLVStip). Thay dải thẻ chọn bot cuộn ngang ở đầu trang Trading Agent (`/agent`, `/agent/:botId`). Làm luôn BD-10 (id ngắn trên thẻ).

| File | Nội dung | Phạm vi |
|---|---|---|
| `Main.dc.html` | Phương án A ở 1440: thanh tóm tắt bot đang xem + nút Switch bot, panel combobox có tìm kiếm, lọc, nhóm | **Code** |
| `MobileClosed.dc.html`, `Mobile.dc.html` | 390: thẻ đầu trang làm bộ chọn; bottom sheet khi mở | **Code** |
| `Empty.dc.html`, `OneBot.dc.html`, `ManyBots.dc.html`, `States.dc.html` | Không có bot / 1 bot / 26 bot trùng tên / loading, lỗi, dữ liệu cũ, không khớp tìm kiếm | **Code** |
| `Notes.dc.html` | Trường dữ liệu từng dòng, thứ tự, bàn phím / trình đọc màn hình | Tham khảo |
| `shots/*.jpg` | Ảnh chụp (gồm cả phương án B, C không chọn) | Tham khảo |

Quyết định chốt (DevOps theo uỷ quyền, 2026-11-16):
1. Phương án A (combobox + listbox). Không dùng B (rail trái) hay C (lưới).
2. Nhóm: Needs attention → Running (gồm Starting/Resuming) → Paused (gồm Pausing/Stopping) → "Show N stopped bots" (thu gọn). Trong nhóm: cập nhật mới nhất trước.
3. Archived: ẩn mặc định, chỉ hiện khi chọn bộ lọc "Archived"; mở trang chỉ xem (DEC-263 cho phép xem qua bộ lọc).
4. Id ngắn: `··` + 8 ký tự cuối của uuid (như Bot Monitor).
5. Tóm tắt cấu hình trên mỗi dòng: API thêm trường `summary` (chuỗi do server tạo theo chiến lược, ví dụ "$50 · 1 bp · Smart quoting"); thiếu thì chỉ hiện capital.
6. PnL trên dòng giữ như hiện tại (cả đời bot). Volume 24 giờ để sau.
7. Câu chữ mới trên artboard: DevOps duyệt.
