# DRIFT — Engine đề xuất và AI parameters

> Một phần của bộ tài liệu DRIFT. Đọc `CLAUDE.md` ở gốc repo trước. Số mục giữ nguyên như bản gốc để các tham chiếu "mục X" vẫn đúng (xem bảng mục lục trong `CLAUDE.md`).

## 10. Engine đề xuất và AI parameters **[ĐỀ XUẤT — đã code theo khuyến nghị (DEC-39), chờ product duyệt]**

Service `reco` là một engine **tất định**: cùng đầu vào thì ra cùng kết quả. Nó dùng chung cho hai chỗ: "Strategies that fit how you trade" (onboarding bước 6) và "✦ AI parameters" (màn tạo bot, Retune with AI). Mọi con số engine đưa ra đều truy được về đầu vào. LLM, nếu có dùng, **chỉ được diễn đạt lại câu lý do**; không được tạo hay sửa số.

Mọi ngưỡng dưới đây nằm trong `packages/shared/src/reco/config.ts` để product chỉnh mà không cần sửa code. Giá trị có ghi *(chỉnh được)* là đề xuất ban đầu.

### 10.1 Đầu vào
**A. Phân tích tài khoản** (từ bước import):
- Theo market: `netPnl[market]`, `winRate[market]`, `volumeShare[market]`.
- Phí và lãi: `fees`, `grossPnl`, `takerRatio`.
- Theo thời gian giữ lệnh: `pnlByHolding{<15m, 15m–4h, 4h–1d, 1–7d, >7d}`.
- Theo đòn bẩy: `lossShareByLeverage{<3x, 3–8x, ≥8x}`.
- Khác: `maxDrawdownPct`, `avgHoldLosers`, `avgHoldWinners`, `hasPerpsHistory`.

Nếu có < 30 vị thế đã đóng thì coi là **người mới**: bỏ qua mọi quy tắc dựa trên lịch sử và nói rõ điều đó trong phần lý do.

**B. Mục tiêu** (bước 5): `goal ∈ {automate, range, accumulate, steady}`, `capital C`, `maxDrop d ∈ {5,10,20}` (`unsure` → 5), `markets M`. Ngoài onboarding thì dùng mục tiêu đã lưu; nếu chưa có thì `d = 10` và `C` = vốn của bot người dùng nhập.

**C. Thống kê thị trường** (`scheduler` tính mỗi ngày cho từng market, từ `candles_1m` và funding):
- `σ` = độ lệch chuẩn của log return theo ngày, 30 ngày gần nhất.
- `P5, P50, P95` = các phân vị của giá đóng cửa theo ngày, 30 ngày. Kèm `lastPrice`, `markPrice`.
- `trend` = ln(giá hiện tại / giá 30 ngày trước) / (σ·√30).
- `rangeScore` = tỷ lệ số ngày trong 180 ngày qua mà giá đóng cửa nằm trong khoảng ±1.5·σ·√30 quanh đường trung bình 30 ngày.
- `fundingAvg7d`, `fundingPositiveShare21` (tỷ lệ số kỳ funding > 0 trong 21 kỳ gần nhất).
- `fee_rt` = chi phí một vòng mua bán = 2 × (maker fee của SoDEX + builder fee của DRIFT nếu áp dụng). Maker fee đo từ fill maker của người dùng; chưa có thì dùng mức cơ bản trong `reco/config.ts` (DEC-39).
- `minOrder`, `tick`, `lot`, `maxLeverage` lấy từ market info.

### 10.2 Điều kiện đủ (đạt hết thì mới là ứng viên)

| Chiến lược | Điều kiện |
|---|---|
| Spot Grid | market ∈ M · `rangeScore ≥ 0.60` · vốn đủ cho ≥ 5 level ở `minOrder` |
| Futures Grid | như Spot Grid · có perp · `goal ≠ steady` |
| Spot DCA | market ∈ M · `goal ∈ {automate, range, steady}` · `1.5% ≤ σ ≤ 6%` |
| Futures DCA | `goal = automate` · `hasPerpsHistory` · `netPnl[market] > 0` · `d ≥ 10` |
| Recurring Buy | `goal ∈ {accumulate, steady}` · market ∈ M ∩ nhóm coin lớn (BTC, ETH) *(chỉnh được)* |
| Rebalancing | `|M| ≥ 2` · `goal ∈ {accumulate, steady}` |
| Funding Arbitrage | `fundingAvg7d ≥ 0.005%` · `fundingPositiveShare21 ≥ 0.70` · `C ≥ 2,000 USDC` *(chỉnh được)* |
| TWAP | không bao giờ đề xuất (là công cụ khớp lệnh, chỉ dùng khi người dùng tự chọn) |

### 10.3 Loại trừ (là nguồn cho mục "What we didn't suggest, and why")

| Điều kiện | Tác động | Câu lý do (UI tiếng Anh) |
|---|---|---|
| `pnlByHolding[<15m] < 0` | chỉ ghi chú | "Your trades under 15 minutes lost {x} after fees." |
| market ∉ M và `netPnl[market] < 0` và `winRate[market] < 40%` | loại market | "{market}: {netPnl} net with a {winRate} win rate." |
| `lossShareByLeverage[≥8x] > 50%` | mọi bot perp bị giới hạn ở 1× | "Positions at 8× or more caused {share} of your losses." |
| lỗ tối đa của chiến lược ở mức vốn tối thiểu > `C × d` | loại chiến lược | "Above your {d}% max drop at any useful size." |

### 10.4 Chấm điểm (0–100) và chọn

`score = goalFit (0–40) + historyFit (0–30) + marketFit (0–20) + costFit (0–10)`

