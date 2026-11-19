# Signal research: mockup

Bản chép từ canvas đã duyệt, dùng làm nguồn thiết kế cho tab **Signal research** trong trang Signal Analysis (chỉ team).

| File | Nội dung |
|---|---|
| `signal-research.html`, `signal-research-main-1440.png` | Tab Signal research, desktop (#269) |
| `flow.html`, `signal-research-flow-1240.png` | Luồng tín hiệu news (#269) |
| `trade.html`, `signal-research-trade-640.png` | Chi tiết một paper trade (#269) |
| `mobile.html`, `signal-research-mobile-390.png` | Tab Signal research, điện thoại (#269) |
| `news-trace.html` | News feed và funnel trace, desktop 1440, có tương tác (#288) |
| `news-trace-mobile.html`, `news-trace-mobile-390.png` | News feed và funnel trace, điện thoại 390, tĩnh (#288) |
| `news-trace-totals-1440.png` | Chế độ tổng (chưa chọn bài) |
| `news-trace-trace-1440.png` | Sau khi trace xong bài ETH (tới Decide, mở paper trade) |
| `news-trace-dropped-1440.png` | Bài SOL bị loại ở bước Filter |

`news-trace.html` là HTML tĩnh, không phụ thuộc gì (chỉ có link Google Fonts). Mở thẳng trong trình duyệt:

- Bấm một bài trong News feed: chip chạy qua 5 bước Collect → Normalize → Score → Filter → Decide, thẻ từng bước hiện dần.
- `Back to totals`, `Replay`; bấm một bước hoặc một lý do trong "Why they dropped out" để lọc feed; nút `1 day` / `7 days`; nút `Trace` ở bảng Trades.
- Tự chạy demo bài ETH sau 1,5 s. Thêm `?demo=0` để tắt, `?speed=slow|normal|fast` để đổi tốc độ.

Câu chữ, số liệu và màu giữ nguyên như canvas. Số liệu là dữ liệu mẫu, không phải số thật.

## News bot versions và gắn nhãn phân loại (#299)

| File | Nội dung |
|---|---|
| `bot-versions.html`, `bot-versions-main-1440.png` | Khối Paper bots: các version đang chạy (tối đa 3), số version đã thử, kiểm tra thêm khi > 3, bảng mọi version (có cột Blocked by limit) |
| `bot-versions-editor.html`, `bot-versions-editor-1440.png` | Sheet tạo version mới: loại tin, level, size / TP / SL, Max open trades, Max new trades per day, tin ngược chiều (Keep / Close), Assets (All / Only these / All except + picker) |
| `bot-versions-labels.html`, `bot-versions-labels-1440.png` | Gắn nhãn Right / Wrong trên thẻ Score (ẩn kết quả lệnh), bảng chất lượng classifier theo version classifier |
| `bot-versions-picker-mobile.html`, `bot-versions-picker-mobile-390.png` | Picker tài sản trên điện thoại (bottom sheet) |

HTML tĩnh, không có tương tác. Số liệu là dữ liệu mẫu. Ghi chú khi code (PM): ẩn checkbox Crypto / Stocks ở chế độ Only these; Max open trades lớn hơn số mã trong whitelist thì ghi "Effectively N: one trade per asset".
