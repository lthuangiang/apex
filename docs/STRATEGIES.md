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
1. Lúc start: mua từng tài sản tới tỷ trọng mục tiêu bằng số vốn đã cấp, theo "Initial buy" (DEC-222):
   - **All now** (mặc định; config thiếu field cũng là All now): mua một lần như rebalance thường.
   - **Over N hours** (N = 2–72): N phần, mỗi giờ một phần, tính từ lúc có đủ giá. Phần k chỉ mua, đưa mỗi tài sản tới k/N giá trị mục tiêu (luỹ kế), vẫn chịu "Max trade per rebalance". Phần nào dưới min size của SoDEX thì phần đó không có lệnh; vì mục tiêu là luỹ kế nên phần sau tự bù. Trong lúc mua dần không rebalance theo ngưỡng / lịch; xong phần N thì chạy rebalance thường. Field khoá sau khi tạo bot. Trading Agent hiện "Initial buy: {done} of {total} parts".
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
| 3 | Initial buy | All now | All now / Over N hours. "Buy all at once, or spread over a few hours." Khoá sau khi tạo | — |
| 3 | Spread over | — | 2–72 hours. Chỉ hiện khi Initial buy = Over N hours. "Equal parts, one each hour. Allowed 2–72 hours." | Allowed 2–72 hours. |
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
| 2 | Asset | — | Assets with both spot and perp; xếp theo funding đã trả (DEC-160): tài sản thu đủ phí khứ hồi trong ≤ 72 h và dương ≥ 90% của 21 kỳ lên đầu, mỗi dòng ghi funding TB 7 ngày và số giờ thu đủ phí | Required. |
| 2 | Perp leg leverage | 1× | 1–3× | Above your 3.0× account cap. |
| 3 | Investment | — | Split 50/50 across engines; both balances checked | Needs balance on both engines. |
| 3 | Enter when funding ≥ | 0.0018% mỗi kỳ (= phí khứ hồi maker 0.124% / 72 kỳ 1 giờ, DEC-160) | > 0; % mỗi kỳ funding của market (mọi perp SoDEX hiện trả mỗi giờ) | Must be above 0. |
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

## S9. Volume Maker (`volume_maker`) · Perps · **chỉ cho tài khoản được team bật (DEC-80)**

Hành vi và quy tắc bắt buộc ở `docs/VOLUME_MAKER.md` mục 17. Field:

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Contract | — | Any SoDEX perp (DEC-157) | Required. |
| Amount | Order size per side | 500 | ≥ SoDEX min size; post-only | Below SoDEX minimum order size. |
| Amount | Leverage | 5× | 1–40× and ≤ min(account cap, SoDEX market max) (DEC-99) | Allowed 1–40×. |
| 4 | Stop if I lose (`costBudget`) | 300 | > 0; fees + realized + unrealized loss; warns at 80%, stops at 100% | Must be above 0. |
| 4 | Stop after trading (`volumeTarget`) | empty | Optional, > 0; bot stops when reached | Must be above 0. |
| Adv | Max open position (`maxInventory`) | empty = 2 × order size (DEC-100) | > order size | Must be above the order size. |
| Adv | Quote distance | 1.0 bp | ≥ 1 tick | Must be at least one tick. |
| Adv | Refresh every | 3 s | 2–60 s | Allowed 2–60 s. |
| Adv | Position loss limit | empty | Optional, < budget; closes reduce-only | Must be below the budget. |
| Adv | Run until | Target or budget reached | Target or budget / season end / date | — |
| Adv | When the bot stops | Close inventory | Close (reduce-only) / Keep position | — |

Form gọn (DEC-99): người dùng chỉ cần chọn market, order size, leverage và Stop if I lose; mọi field còn lại có mặc định trong schema. Preview: Balance needed (= max open position / leverage, cùng công thức `requirementOf`), Biggest position, Stops if you lose. Không ước tính chi phí theo khối lượng. Trading Agent hiện sổ lệnh trực tiếp, đánh dấu lệnh của bot là "YOU". Backtest: volume made, net cost (kèm chi phí trên mỗi 1 triệu USD), maker share, max inventory reached.

