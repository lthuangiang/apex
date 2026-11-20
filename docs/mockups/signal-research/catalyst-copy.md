# Catalyst Intelligence · Phase 0: câu chữ mới (chờ PM duyệt)

Câu chữ UI viết bằng tiếng Anh. `{…}` là biến. Ô `[confirm]` là ngưỡng chờ chốt, không hiện cho người dùng. Số trong mockup là số minh hoạ; riêng `5 min 45 s` lấy từ trang thật.

## 1. Độ trễ theo từng chặng

**From headline to trade › chế độ tổng.** Ô mới thay ô "Delay, news out → collected".

| Chỗ | Câu |
|---|---|
| Tiêu đề ô | `Where the time goes` |
| Phụ đề | `median · last {range} · {n} articles` |
| Chặng 1 | `Published by the source → SoSoValue`: luôn là `Not provided` (SoSoValue không gửi giờ của nguồn) |
| Chặng 2 | `SoSoValue → DeskLabs collected · waiting for the 5-min check` |
| Chặng 3 | `Collected → Claude done` |
| Chặng 4 | `Claude done → decided` |
| Chặng 5 | `Decided → paper trade opened` |
| Chặng chưa đo được | `Not measured yet` |
| Chặng chậm nhất | `Slowest leg: {leg}.` · khi đó là chặng 2: `SoSoValue is checked every {n} min, so most of the delay is the wait for the next check.` |
| Tổng | `Total, SoSoValue → paper trade opened: {duration}` · thiếu chặng thì `Not measured yet (one leg is missing)` |

**Trace › thẻ 1 · Collect.**

| Chỗ | Câu |
|---|---|
| Tiêu đề khối | `From news to trade` |
| Tổng | `SoSoValue → decided: {duration}` (hoặc `SoSoValue → paper trade opened: {duration}` khi đã đo được) |
| Mốc | `Published by the source` · `SoSoValue released` · `DeskLabs collected` · `Claude done` · `Decided: {Long/Short} {asset}` (hoặc `Decided: no trade`) · `Paper trade opened` |
| Khoảng giữa hai mốc | `+{duration}` · ở mốc collected thêm `· waited for the {n}-min check` |
| Giải thích cho `Not provided` | `SoSoValue doesn’t send the source’s time` |

## 2. Trạng thái thị trường lúc quyết định

| Chỗ | Câu |
|---|---|
| Thẻ Decide, nhãn | `Market at decision` |
| Chip | `BTC trend: {up/flat/down}` · `Volatility ({asset}): {low/normal/high}` |
| Dòng số | `BTC {±x.x}% in the last {window}` · `{asset} 30-day move rank: {n}th percentile` · `How it works › Market state` |
| Paper trades, cột mới | `Market at entry` · chip `BTC trend: {…} · volatility: {…}` · thiếu thì `Not available` (điện thoại: `Market: Not available`) |
| Is it working?, tab mới | `By market` |
| Phụ đề tab | `Same closed trades as Overall, split by the market at decision. A group needs 30 closed trades before its average shows.` |
| Hai bảng | `By BTC trend` · `By volatility of the traded asset` · cột `Market at decision`, `Closed trades`, `Average after fees` |
| Dòng cho lệnh cũ | `Not recorded (before Phase 0)` · `Not compared` |
| Drawer, tab mới | `Market state` |
| Drawer, đoạn đầu | `Market state is saved with every decision. It describes the market at that moment. It never changes a decision; it’s only used to split the results in Is it working? › By market.` |
| Drawer, BTC trend | `BTC-USD change over the last [confirm 24 h], from SoDEX prices:` · `up: more than [confirm +1.5%]` · `down: less than [confirm −1.5%]` · `flat: in between` |
| Drawer, volatility | `The asset’s move over the last [confirm 4 h], ranked against its own last 30 days:` · `low: below the [confirm 33rd] percentile` · `high: above the [confirm 67th] percentile` · `normal: in between` |
| Drawer, thiếu dữ liệu | `No price data at that moment: “Not available”. Trades opened before market state was recorded show “Not available” too.` |

## 3. Sổ thí nghiệm (Experiments)

| Chỗ | Câu |
|---|---|
| Khối mới, đầu khu Bots & labels | `Experiments` · `One hypothesis, one change, one result` |
| Phụ đề | `Each version tests one change against Baseline (v{n}) on the same articles. When it has {n} paired closed trades it stops by itself and moves to Finished, so no more than {max} versions run at once (Baseline included).` · `How it works › Experiments` |
| Nhóm Running | `Running · {n} experiments + Baseline = {used} of {max} versions` · còn chỗ: `{k} slot(s) free` · hết chỗ: `No free slot: the next experiment can start when one finishes` |
| Nhóm Finished | `Finished · {n}` · `Stopped at {n} paired closed trades · results don’t change after that` |
| Cột thêm ở Finished | `Stopped` (ngày dừng) |
| Cột | `Hypothesis` · `Version · control` · `Started` · (Finished: `Stopped`) · `Measured by` · `Paired trades have / need` · `Result` |
| Ô version | `vs Baseline (v{n})` · `Change: {change}` / `Changes: {list}` |
| Chỉ số đo | `Result after fees, paired with Baseline` |
| Kết quả | Running: `Collecting` · Finished: `Better` · `Worse` · `No clear difference` (PM chốt: theo khoảng tin cậy của chênh lệch ghép cặp; màu Better xanh dương, Worse đỏ nhạt, No clear difference xám, Collecting hổ phách) |
| Cảnh báo trên dòng | `Not a clean test. Changes {n} things from Baseline: {fields}. A result can’t show which change caused it. Copy to new version and change one thing.` |
| Dòng phụ khi gập Bots & labels | `{n} experiments running · {n} not a clean test · {n} finished` |
| Sheet New version, ô mới | `Hypothesis (one sentence)` |
| Sheet, dòng thay đổi | `Changes from Baseline (v{n}): {list}` |
| Sheet, cảnh báo | `This version changes {n} things from Baseline. If its result differs, you won’t know which change caused it. Keep one change per version.` · nút `Save and start anyway` · `Back to edit` |
| Sheet, sau khi lưu | `Saved anyway: the experiment shows “Not a clean test” in Bots & labels › Experiments.` |
| Drawer, tab mới | `Experiments` |
| Drawer, nội dung | `One hypothesis, one experiment, one result. Each new version states one hypothesis and changes one thing from Baseline (v{n}). Then any difference in the result comes from that change.` · `Paired with Baseline. Baseline and the experiment see the same articles. For every article both traded, DeskLabs compares the two results after fees. The comparison needs [confirm 100] paired closed trades.` · `Running and Finished. An experiment stops by itself when it has [confirm 100] paired closed trades and moves to Finished with its stop date and result. So no more than {max} versions run at once (Baseline included), and a finished result doesn’t change.` · `Results. Better or Worse: the likely range of the paired difference stays above or below 0. No clear difference: the range crosses 0 after the paired trades are in. Collecting: still running, not enough paired trades yet.` · `Not a clean test. A version that changes more than one thing from Baseline still runs, but its result can’t show which change caused it.` · `A result is about the past trades only. It isn’t a forecast.` |