- **goalFit** (bảng tra, *chỉnh được*):
  - automate: Futures Grid 40, Spot Grid 35, Futures DCA 30, Spot DCA 25
  - range: Spot Grid 40, Futures Grid 35, Spot DCA 20
  - accumulate: Recurring Buy 40, Rebalancing 30, Spot DCA 25
  - steady: Rebalancing 40, Recurring Buy 35, Spot Grid 20
  - Funding Arbitrage: 25 với mọi goal
- **historyFit** (bỏ qua với người mới): +15 nếu `netPnl[market] > 0`; +10 nếu nhóm thời gian giữ lệnh đặc trưng của chiến lược (grid/DCA: 4h–7d) có PnL dương; +5 nếu `winRate[market] ≥ 50%`.
- **marketFit**: grid → `20 × rangeScore`; DCA → 20 nếu `1.5% ≤ σ ≤ 4%`, ngược lại 10; funding arb → `20 × fundingPositiveShare21`; recurring / rebalancing → 10.
- **costFit**: +10 cho chiến lược dùng lệnh maker (grid, DCA lệnh limit, rebalancing lệnh limit) khi `takerRatio ≥ 0.6`, ngược lại +5.

**Chọn:**
- Sắp ứng viên theo điểm. **Best fit** = ứng viên cao điểm nhất.
- **Add-on** = ứng viên kế tiếp khác market *hoặc* khác nhóm chiến lược, tối đa 1 *(chỉnh được)*.
- Bằng điểm thì ưu tiên chiến lược cần ít vốn hơn.

**Chia vốn:**
- Best fit nhận 60% của C, add-on nhận 40% *(chỉnh được)*.
- Bot nào không đủ vốn tối thiểu thì cấp đúng mức tối thiểu, phần còn lại cho bot kia.
- Vẫn không đủ thì bỏ add-on.
- Không có ứng viên nào: hiện "No strategy fits your answers yet. Try a larger capital or a different goal."

### 10.5 Cách tính tham số (dùng cho "✦ AI parameters")

Mọi giá làm tròn theo `tick`, mọi khối lượng theo `lot`. Level nào có lệnh dưới `minOrder` sau khi làm tròn thì bỏ đi hoặc gộp lại.

- **Spot / Futures Grid**
  - lower = `P5`, upper = `P95` (giá đóng cửa 30 ngày).
  - step% = `max(10 × fee_rt, 0.5%)`.
  - levels = clamp(floor(ln(upper/lower) / ln(1+step%)) + 1, 2, 200).
  - Spacing: arithmetic nếu `(upper−lower)/lower < 20%`, ngược lại geometric.
  - stop = lower × (1 − max(3%, σ)). Max loss = vốn bot × d.
  - Riêng futures:
    - Hướng: `trend > 0.5` → long, `< −0.5` → short, còn lại neutral.
    - Đòn bẩy = 1× nếu quy tắc loại trừ đòn bẩy đã kích hoạt; ngược lại min(2×, account cap, `maxLeverage`).
    - Loại bộ tham số nếu giá thanh lý SoDEX preview nằm trong phạm vi 2× khoảng cách tới stop.
- **Spot / Futures DCA**
  - Mức giảm tới safety đầu tiên = max(1%, trung vị |return theo ngày| 30 ngày).
  - Step multiplier 1.2, size multiplier 1.5 *(chỉnh được)*.
  - Số safety order = n nhỏ nhất (≤ 20) sao cho tổng mức giảm ≥ drawdown 30 ngày lớn nhất của market.
  - Base = safety = vốn bot / (1 + Σ 1.5^i, i = 0..n−1).
  - Take profit = max(1.2%, 7 × fee_rt).
  - Riêng futures: stop loss = mức giảm luỹ kế của safety cuối + 2%, phải nằm trước giá thanh lý.
- **Recurring Buy**
  - Hằng tuần, N = 20 lần *(chỉnh được)*, mỗi lần = vốn bot / N.
  - Thời điểm = khung giờ thứ Hai mà người dùng ít giao dịch nhất (mặc định thứ Hai 09:00 giờ địa phương).
- **Rebalancing**
  - Tỷ trọng ∝ tỷ lệ volume lịch sử của người dùng trên các tài sản đã chọn; stablecoin tối thiểu 20%.
  - Ngưỡng lệch = 5% nếu σ trung bình < 3%, ngược lại 8%.
  - Mỗi lần rebalance giao dịch tối đa 25% giá trị danh mục.
- **Funding Arbitrage**
  - Chia vốn 50/50; đòn bẩy chân perp 1×.
  - Vào lệnh khi `fundingAvg7d ≥ 0.005%`; thoát sau 3 kỳ funding ≤ 0.
  - Chênh lệch giữa hai chân tối đa 0.5%; giữ margin ratio ≥ 30%.
- **TWAP** (chỉ ở màn tạo bot)
  - Mỗi lát ≤ 0.1% trung vị volume 5 phút của market.
  - Thời lượng = ceil(số lát × 5 phút), trong khoảng 5 phút – 24 h.
  - Trượt giá tối đa mỗi lát = max(0.1%, 2 × spread trung vị).

### 10.6 Kết quả trả về và test
- Output: `{ id, strategy, market, values, reasons[3], basis, computedAt, inputsVersion }`.
- Lý do sinh từ template gắn với quy tắc đã kích hoạt, điền số thật. Ví dụ: "Range covers 90% of {market} daily closes over the last 30 days."
- Không bao giờ trả về lợi nhuận hay lãi suất dự kiến.
- Golden-file test trong `packages/shared/src/reco/__tests__`:
  - Tối thiểu một fixture cho mỗi tổ hợp goal × (người mới / người có kinh nghiệm).
  - Các ca biên: không có ứng viên; mọi market bị loại; vốn dưới mọi mức tối thiểu.
  - Cùng đầu vào phải ra output giống hệt từng byte.