## S10. Volume Farm (`volume_farm`) · Perps · builder fee: mọi lần khớp · **chỉ cho tài khoản được team bật (DEC-80)**

Quy tắc của Market Making (VOLUME_MAKER.md mục 17.3) không áp dụng cho chiến lược này (DEC-101). Tên hiển thị: "Volume Farming" → "Scalp Farming" (DEC-102) → "Volume Builder" (DEC-116) → "Volume Farm" (DEC-120); strategy id giữ `volume_farm`. Logic là Volume Farm gốc (FarmMicro của apex, DEC-80): mỗi lượt một vị thế, vào post-only trong spread theo tín hiệu nến 1 phút + sổ lệnh; tồn kho ròng vượt một lệnh lớn nhất thì đi ngược lượt trước; cỡ lệnh và thời gian giữ ngẫu nhiên trong khoảng. Thoát theo thứ tự: SL % (market) → lãi trước phí ≥ max(TP USDC, 1.5 × phí khứ hồi) → max hold → sau 10 s lãi ≥ 3 × phí khứ hồi của lượt → hết thời gian giữ ngẫu nhiên. Early exit (10 s, `earlyProfitFees` 3, DEC-130) là mặc định của schema, không hiện trên form; config cũ có `earlyProfitUsd` thì ngưỡng = max(mức USDC đó, 3 × phí). Khi bật lệnh taker (mặc định tắt từ DEC-130): sau 3 lần post-only không khớp thì dùng market (1–10). **Stop loss trên SoDEX** (DEC-118, DEC-125): lệnh vào khớp là đặt stop gốc trên sàn (mark price, đóng cả vị thế) ở SL của bot lùi thêm 0.1% giá vào. Dời lên theo nấc, theo lãi lớn nhất đã đạt, tính bằng bội số G = khoảng hoà vốn (phí vào + phí taker ra + 0.01% trượt giá): 3 G → điểm vào lệnh; 4 G → hoà vốn; 6 G → khoá lời, bám giá tốt nhất cách 2 G, không thấp hơn hoà vốn. Không bao giờ lùi lại; mỗi nấc ghi Decisions một lần; SoDEX tự huỷ stop khi vị thế đóng. Decisions "Enter long/short" ghi giá đặt lệnh, "Closed" ghi giá vào → giá ra. Phần scalp theo ATR (DEC-102), taker only (DEC-116) và pause khi lệnh vào market bị từ chối (DEC-117) đã bỏ (DEC-120). **Review this run** (DEC-131): trên trang bot, chạy lại lối thoát trên lệnh vào thật với 135 bộ tham số; chỉ đề xuất khi tốt hơn rõ ràng (khoảng tin cậy 95%), "Use these settings" tạo version mới nguồn `ai`.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Markets (`markets`) | Mọi market của trader mà SoDEX có | 1–20 market Perps, không trùng; người dùng bỏ tick được (DEC-TBD-copy-pick-markets); khoá sau khi tạo; `maxExposure` và `maxLoss` tính trên tổng. Trader giao dịch ở market không có trong bot → không bao giờ mở lệnh, ghi "Skipped" (`market_off`, không gửi tin) | Pick at least one market. / Up to 20 markets. / Each market once. |
| 2 | Leverage | 5× (DEC-103) | 1× to the SoDEX market max | Above the SoDEX maximum of N× for this market. |
| 3 | Order size from / to | 200 / 500 (DEC-103) | Position value per trade, random in range; min ≥ SoDEX min size | Below SoDEX minimum order size. / Must be at least the minimum size. |
| 3 | Hold at least / at most | 180 s / 300 s | 10–3600 s, random in range; at most = hard time stop | Allowed 10–3600 s. / Must be at least the minimum hold. |
| 3 | Reverse the signal | Off | Không bao giờ vào ngược xu hướng 5 phút, kể cả sau khi đảo (DEC-158) | — |
| 3 | Only trade sideways | Off | Chỉ vào lượt mới khi regime 5 phút là SIDEWAY; lượt đang mở vẫn thoát như thường (DEC-158) | — |
| 3 | Stop loss on SoDEX | On | Stop gốc trên sàn; dời về hoà vốn khi lãi đủ | — |
| 4 | Take profit (`tpUsd`) | 0.5 USDC | Lãi trước phí; không dưới 1.5 × phí khứ hồi | Must be above 0. |
| 4 | Stop loss (`slMarginPct`) | 25% of margin | 1–90% margin như SoDEX TP/SL (% giá = % margin ÷ đòn bẩy); market; hint ≈ % giá và USDC | Allowed 1–90%. |
| 4 | Max loss for this bot | — | Net loss (realized + fees + funding); stops and closes | Must be above 0. |
| 4 | Stop at volume | empty | Optional | Must be above 0. |
| Adv | Wait between trades | 30 s | 0–3600 s | — |
| Adv | Max spread | 10 bp | Skips entries above | Allowed 0.1–500 bp. |
| Adv | Use taker orders / Misses before taker | Off / 3 | 1–10 | Allowed 1–10. |

