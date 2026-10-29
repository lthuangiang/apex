# DRIFT — Spec từng chiến lược

> Nguồn: artboard "Bot & settings spec" mục 4 và các artboard Create · <Strategy>. File này là bản dùng để code; canvas chỉ để đối chiếu giao diện.

## Quy ước chung cho mọi chiến lược
- **Label, help text, error message** trong bảng là câu chữ UI (tiếng Anh), chép nguyên văn vào `messages/en.json`.
- **Default** là giá trị tham khảo. Khi dùng AI parameters, giá trị thật lấy từ `docs/RECO_ENGINE.md` mục 10.5. Khi người dùng bấm `Clear parameters`, field để trống và giá trị AI chỉ hiện làm placeholder `e.g. …`.
- Cột **Step** cho biết field thuộc nhóm nào trong panel tham số: `2` = Market (& leverage), `3` = Parameters, `4` = Risk & exits.
- Khoảng giá trị phụ thuộc SoDEX (min size, tick, lot, max leverage) **đọc từ market info**, không hard-code.
- Mỗi chiến lược có một zod schema trong `packages/strategies/<key>/schema.ts`, dùng chung cho web, API, engine, backtest.
- Mỗi chiến lược có một hàm thuần `step(config, state, event) → { actions, state }` trong `packages/strategies/<key>/index.ts`. `event` gồm: `tick` (giá mới), `fill`, `orderAck`, `orderReject`, `timer`, `fundingPaid`. `actions` gồm: `place`, `cancel`, `replace`, `pause(reason)`, `stop(reason)`.
- Mọi lệnh có `clOrdID` tất định (`docs/ARCHITECTURE.md` mục 3.3) và field `builder` theo `docs/SODEX.md` mục 5.3.
- Đòn bẩy của bot perp luôn ≤ min(cap của account, `maxLeverage` của market).

---

## S1. Spot Grid (`spot_grid`) · Spot · builder fee: chỉ lệnh bán

**Cách chạy:**
1. Tính các mức giá từ lower → upper theo spacing (arithmetic: cách đều theo giá; geometric: cách đều theo %), làm tròn theo tick.
2. Lúc start: đặt lệnh mua limit ở mọi mức dưới giá hiện tại, lệnh bán limit ở mọi mức trên giá hiện tại (phần tài sản cơ sở để bán được mua bằng một lệnh market lúc start **[confirm cách khởi tạo]**).
3. Khi một lệnh mua ở mức *i* khớp → đặt lệnh bán ở mức *i+1*. Khi lệnh bán ở mức *i* khớp → đặt lệnh mua ở mức *i−1*.
4. Giá ra ngoài range: không đặt lệnh mới, bot vẫn `running` với cờ `needs_attention`.
5. Giá chạm stop → `stop(STOP_LOSS)`. Tổng lợi nhuận chạm take profit → `stop(TAKE_PROFIT)`. Lỗ chạm max loss → `pause(BOT_MAX_LOSS)`.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Market | ADA/USDT | Any SoDEX spot market | Required. |
| 3 | Lower price | −9% from last | > 0, < upper, on tick | Must be lower than the upper price. |
| 3 | Upper price | +10% from last | > lower, on tick | Must be higher than the lower price. |
| 3 | Grid levels | 10 | 2–200; step must exceed round-trip fees | Step smaller than round-trip fees. |
| 3 | Spacing | Arithmetic | Arithmetic or Geometric | — |
| 3 | Investment | — | ≥ levels × min order size; ≤ free Spot balance | More than your available Spot balance. |
| 3 | Start when price crosses | empty | Optional; inside the range | Must be inside the grid range. |
| 4 | Stop if price falls below | lower − 6% | Optional; < lower | Must be below the lower price. |
| 4 | Take profit at total profit | empty | Optional; > 0% | Must be above 0. |
| 4 | Max loss for this bot | 10% of investment | > 0; < investment | Must be below the investment. |
| 4 | When the bot stops | Keep base asset | Keep base asset / Sell at market | — |

Preview: order size per level, step %, số lệnh lúc start, round-trip fees. Backtest: net result, fees, max drawdown, fills · time in range.

---

## S2. Futures Grid (`futures_grid`) · Perps · builder fee: cả hai chiều

