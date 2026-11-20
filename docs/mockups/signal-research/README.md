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

## Trang Signal research làm lại (#340, người dùng duyệt 2026-11-19)

Mở thẳng file HTML trong trình duyệt. Các trang có tương tác dùng `dc-shim.js` (runtime nhỏ chỉ để xem mockup, không phải code sản phẩm). Số liệu là dữ liệu mẫu.

| File | Nội dung |
|---|---|
| `redesign-full-page.html`, `-1440.png` | Toàn trang: Version, Progress, How it works, Paper bots, From headline to trade (phễu sáng 6 bước, bước 4 Context viền đứt, feed rộng bằng ô giải thích đầu), Is it working? (thanh tiến độ), Paper trades |
| `redesign-full-page-mobile.html`, `-390.png` | Toàn trang trên điện thoại (thanh tab cuộn ngang) |
| `redesign-trace-live.html`, `-1440.png` | Trace chạy thật: bấm một bài, chip chạy qua 6 bước, khung Context cạnh phễu chạy hiệu ứng theo dữ liệu bài đó (5 bài mẫu: cả ba Yes, không cá voi + giá chạy sớm, META không có dữ liệu cá voi, cả ba No, bị loại trước bước 4) |
| `redesign-trace-no-signal.html`, `-at-context-1440.png` | Như trên, tự chạy bài "cả ba No": sonar + 2 cá voi lội dưới nước ("27 wallets checked · quiet"), bập bênh lắc rồi cân bằng, giá "on time" |
| `redesign-context-effects.html`, `-1440.png` | Từng hiệu ứng H1 / H2 / H3 với nút ví dụ (Yes, No, Whales disagree, No whale data) |
| `redesign-live-new-article.html`, `-1440.png`, `-dropping-1440.png` | Bài mới tới khi đang ở trang: rơi xuống phễu, chạy nhanh qua các bước, số đếm nhảy (#345) |
| `redesign-does-context-help.html`, `-1440.png` | Tab "Does context help?": 3 câu hỏi đăng ký trước, With / Without, khoảng theo khối ngày, ≥ 30 mỗi nhóm |
| `redesign-context-card.html`, `-760.png` | Thẻ Context trong trace (giữa Score và Filter) |

**Quy tắc hiệu ứng (PM chốt):**
- Hiệu ứng mang thông tin chạy một lần, ≤ 1.2 s; không lặp; cuộn trang không chạy lại; chỉ chạy lại khi bấm Replay.
- Cá voi lội nền: 2.6 s, một lượt, không che chữ, tắt hẳn khi reduced motion.
- Reduced motion: hiện khung cuối.
- Badge Yes màu trung tính; xanh lá chỉ cho lệnh đã vào / lời; H3 màu hổ phách (cảnh báo).

**Bài mới live (#345):**
- Mỗi lần một bài, nhịp nhanh khoảng 2.5 s. Hơn 3 bài chờ thì phần còn lại chỉ cộng số đếm ("+N more").
- Không cắt ngang trace đang xem: bài mới chờ ở chip "N new articles · play".
- Tab ẩn hoặc phễu ngoài màn hình: chỉ cập nhật số, không chạy hiệu ứng.
- Công tắc "Live" (tắt thì bài mới chỉ hiện trong feed, không rơi). Nên nhớ lựa chọn theo người xem.
- Ở mockup có hàng nút "Mockup controls" để giả lập, sản phẩm không có hàng nút này.
- Sửa câu H3 so với canvas: "The line runs to the entry mark in the signal's direction".

**Định nghĩa H1 / H3 sửa ở review PR #349:** H1 chỉ xét ví DeskLabs đang theo dõi (được follow, và đã có trong leaderboard trước thời điểm đó), nên HTML ghi "tracked wallets" và "N wallets checked" với N là số ví thật sự được kiểm (mẫu dùng 12, không phải 214 của leaderboard); "Not available" khi tài sản không có trên Hyperliquid hoặc không có ví theo dõi nào có dữ liệu. H3 đo từ giờ đăng của bài đầu tiên của story (cùng số với "moved before entry"). Ảnh PNG chụp trước khi sửa nên còn câu cũ; HTML là bản đúng.

**H1 context-v2 (#353):** tập ví của H1 là tập ví nghiên cứu cố định: top K ví tab Top của lần xếp hạng gần nhất (K = 30 mặc định), chụp theo phiên bản. HTML ghi "research wallets (top {K} of the leaderboard)" (mẫu: top 30, 27 ví đọc được trong giờ trước nên "27 wallets checked"); "Not available" khi tài sản không có trên Hyperliquid hoặc không có ví nghiên cứu nào đọc được trong 60 phút. How it works không ghi số K ("the top of the leaderboard"). Snapshot context-v1 đã lưu (ví được follow) vẫn hiện câu "tracked wallets". PNG chưa chụp lại.
