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

## Trang Signal research gọn (người dùng duyệt 2026-11-20)

Người dùng thấy khu Paper bots và Classifier quality quá to mà khó hiểu. Bản gọn gom chúng lại. Số trong khung A, B, D, E lấy từ ảnh UI thật lúc 06:46; khung C là số minh hoạ (lấy từ mockup #340). HTML tự chứa (font nhúng sẵn), mở thẳng trong trình duyệt.

| File | Nội dung |
|---|---|
| `compact-desktop.html`, `compact-1440.png` | Khung A: toàn trang 1440, Bots & labels đang gập |
| `compact-1440-expanded.png` | Khung B: Bots & labels đang mở |
| `compact-strip-states-1440.png` | Khung C: dải tóm tắt khi đã đếm (2 version) và khi đủ 3 version, một version thiếu số |
| `compact-drawer-labels-1440.png`, `compact-drawer-versions-1440.png` | Khung D, E: drawer How it works › Labels (tab mới) và › Versions |
| `compact-mobile.html`, `compact-390.png`, `compact-390-expanded.png` | Toàn trang 390, gập và mở |
| `compact-copy-changes.md` | Bảng câu cũ → câu mới đã duyệt, câu mới hoàn toàn |

**Quy tắc PM chốt khi code (DEC-346):**
- Thứ tự trang: dải tóm tắt → From headline to trade → Is it working? → Paper trades → Bots & labels (gập sẵn bằng `<details>`).
- Dải tóm tắt thay Paper bots, Classifier quality và dòng Progress: banner "Research only · fake money" có chấm nguồn, bộ chọn Version, mỗi version đang chạy / tạm dừng một dòng (tối đa 3; version đang chọn luôn có mặt), rồi hàng nhãn bằng lời thường với [Label signals] [Manage versions]. Thiếu số thì "Not available", không bao giờ 0.
- Claude reader dưới 80%: "Not counting yet: Claude reader is right {pct}% of the time on {n} labels; it needs 80% on 50. Label more signals." trên nền amber nhạt, có nút Label signals. Chưa đủ nhãn / đã qua: nền xanh nhạt.
- Trên UI không còn chữ "classifier": dùng "Claude reader"; "gate" thành "verdict" / "counting"; tab drawer "The gate" thành "When a signal passes". Code và DB giữ tên cũ.
- Một tên nút duy nhất: "Label signals" (dải tóm tắt, Is it working?, khu Bots & labels, drawer › Labels). Bấm thì mở Bots & labels, bắt đầu gắn nhãn ngẫu nhiên và cuộn tới. "Manage versions" mở Bots & labels và cuộn tới.
- Running và Live dùng xanh dương (trung tính); xanh lá chỉ cho lệnh đã vào / có lãi.
- Bỏ 3 ô giải thích Context dưới phễu (nội dung đã có ở drawer › Context questions). Mọi thứ khác của From headline to trade giữ nguyên, chỉ đổi vị trí.
- Giải thích dài của Paper bots / Classifier quality dời vào drawer: tab Versions và tab Labels (mới). Drawer có 7 tab, cuộn ngang khi hẹp, mép phải mờ khi còn tab phía sau.

## Catalyst Intelligence Phase 0 (#374)

Người dùng duyệt bố cục và 4 quy tắc nghiên cứu ngày 2026-11-20 ("Duyệt cả"). Câu chữ do PM duyệt. Số trong ảnh là số minh hoạ, có ghi "Sample". Viền tím đứt kèm nhãn "NEW" đánh dấu chỗ dữ liệu mới sẽ hiện. Ô vàng `[confirm]` trong ảnh đã được chốt theo DEC.

- `catalyst-latency-{1440,390}.png` (#375):
  - Ô "Where the time goes" ở chế độ tổng hiện median từng chặng và làm nổi chặng chậm nhất.
  - Thẻ Collect của trace có dòng thời gian 6 mốc.
  - Chặng chưa đo được ghi "Not measured yet"; chặng nguồn → SoSoValue ghi "Not provided".
- `catalyst-market-state-{1440,390}.png` và `catalyst-drawer-market-state-1440.png` (#376):
  - Chip "BTC trend / Volatility" trên thẻ Decide; cột "Market at entry" trong Paper trades.
  - Tab "By market" trong Is it working?; tab Market state trong drawer.
- `catalyst-experiments-{1440,390}.png` và `catalyst-drawer-experiments-1440.png` (#377):
  - Khối Experiments ở đầu Bots & labels, chia hai nhóm Running và Finished.
  - Cảnh báo "Not a clean test"; ô Hypothesis trong sheet New version.
- `catalyst-desktop.html`, `catalyst-mobile.html`: bản HTML tự chứa của các khung trên.
- `catalyst-copy.md`: toàn bộ câu chữ mới.

## How it works › Overview (#391, người dùng duyệt bố cục 2026-11-20)

Tab đầu tiên của drawer How it works: sơ đồ một vòng chạy (Collect → Normalize → Score → Context → Filter → Decide → Watcher → Results), hoạt cảnh có caption, danh sách 6 bước mở / đóng, ô "Never". HTML tự chứa (chỉ có link Google Fonts), mở thẳng trong trình duyệt.

| File | Nội dung |
|---|---|
| `how-it-works-overview.html` | Drawer tab Overview, có tương tác (chấm chạy qua 8 chặng, Previous / Pause / Next, bấm một bước mở mục tương ứng) |
| `how-it-works-overview-1440.png`, `how-it-works-overview-390.png` | Ảnh chụp drawer (reduced motion, đã mở hết chiều cao) |

**Quy tắc PM chốt khi code:**
- Số 5 phút, 24 giờ, 30 phút, 4.000 ký tự, 7 ngày, 2× chi phí, 100 lệnh, 50 nhãn / 80%, 24 h / 4 h của Market state lấy từ hằng của `@drift/shared`, không viết cứng. Số lần gọi Claude mỗi vòng và ngân sách token mỗi ngày chỉnh bằng env nên câu không có số.
- "Claude reader v3": version lấy từ Claude reader đang chạy; không có dữ liệu thì bỏ số version.
- Câu level theo `levelOf`; watcher không ghi nhịp đọc giá (vòng watcher không cố định 1 giây).
- Badge "New" cạnh tên tab có trong mockup nhưng chưa code (không có luật khi nào ẩn; chờ PM chốt ở PR #391).
- Reduced motion: không tự chạy, chấm nhảy thẳng tới chặng, nét đứt không chạy. Mọi khối trong drawer giữ chiều cao (`shrink-0`).

## Claude reader v4 + Rules v4 (#395, người dùng duyệt 2026-11-21)

Những chỗ UI đổi khi ship Claude reader v4 (`news-classifier-v4`) và Rules v4 (`news-v4`). Bố cục không đổi, chỉ thêm nội dung. Câu chữ PM đã duyệt (không đưa vào `_pendingReview`). Khung tím là ghi chú cho người duyệt. HTML tự chứa (chỉ có link Google Fonts).

| File | Nội dung |
|---|---|
| `reader-v4.html` | Ba khung: drawer How it works › News types (2 hộp mới), Is it working? › Overall (thẻ nhãn reader v4, thẻ reader v3 Retired), From headline to trade (bài bị loại bởi `ETF_MAJOR_ASSET`, câu "Why it stopped") |
| `reader-v4-1440.png` | Ảnh chụp 1440 |

**Quy tắc khi code (DEC-TBD-sr-reader-v4):**
- Nhãn "New in v4" (và chip "v3 → v4" ở dòng sub) ẩn sau `READER_NEW_BADGE.days` = 14 ngày, tính từ `started_at` của `news-classifier-v4` lấy từ API `/classifiers`, không dùng hằng ngày của web.
- Thẻ "Claude reader v3 · Retired {date}": reader ngay trước reader hiện tại; ngày = `started_at` của reader hiện tại; số lệnh đóng và số nhãn từ `closedTrades` / `labeledAny` của API.
- "Why it stopped" là câu kết của trace ("Stopped at Score: …"), không thêm khối mới.
- Pill "Collecting" của thẻ nhãn và câu "new rules and reader, count starts again" của thẻ lệnh đóng trong khung 2 chưa code: hai thẻ giữ câu chữ hiện có (số đếm vẫn về 0 / 50 và 0 / 100).