**Cách chạy:** như Spot Grid, nhưng trên perp:
- **Neutral:** bắt đầu không có vị thế; mua dưới giá, bán trên giá.
- **Long:** mở sẵn vị thế long tương ứng các mức trên giá hiện tại, rồi chạy grid.
- **Short:** ngược lại với Long.
- Funding được ghi vào PnL của bot. Giá thanh lý lấy từ SoDEX preview, không tự tính.
- Khi dừng: huỷ mọi lệnh rồi `Close position at market` (reduce-only) hoặc `Keep position` theo cấu hình.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Contract | BTC-PERP | Any SoDEX perp | Required. |
| 2 | Leverage | 1× | 1× to min(account cap 3×, SoDEX market max) | Above your 3.0× account cap. |
| 2 | Margin mode | Cross | Cross or Isolated **[confirm SoDEX support]** | — |
| 3 | Direction | Neutral | Neutral / Long / Short | — |
| 3 | Lower price | −8% from mark | > 0, < upper, on tick | Must be lower than the upper price. |
| 3 | Upper price | +7% from mark | > lower, on tick | Must be higher than the lower price. |
| 3 | Grid levels | 20 | 2–200 | Step smaller than round-trip fees. |
| 3 | Spacing | Arithmetic | Arithmetic or Geometric | — |
| 3 | Margin | — | ≤ free Perps balance | More than your available Perps balance. |
| 3 | Start when price crosses | empty | Optional | Must be inside the grid range. |
| 4 | Stop if price falls below | lower − 3% | Below lower; must be before liquidation | Must be closer than liquidation. |
| 4 | Stop if price rises above | empty | Optional; above upper | Must be above the upper price. |
| 4 | Max loss for this bot | 10% of margin | < margin | Must be below the margin. |
| 4 | When the bot stops | Close position at market | Close at market / Keep position | — |

Preview: vị thế khi khớp hết, liquidation (từ SoDEX), step %, funding hiện tại. Backtest: net result, fees + funding, max drawdown, fills · time in range.

---

## S3. Spot DCA (`spot_dca`) · Spot · builder fee: chỉ lệnh bán

**Cách chạy (mỗi chu kỳ):**
1. Mua base order (market) khi start, hoặc khi giá ≤ mức người dùng chọn.
2. Đặt sẵn các safety order limit bên dưới. Mức thứ *k* cách giá base `d₁ × (1 + m + … + m^(k−1))`, với d₁ = mức giảm đầu, m = step multiplier. Khối lượng safety thứ *k* = `safety × v^(k−1)`, với v = size multiplier.
3. Đặt lệnh take profit = giá mua trung bình × (1 + TP%), cập nhật lại sau mỗi lần safety khớp.
4. Take profit khớp → kết thúc chu kỳ, huỷ các safety còn lại, bắt đầu chu kỳ mới (nếu chưa đạt max cycles).
5. Stop loss (nếu đặt) tính từ giá trung bình → bán hết, `stop(STOP_LOSS)`.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Market | ETH/USDT | Spot market | Required. |
| 3 | Base order | 50 | ≥ SoDEX min size | Below SoDEX minimum order size. |
| 3 | Safety order | 50 | ≥ SoDEX min size | Below SoDEX minimum order size. |
| 3 | Max safety orders | 5 | 0–20 | Allowed 0–20. |
| 3 | Price drop to first safety order | 2% | 0.1–20% | Allowed 0.1–20%. |
| 3 | Step multiplier | 1.2× | 1–3× | Allowed 1–3×. |
| 3 | Size multiplier | 1.5× | 1–3× | Allowed 1–3×. |
| 3 | Take profit | 1.5% | > round-trip fees | Must be above round-trip fees. |
| 3 | Start | Immediately | Immediately / When price ≤ level | — |
| 4 | Stop loss | empty | Optional; larger than last safety drop | Must be larger than the last safety order drop. |
| 4 | Max cycles | unlimited | Optional; ≥ 1 | Must be 1 or more. |
| 4 | Max loss for this bot | — | < max capital used | Must be below max capital used. |

Preview: vốn tối đa dùng, mức giảm được bao phủ, số lệnh lúc start, số safety order. Backtest: net result, completed cycles, max drawdown, max safety orders used.

---

## S4. Futures DCA (`futures_dca`) · Perps · builder fee: cả hai chiều

**Cách chạy:** như Spot DCA trên perp. Với Long thì safety đặt khi giá giảm; với Short thì khi giá tăng. Stop loss **bắt buộc**, tính từ giá vào trung bình, và phải nằm trước giá thanh lý (SoDEX preview). Khi dừng thì đóng vị thế bằng lệnh reduce-only.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Contract | BTC-PERP | Perp | Required. |
| 2 | Leverage | 1× | 1× to min(account cap 3×, SoDEX market max) | Above your 3.0× account cap. |
| 2 | Margin mode | Cross | Cross or Isolated **[confirm]** | — |
| 3 | Direction | Long | Long / Short | — |
| 3 | Base / safety order | 100 / 100 | Margin; ≥ min size at leverage | Below SoDEX minimum order size. |
| 3 | Max safety orders | 4 | 0–20 | Allowed 0–20. |
| 3 | Price move to first safety | 1.5% | 0.1–20% | Allowed 0.1–20%. |
| 3 | Step / size multiplier | 1.3× / 1.5× | 1–3× | Allowed 1–3×. |
| 3 | Take profit | 1.2% | > round-trip fees | Must be above round-trip fees. |
| 4 | Stop loss | 12% | Required; must be before liquidation | Must be closer than liquidation. |
| 4 | Max loss for this bot | — | < max margin used | Must be below max margin used. |