Preview: không có. Backtest: 5D / 30D trên nến 1 phút (BACKTEST.md mục 11.2). Agent: Decisions "Enter long/short", "Skipped entry" (chỉ khi lý do đổi), "Stop loss set on SoDEX", "Stop loss on SoDEX moved to break-even", "Closed long/short" kèm lãi ròng sau phí.

## S11. AI Adaptive DCA (`adaptive_dca`) · Perps · builder fee: mọi lần khớp · **thử nghiệm, chỉ cho tài khoản được bật AI Desk (DEC-107)**

Quy tắc đầy đủ (vào lệnh, Continue / Reduce / Exit, hoà vốn, thứ tự ưu tiên) ở `docs/AI_ADAPTIVE_DCA.md` mục 3. Vốn cần = Max position / đòn bẩy. Reduce: ngừng thêm, take profit về giá hoà vốn của chu kỳ (gồm phí, funding, phí lệnh đóng). Exit: regime ngược liên tục ≥ 4 giờ. Max loss và hard stop luôn ưu tiên.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Markets (`markets`) | Mọi market của trader mà SoDEX có | 1–20 market Perps, không trùng; khoá sau khi tạo; `maxExposure` và `maxLoss` tính trên tổng | Pick at least one market. / Up to 20 markets. / Each market once. |
| 2 | Direction | Long | Long / Short | — |
| 3 | First order / Extra buy size | 100 / 100 | Position value, leverage included; ≥ SoDEX min size | Below SoDEX minimum order size. |
| 3 | Leverage | 2× | 1× to the SoDEX market max | Above the SoDEX maximum of N× for this market. |
| 3 | Leverage per market (`leverageByMarket`) | — (dùng `leverage`) | Tuỳ chọn, `{market: int}`, key ⊆ `markets`; mỗi market trong [1, min(SoDEX max, 5, trần Risk Center)]; khoá sau khi tạo (form Edit không gửi thì giữ nguyên). Engine đặt đòn bẩy theo từng market (DEC-TBD-copy-pick-markets) | Market is not in this copy bot. / Up to 5× when you copy. |
| 3 | Max extra buys / Spacing | 4 / 2× ATR | 1–10 / 0.5–10× ATR 5 phút đã đóng, đo lại mỗi lần đặt | Allowed 1–10. / Allowed 0.5–10×. |
| 4 | Take profit / Hard stop | 1.5% / 8% | 0.2–20% / 1–50% | Allowed 0.2–20%. / Allowed 1–50%. |
| 4 | Max position (`maxExposure`) | 1,000 | Giá trị danh nghĩa theo giá vốn, ≥ first order; chạm trần thì không thêm lệnh | Must be at least the first order. |
| 4 | Max loss for this bot | 150 | Net loss; stops and closes | Must be above 0. |
| Adv | Size multiplier | 1.5× | 1–2× | Allowed 1–2×. |
| Adv | Entry RSI | 45 | 10–90 | Allowed 10–90. |
| Adv | Wait after an exit | 30 min | 0–1440 min | Allowed 0–1440 min. |
| Adv | Margin mode | Isolated | Cross / Isolated | — |