Preview: margin tối đa dùng, liquidation khi đủ size (từ SoDEX), mức biến động được bao phủ, funding. Backtest: net result, completed cycles, max drawdown, stop loss hits.

---

## S5. Recurring Buy (`recurring_buy`) · Spot · builder fee: không (chỉ mua)

**Cách chạy:** engine gửi `timer` mỗi vòng; bot chỉ hành động khi tới lịch (múi giờ người dùng, DEC-61). Mỗi lần: kiểm tra giá (nếu có "Skip buys above price") và số dư, rồi đặt lệnh market mua đúng số tiền. Lần bị bỏ qua được ghi log, **không** mua bù sau. Hết ngân sách hoặc đủ số lần → `stop(BUDGET_DONE)`. Bot không bao giờ bán.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Market | BTC/USDT | Spot | Required. |
| 3 | Amount per buy | 150 | ≥ SoDEX min size | Below SoDEX minimum order size. |
| 3 | Frequency | Weekly | Daily / Weekly / Monthly | — |
| 3 | Day and time | Mon 09:00 | In user time zone | — |
| 3 | Ends | After budget | Never / After budget / After N buys | — |
| 3 | Total budget | 3,000 | ≥ one buy | Must be at least one buy. |
| 4 | Skip buys above price | empty | Optional; skipped buys are not made up | Must be above 0. |
| 4 | If balance is too low | Skip and notify | Skip and notify / Pause | — |

Preview: số lần × số tiền, lần mua tiếp theo, ngày kết thúc. Backtest: buys made, avg buy price, value vs cost, skipped buys.

---

## S6. Rebalancing (`rebalancing`) · Spot · builder fee: chỉ lệnh bán

**Cách chạy:**
1. Lúc start: mua từng tài sản tới tỷ trọng mục tiêu bằng số vốn đã cấp.
2. Cứ 5 phút **[confirm]** tính tỷ trọng hiện tại theo giá quote asset.
3. Kiểm tra điều kiện rebalance: với chế độ threshold, có tài sản lệch quá ngưỡng; với chế độ schedule, tới giờ hẹn.
4. Khi rebalance: bán tài sản thừa, mua tài sản thiếu bằng lệnh limit sát giá **[confirm loại lệnh]**. Mỗi lần giao dịch không quá "Max trade per rebalance".
5. Giá trị danh mục dưới ngưỡng → `stop(STOP_LOSS)`. Đạt take profit → `stop(TAKE_PROFIT)`. Khi dừng, tài sản được giữ nguyên.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Quote asset | USDC | USDC / USDT | — |
| 3 | Assets and weights | BTC 50 · ETH 30 · USDC 20 | 2–10 assets; total 100% | Weights must add up to 100%. |
| 3 | Rebalance when | Threshold | Threshold / Schedule | — |
| 3 | Threshold | 5% | 1–50%. Chỉ hiện khi Rebalance when = Threshold | Allowed 1–50%. |
| 3 | Rebalance every | Weekly | Daily / Weekly / Monthly. Chỉ hiện khi Rebalance when = Schedule. "Checked at 00:00 in your time zone"; Weekly = thứ Hai, Monthly = ngày 1 (DEC-67) | — |
| 3 | Investment | — | ≤ free Spot balance | More than your available Spot balance. |
| 4 | Max trade per rebalance | 25% | 1–100% of value | Allowed 1–100%. |
| 4 | Stop if value below | empty | Optional; < investment | Must be below the investment. |
| 4 | Take profit | empty | Optional | Must be above 0. |

Preview: số tài sản, số lệnh lúc start, tần suất kiểm tra, ngưỡng. Backtest: net result vs buy-and-hold, rebalances, fees, max drawdown.

---

## S7. Funding Arbitrage (`funding_arb`) · Spot + Perps · builder fee: chân perp cả hai chiều, chân spot khi bán