Agent: thẻ AI Adaptive DCA (regime, quyết định gần nhất, ATR, RSI, số lệnh thêm, vị thế / trần, chu kỳ chốt lãi, số lần Exit sớm); Decisions "Cycle N started", "Extra buy k filled", "Holding", "Reduce", "Continue", "Exit", "Hard stop", "Cycle N took profit / closed". Backtest: 5D / 30D trên nến 1 phút.

## S12. Copy Trade (`copy_trade`) · Perps · builder fee: mọi lần khớp · **thử nghiệm, chỉ cho tài khoản được bật AI Desk (DEC-161)**

Một bot copy **một** ví (SoDEX hoặc Hyperliquid) trên **nhiều** market Perps của SoDEX (`markets`, DEC-163; config cũ có `market` vẫn đọc được). Chỉ copy vị thế ví đó mở sau khi bot start. Mở / tăng: IOC limit tại giá fill của ví ± Max price move, giá chạy quá thì bỏ qua. Giảm / đóng: market reduce-only, luôn thực hiện. Tăng / giảm theo tỷ lệ vị thế của ví. Vốn cần = Max position / đòn bẩy. Không chạy chung market với bot thật khác trên cùng account. Chi tiết: DEC-161.

| Step | Field | Default | Rule / help text | Error message |
|---|---|---|---|---|
| 2 | Wallet to copy (`leaderAddress`) | — | `0x` + 40 hex; khoá sau khi tạo; không phải ví của chính mình | Enter a wallet address (0x…, 42 characters). / You can't copy your own wallet. |
| 2 | Markets (`markets`) | Mọi market của trader mà SoDEX có | 1–20 market Perps, không trùng; khoá sau khi tạo; `maxExposure` và `maxLoss` tính trên tổng | Pick at least one market. / Up to 20 markets. / Each market once. |
| 2 | Direction | Follow | Follow / Inverse | — |
| 3 | Copy size (`sizing`) | Fixed amount | Fixed amount / Share of wallet | — |
| 3 | Amount per position (`fixedNotional`) | 100 | Khi Fixed; ≤ Max per order | Required. / Must not exceed the max per trade. |
| 3 | Share of the wallet's size (`ratioPct`) | — | Khi Share; 0.01–100% | Allowed 0.01–100%. |
| 3 | Leverage | 2× | 1× to the SoDEX market max | Above the SoDEX maximum of N× for this market. |
| 4 | Max per order (`maxNotionalPerTrade`) | 200 | Trần một lệnh mở / tăng | Must be above 0. |
| 4 | Max position (`maxExposure`) | 1,000 | ≥ Max per order | Must be at least the max per trade. |
| 4 | Stop loss / Take profit | — | Tuỳ chọn; 0.5–90% / 0.5–500% từ giá vốn | Allowed 0.5–90%. / Allowed 0.5–500%. |
| 4 | Max loss for this bot | 150 | Net loss; stops and closes | Must be above 0. |
| Adv | Max price move (`maxSlippagePct`) | 0.3% | 0.05–2% | Allowed 0.05–2%. |
| Adv | Margin mode | Isolated | Cross / Isolated | — |

Decisions: "Copy" (leader opened / flipped / added / cut; size cut by liquidity), "Skipped" (late, price moved, no fill, below min size, rejected, not enough liquidity, trader too fast to copy, market not in the bot: "Not copied: this market isn't in your copy bot."), "Catch up", "Stop loss", "Take profit", "Paused", "Copy stopped".

Hạn mức tín hiệu (DEC-163 mục 5, 9; DEC-169): tín hiệu mở / tăng có thể kèm `allowance` (USD) cho từng bot do marketdata phân bổ: tổng mọi bot copy cùng leader × market ≤ 50% độ sâu sổ SoDEX phía bot sẽ ăn, trong khoảng Max price move nhỏ nhất; trader không còn đạt minHoldFilter → mọi hạn mức 0. Giảm / đóng không bị hạn mức.

### S12.1 Copy Trading v1: luồng người mới (DEC-163, thay một phần DEC-161)

Thiết kế: canvas "AI Desk redesign", hàng "Copy Trading v1" (artboard `Leaders`, `WalletStats`, `CopyBot`, `CopyReview`, `WhaleWatch`). Câu chữ chép theo artboard.

- **Leader:** chọn từ Find traders (Hyperliquid), không dán địa chỉ. Một bot = một trader × **nhiều market**: mặc định mọi market của trader mà SoDEX Perps có. Market trùng bot thật khác cùng account → bỏ market đó, báo ở bước Review (không chặn start). Market mới sau khi start → không tự thêm, báo ở Following.
- **Bước Budget and safety** chỉ hỏi Budget và mức an toàn; form điền field S12 như sau (`sizing = fixed`):

| Mức | Leverage | `fixedNotional` = `maxNotionalPerTrade` | `stopLossPct` | `maxLoss` |
|---|---|---|---|---|
| Careful | 1× | 25% × `maxExposure` | 5% | 10% × budget |
| Balanced (mặc định) | 2× | 25% × `maxExposure` | 10% | 20% × budget |
| Bold | 3× | 40% × `maxExposure` | 15% | 30% × budget |

  `maxExposure` = budget × leverage. Advanced: Direction, Max price move (`maxSlippagePct`), Margin mode, Take profit.

  **Chọn market và đòn bẩy theo market (DEC-TBD-copy-pick-markets, artboard `CopyMarkets`):** mặc định tick mọi market; bỏ tick được, tối thiểu 1. Đòn bẩy mặc định theo mức an toàn, hạ về trần ở market SoDEX cho thấp hơn (không bỏ market); "Set per market" mở −/+ từng market trong [1, min(SoDEX max, 5, trần Risk Center)]. Đòn bẩy không đổi cỡ mỗi lệnh (`fixedNotional` như bảng trên, nhưng không vượt `maxExposure`). **`maxExposure` = budget × đòn bẩy THẤP NHẤT trong các market đã chọn** (PM chốt, thay quy tắc 5 của CopyMarkets.md): ký quỹ không bao giờ vượt budget; vốn yêu cầu = budget. Mỗi dòng hiện ký quỹ mỗi vị thế (= cỡ lệnh ÷ đòn bẩy), khoảng cách thanh lý ước tính (Isolated, chiều xấu hơn của long / short; Cross hoặc thiếu bậc margin → "Not available") và số episode đã đóng của trader ở market đó trong 30 ngày (`LeaderStats.episodesByMarket`; bản ghi cũ chưa có → "Not available").
- **Max price move** tính từ giá SoDEX lúc nhận tín hiệu (DEC-162), không từ giá fill trên Hyperliquid.
- **Thanh khoản:** mỗi tín hiệu mở / tăng, tổng notional của mọi bot copy cùng trader × market ≤ 50% độ sâu sổ SoDEX phía đối diện trong khoảng Max price move; vượt thì chia theo tỷ lệ, phần dưới min size → "Skipped" (thanh khoản). Giảm / đóng không bị giới hạn.
- **minHoldFilter:** typical hold 30 ngày ≥ 15 phút; không đạt lúc start → chặn; mất điều kiện sau này → ngừng mở mới, vẫn giảm / đóng, báo người dùng.
- **Chỗ copy realtime:** tối đa 8 trader Hyperliquid toàn hệ thống (1 IP, DEC-163 mục 10). Trader đã có người copy luôn copy được; đầy thì nút thành "Follow · copy later".
- **Không có** "Try with fake money" cho Copy Trade (DEC-105).