**Cách chạy:**
1. Chờ tới khi funding trung bình 7 ngày ≥ ngưỡng vào lệnh.
2. Mua spot và short perp **cùng khối lượng tài sản**, mỗi chân dùng một nửa vốn. Đặt hai chân gần như đồng thời; nếu một chân lỗi thì đóng chân còn lại và `pause(ORDER_REJECTED)`.
3. Mỗi kỳ funding: ghi funding nhận được.
4. Chênh lệch khối lượng hoặc giá giữa hai chân vượt ngưỡng → cân lại.
5. Margin ratio dưới ngưỡng → chuyển margin từ chân spot **[confirm SoDEX có cho chuyển nội bộ giữa engine không]**.
6. Funding ≤ ngưỡng thoát trong 3 kỳ liên tiếp → đóng cả hai chân, quay về trạng thái chờ.
7. Lỗ chạm max loss → đóng cả hai chân và `stop`.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Asset | BTC | Assets with both spot and perp | Required. |
| 2 | Perp leg leverage | 1× | 1–3× | Above your 3.0× account cap. |
| 3 | Investment | — | Split 50/50 across engines; both balances checked | Needs balance on both engines. |
| 3 | Enter when funding ≥ | 0.005% / interval | > 0 **[confirm interval]** | Must be above 0. |
| 3 | Exit when funding ≤ | 0% | < entry; for 3 periods | Must be below the entry level. |
| 3 | Max price gap between legs | 0.5% | 0.1–5% | Allowed 0.1–5%. |
| 4 | Keep perp margin ratio above | 30% | 10–90% | Allowed 10–90%. |
| 4 | Max loss for this bot | 2% of investment | < investment | Must be below the investment. |

Preview: khối lượng chân spot, chân perp, phơi nhiễm ròng ≈ 0, funding trung bình 7 ngày. Backtest: funding collected, fees, periods in position, max leg gap.

---

## S8. TWAP (`twap`) · Spot hoặc Perps · builder fee: theo engine

**Cách chạy:** chia tổng khối lượng thành N lát bằng nhau; mỗi `duration / N` đặt một lệnh limit ở giá tốt nhất phía đối diện. Lát nào vượt price limit hoặc max slippage thì bỏ qua, rồi tuỳ cấu hình: dồn vào cuối, hoặc để không khớp. Hết lát hoặc hết thời gian → `stop(BUDGET_DONE)`. Với perps có tuỳ chọn reduce-only. Nếu SoDEX có TWAP native cho perps thì **[confirm]** có dùng thay không.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Market | BTC/USDT | Spot or perp | Required. |
| 3 | Side | Buy | Buy / Sell | — |
| 3 | Total size | — | ≤ available balance or position | More than your available balance. |
| 3 | Duration | 4 h | 5 min – 24 h | Allowed 5 min – 24 h. |
| 3 | Slices | 48 | Each slice ≥ min size | Slice below SoDEX minimum order size. |
| 3 | Price limit | empty | Optional | Must be above 0. |
| 3 | Reduce-only (perps) | Off | Off / On | — |
| 4 | Max slippage per slice | 0.3% | 0.05–5% | Allowed 0.05–5%. |
| 4 | If slices are skipped | Add to the end | Add to end / Leave unfilled | — |

Preview: khối lượng mỗi lát, khoảng cách, thời điểm kết thúc, loại lệnh. Backtest: avg fill vs arrival price, slices filled, fees, worst slice slippage.

---

## S9. Volume Maker (`volume_maker`) · Perps · **khoá bằng `VOLUME_MAKER_ENABLED`**

Hành vi và quy tắc bắt buộc ở `docs/VOLUME_MAKER.md` mục 17. Field:

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Contract | BTC-PERP | BTC-PERP or ETH-PERP only | Required. |
| 2 | Leverage | 1× | Fixed | Volume Maker runs at 1×. |
| 3 | Volume target | 1,000,000 | > 0; bot stops when reached | Must be above 0. |
| 3 | Order size per side | 500 | ≥ SoDEX min size; post-only | Below SoDEX minimum order size. |
| 3 | Distance from mid | 1.0 bp | ≥ 1 tick | Must be at least one tick. |
| 3 | Max inventory | 2,000 | > order size | Must be above the order size. |
| 3 | Refresh every | 3 s | 2–60 s | Allowed 2–60 s. |
| 3 | Run until | End of current season | Season end / date / target or budget | — |
| 4 | Cost budget | 300 | > 0; warns at 80%, stops at 100% | Must be above 0. |
| 4 | Inventory loss stop | 60 | < budget; closes reduce-only | Must be below the budget. |
| 4 | When the bot stops | Close inventory | Close (reduce-only) / Keep position | — |

Preview: chi phí ước tính trên mỗi 1 triệu USD, số báo giá trên sổ, tỷ lệ maker, trạng thái self-trade guard. Backtest: volume made, net cost (kèm chi phí trên mỗi 1 triệu USD), maker share, max inventory reached.
