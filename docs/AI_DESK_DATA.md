# AI Desk — Mốc 0: kiểm tra dữ liệu

Tài liệu này là kết quả của **Giai đoạn 0** trong `docs/AI_DESK.md` mục 7: bảng thông số dữ liệu SoDEX cho BTC và ETH, và những gì còn thiếu cho backtest / Ask AI.

- **Ngày đo:** 2026-11-04, khoảng 03:00–04:10 UTC. Mọi số trong file này đo ngày đó, trừ khi ghi khác.
- **Market:** spot `vBTC_vUSDC`, `vETH_vUSDC`; perps `BTC-USD`, `ETH-USD`.
- **Base URL:** `https://mainnet-gw.sodex.dev/api/v1`. Chỉ gọi GET, không ký, không gửi lệnh.
- **Ký hiệu nguồn:** **[REST]** = endpoint công khai SoDEX; **[DB]** = Postgres local `drift-handoff-postgres-1` (chỉ máy dev này); **[code]** = hằng số trong repo; **[docs]** = tài liệu trong `docs/`.

---

## 1. Độ sâu lịch sử nến (klines)

**Cách đo.** `GET /{spot|perps}/markets/{symbol}/klines?interval=..&limit=1000&startTime=..&endTime=..`. Tìm nhị phân trên `startTime` với cửa sổ hẹp `[t, t + 500 nến]`: cửa sổ có dữ liệu thì lùi tiếp. Kết quả là nến cũ nhất còn trả về. **[REST, 2026-11-04]**

| Interval | `vBTC_vUSDC` | `vETH_vUSDC` | `BTC-USD` | `ETH-USD` | Nhận xét |
|---|---|---|---|---|---|
| `1m` | 2026-10-28 05:23 (6.94 ngày) | 2026-10-28 05:23 (6.94 ngày) | 2026-10-28 05:24 (6.94 ngày) | 2026-10-28 05:24 (6.94 ngày) | cửa sổ trượt ≈ 10.000 nến |
| `5m` | 2026-09-30 10:45 (34.7 ngày) | như BTC | 2026-09-30 10:45 (34.7 ngày) | như BTC | cửa sổ trượt ≈ 10.000 nến |
| `15m` | 2026-07-23 00:15 (104.2 ngày) | như BTC | 2026-07-23 00:15 (104.2 ngày) | như BTC | cửa sổ trượt ≈ 10.000 nến |
| `1h` | 2025-10-10 07:00 (389.9 ngày) | 2025-10-15 09:00 (384.8 ngày) | 2025-10-12 07:00 (387.9 ngày) | 2025-10-16 08:00 (383.8 ngày) | tới ngày market mở |
| `1d` | 2025-10-10 (390 ngày) | 2025-10-15 (385 ngày) | 2025-10-12 (388 ngày) | 2025-10-16 (384 ngày) | tới ngày market mở |

Giờ ghi theo UTC.

**Kết luận.**
- `1m`, `5m`, `15m` là **cửa sổ trượt khoảng 10.000 nến** (6.94 × 1440 ≈ 34.72 × 288 ≈ 104.16 × 96 ≈ 10.000). Nến cũ hơn bị SoDEX xoá, nên muốn có lâu hơn thì DRIFT phải tự lưu.
- `1h` và `1d` còn đủ từ ngày market mở (tháng 10/2025), tức khoảng **13 tháng**.
- Server cũng nhận `interval=1D` (in hoa). Danh sách interval mà DRIFT hỗ trợ: `1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1M` **[code: `packages/sodex/src/rest/history-schemas.ts`]**. Mình chưa đo `30m`, `4h`, `1w`, `1M`.
- Mỗi lần gọi trả tối đa `limit` nến **mới nhất** trong cửa sổ, xếp mới trước. Khi gọi với `startTime` rất xa (6 năm trước) và `limit=1`, kết quả không nhất quán: đo `1m` kiểu này chỉ thấy 1.04 ngày. Vì vậy phải phân trang bằng cửa sổ hẹp. `apps/backtest/src/run.ts` (`sodexCandles`, `PAGE = 1000`) đã làm đúng như vậy.

**Độ liền của nến `1h`** (đếm toàn bộ từ ngày mở tới 2026-11-04) **[REST]**:

| Market | Số nến có | Số nến kỳ vọng | Số khoảng trống | Nến `v = 0` |
|---|---|---|---|---|
| `vBTC_vUSDC` | 9.179 | 9.358 | 12 | 31 |
| `vETH_vUSDC` | 9.169 | 9.236 | 9 | 38 |
| `BTC-USD` | 9.191 | 9.310 | 18 | 14 |
| `ETH-USD` | 9.162 | 9.213 | 3 | 38 |

Thiếu khoảng 0.5–2% số nến. Backtest phải xử lý khoảng trống, không được nội suy thành giá thật.

**Thanh khoản (để hiểu độ tin của backtest)**, tính từ 30 nến `1d` đã đóng gần nhất, cột `q` (quote volume, USDC) **[REST, 2026-11-04]**:

| Market | Giá đóng gần nhất | Quote volume TB/ngày | Trung vị/ngày |
|---|---|---|---|
| `vBTC_vUSDC` | 76.575 | ≈ 34.300 | ≈ 5.900 |
| `vETH_vUSDC` | 2.253,3 | ≈ 14.600 | ≈ 8.500 |
| `BTC-USD` | 76.626 | ≈ 100,8 triệu | ≈ 106,0 triệu |
| `ETH-USD` | 2.254,5 | ≈ 92,2 triệu | ≈ 89,9 triệu |

Spot BTC/ETH trên SoDEX **rất mỏng**: vài nghìn USDC mỗi ngày. Nến spot có nhiều bar khối lượng 0, nên giả định "chạm giá là khớp" trong backtest spot dễ lạc quan.

**Public trades** (AI_DESK mục 7 có yêu cầu kiểm tra): `GET /{spot|perps}/markets/{symbol}/trades?limit=..` có trả dữ liệu, gồm `t, T, s, S, p, q, bi, si`. `limit` tối đa 500 (1000 trả `code: -1`). Server **bỏ qua `startTime`/`endTime`**, chỉ trả các trade mới nhất: 500 trade BTC-USD ≈ 15 phút. Vì vậy **không có lịch sử public trades**. `packages/sodex` chưa có hàm gọi endpoint này. **[REST, 2026-11-04]**

---

## 2. Lịch sử funding

**Phía SoDEX.** Không có endpoint lịch sử funding của cả thị trường. Chỉ có:
- `GET /perps/markets/mark-prices`: `fundingRate` hiện tại và `nextFundingTime`;
- `GET /perps/accounts/{address}/fundings`: funding của **một account**.

**[docs/SODEX.md mục 5.6; code: `packages/sodex/src/rest/client.ts`]**

Thông số funding lấy từ `GET /perps/markets/symbols` **[REST, 2026-11-04]**:

| Field | `BTC-USD` | `ETH-USD` |
|---|---|---|
| `fundingInterval` | 3600 (mỗi giờ) | 3600 |
| `interestRate` | 0.0001 | 0.0001 |
| `maxFundingRate` / `minFundingRate` | 0.04 / −0.04 | 0.04 / −0.04 |
| `fundingRate` lúc đo | 0.0000125 | 0.0000125 |

**Phía DRIFT.** `apps/marketdata` (`FundingTracker`) ghi mỗi kỳ funding đã chốt vào bảng `funding_rates`, nhưng chỉ khi service đang chạy. `apps/backtest` đọc bảng này. Nếu không có funding từ đầu cửa sổ (sai lệch hơn 1 ngày) thì backtest không chạy (DEC-40). **[code: `apps/marketdata/src/main.ts`, `apps/backtest/src/run.ts`]**

Độ phủ trong DB local (chỉ máy dev này, marketdata không chạy liên tục) **[DB, 2026-11-04]**:

| Market | `min(funding_time)` | `max(funding_time)` | Số dòng | Kỳ vọng (theo giờ) | Phủ | Số giá trị `rate` khác nhau |
|---|---|---|---|---|---|---|
| `BTC-USD` | 2026-10-28 08:00 | 2026-11-04 04:00 | 58 | ≈ 165 | ≈ 35% | 13 |
| `ETH-USD` | 2026-10-28 08:00 | 2026-11-04 04:00 | 58 | ≈ 165 | ≈ 35% | 28 |

Phần lớn các kỳ có `rate = 0.0000125`, đúng bằng mức `fundingRate` lúc đo. Giá trị thấp nhất: BTC −0.0000018, ETH −0.0000154. Dữ liệu này chưa đủ để kiểm tra chiến lược funding carry, vì chỉ có khoảng 7 ngày và thủng nhiều đoạn.

**Nến `1m` trong DB local** (`candles_1m`, TimescaleDB) **[DB, 2026-11-04]**:

| Market | `min(ts)` | `max(ts)` | Số dòng | Phủ (so với số phút trong khoảng) |
|---|---|---|---|---|
| `BTC-USD` | 2026-10-27 12:11 | 2026-11-04 04:04 | 7.935 | 71.9% |
| `ETH-USD` | 2026-10-27 12:11 | 2026-11-04 04:04 | 7.701 | 69.8% |
| `vBTC_vUSDC` | 2026-10-27 06:37 | 2026-11-04 04:04 | 7.979 | 70.2% |
| `vETH_vUSDC` | 2026-10-27 06:37 | 2026-11-04 04:04 | 8.516 | 74.9% |

Số này chỉ phản ánh máy dev. Môi trường production **chưa đo được**, vì không có quyền truy cập DB production trong phiên này.

---

## 3. Phí

| Loại | Maker | Taker | Nguồn | Đã kiểm chứng? |
|---|---|---|---|---|
| Spot, dự phòng của DRIFT (`SODEX_BASE_FEE_PCT.spot`) | 0.035% | 0.065% | [code: `packages/shared/src/fees.ts`], theo `/symbols` 2026-11-04 (DEC-112) | Đọc từ API |
| Perps, dự phòng của DRIFT (`SODEX_BASE_FEE_PCT.perps`) | 0.012% | 0.04% | như trên | Đọc từ API |
| Spot, `makerFee` / `takerFee` của symbol | 0.035% (`0.00035`) | 0.065% (`0.00065`) | [REST `/spot/markets/symbols`, 2026-11-04] | Đọc từ API |
| Perps, `makerFee` / `takerFee` của symbol | 0.012% (`0.00012`) | 0.04% (`0.0004`) | [REST `/perps/markets/symbols`, 2026-11-04] | Đọc từ API |

**Đã thống nhất (DEC-112):** DRIFT dùng `makerFee` / `takerFee` của từng market trên `/symbols` (một số market Spot có phí 0); `SODEX_BASE_FEE_PCT` chỉ là dự phòng và đã đặt bằng mức công bố. Phí thật của từng người phụ thuộc tier khối lượng 14 ngày (DEC-39/40) và đo được từ fill (`fee` − `builderFee`, `isMaker`).

**Builder fee của DRIFT** (đơn vị SoDEX: phần mười basis point) **[code: `packages/shared/src/fees.ts`; DEC-46, DEC-94]**:

| Chiến lược | Rate | % |
|---|---|---|
| Mặc định: `spot_grid`, `futures_grid`, `spot_dca`, `futures_dca`, `recurring_buy`, `rebalancing`, `funding_arb` | 10 | 0.01% |
| `volume_farm` | 5 | 0.005% |
| `volume_maker` | 3 | 0.003% |

Approval luôn là 10. SoDEX thu `min(approval, phí gắn trên lệnh)`. Account của chính builder không bị thu (DEC-47). Mức trên lệnh lấy từ code. Chưa đối chiếu với `builderFee` trên fill thật trong phiên này.

---

## 4. Lệnh tối thiểu và quy tắc market

Nguồn: `GET /spot/markets/symbols` và `GET /perps/markets/symbols`, tức `getSpotSymbols` / `getPerpsSymbols` trong `packages/sodex/src/rest/client.ts` **[REST, 2026-11-04]**.

| Field | `vBTC_vUSDC` | `vETH_vUSDC` | `BTC-USD` | `ETH-USD` |
|---|---|---|---|---|
| `id` (symbolID) | 1 | 2 | 1 | 2 |
| `tickSize` | 1 | 0.1 | 1 | 0.1 |
| `stepSize` | 0.00001 | 0.0001 | 0.00001 | 0.0001 |
| `minQuantity` | 0.00001 | 0.0001 | 0.00001 | 0.0001 |
| `minNotional` (USDC) | 5 | 5 | 10 | 10 |
| `maxNotional` | 0 (không giới hạn) | 0 | 4.000.000 | 4.000.000 |
| `maxQuantity` | 0 | 0 | 1000 | 10000 |
| `maxLeverage` | — | — | 40 | 40 |
| `initLeverage` | — | — | 20 | 20 |
| `marketDeviationRatio` | 0.1 | 0.1 | 0.025 | 0.04 |

Lệnh nhỏ nhất thực tế = `max(minNotional, minQuantity × giá)`. Ở giá hiện tại, `minQuantity × giá` chỉ khoảng 0.2–0.8 USDC, nên **spot cần 5 USDC, perps cần 10 USDC** mỗi lệnh.

Perps `marginTiers` (giống nhau cho BTC và ETH): notional ≤ 4 triệu → `maxLeverage` 40, MMR 1.25%; ≤ 100 triệu → 25×, MMR 2%; trên đó → 1×, MMR 50%.

---

## 5. Vốn tối thiểu theo chiến lược

**Nguồn công thức:** `minCapital()` trong `packages/shared/src/reco/engine.ts`. Đây là cổng lọc: bot chỉ được đề xuất khi `capital ≥ min`. Các helper nằm trong `packages/shared/src/reco/params.ts`, ngưỡng trong `config.ts`. Đặt `minOrder = max(minNotional, minQuantity × lastPrice)` và `lev = leverageFor(ctx) = min(2, accountLeverageCap, market.maxLeverage)`, nhưng `lev = 1` nếu quy tắc loại trừ đòn bẩy cao kích hoạt (`forceOneX`).

| Chiến lược | Công thức `minCapital` | BTC (USDC) | ETH (USDC) |
|---|---|---|---|
| `spot_grid` | `minOrder × gridMinLevels (5)` | 25 | 25 |
| `futures_grid` | `minOrder × 5 / lev` | 25 (lev 2) · 50 (1×) | 25 (lev 2) · 50 (1×) |
| `spot_dca` | `minOrder / lev × dcaUnits(n)`; xem chú thích | 165,86 (n = 7) | 379,43 (n = 9) |
| `futures_dca` | như trên, `lev` của perps | 165,86 (lev 2) · 331,72 (1×) | 379,43 (lev 2) · 758,87 (1×) |
| `recurring_buy` | `minOrder × recurring.buys (20)` trên market spot | 100 | 100 |
| `rebalancing` | `minOrder × 100 / stableMinPct (20) × số tài sản` | 50 cho rổ BTC + ETH (25 mỗi tài sản) | (cùng rổ) |
| `funding_arb` | `max(fundingArbMinCapital = 2000, 2 × minOrder)` | 2.000 | 2.000 |

**Chú thích DCA.** `first = max(1%, trung vị |biến động ngày| trong 30 ngày)`. `n` là số safety order nhỏ nhất (tối đa 20) để tổng khoảng lùi `first × Σ 1.2^i` phủ được drawdown lớn nhất trong 31 nến ngày. `dcaUnits(n) = 1 + Σ_{i<n} 1.5^i`. Số trên tính bằng hàm thật của repo, với 31 nến `1d` đã đóng tới 2026-11-03 **[REST + code]**:

| Market | Trung vị |ret| ngày | Max drawdown 30 ngày | `n` | `dcaUnits` |
|---|---|---|---|---|
| `vBTC_vUSDC` | 0.88% → `first` = 1% | 11.35% | 7 | 33,17 |
| `vETH_vUSDC` | 0.94% → 1% | 17.78% | 9 | 75,89 |
| `BTC-USD` | 0.90% → 1% | 11.21% | 7 | 33,17 |
| `ETH-USD` | 0.90% → 1% | 17.69% | 9 | 75,89 |

Vốn mà `paramsFor` tự chọn khi không nhập vốn (form DCA) cao hơn cổng khoảng 8%, vì mỗi lệnh phải đạt min size sau khi làm tròn lot (`baseOrder` 5,43 / 5,25 / 5,37 / 5,07): BTC spot ≈ 180, ETH spot ≈ 398, BTC perps 2× ≈ 178, ETH perps 2× ≈ 385 USDC. Mức vốn DCA **thay đổi mỗi ngày** theo drawdown 30 ngày.

**Lưu ý.**
- Grid: cổng 25 USDC chỉ là điều kiện cần. `gridParams` còn kiểm `gridFits` (mọi mức đạt min size sau khi làm tròn lot, theo bước giá thật), nên vốn thực tế có thể phải cao hơn. Chưa tính số này vì cần `p5`, `p95`, `sigma30` từ `apps/reco`.
- `rebalancingParams` còn đòi `capital × minWeight / 100 ≥ minOrder`.
- `funding_arb` chia đôi vốn cho chân spot và chân perps. Mức sàn 2000 là ngưỡng sản phẩm trong config, không phải ràng buộc của SoDEX.
- Engine chạy bot dùng `meetsMinSize` / `minSizeDetail` trong `packages/strategies/src/requirements.ts`, cùng công thức `max(minNotional, minQuantity × giá)`.
- Mình dùng một file vitest tạm để chạy hàm thật, rồi đã xoá file đó.

---

## 6. Rate limit liên quan tới backtest

**[code: `packages/sodex/src/rate-limit/weights.ts`; docs: `docs/VOLUME_MAKER.md` mục 17.1]**

| Giới hạn | Giá trị |
|---|---|
| REST theo IP egress | 1200 weight / phút (ghi đè được bằng `SODEX_REST_WEIGHT_PER_MIN`) |
| Weight của klines | `20 + max(1, floor(rows / 25))`, nên trang 1000 nến = 60 |
| `marketInfo` (symbols, orderbook) / `accountRead` / mặc định | 2 / 5 / 20 |
| Lệnh theo API key | 20 lệnh/giây, 600 lệnh/phút |
| Theo địa chỉ ví | 1 request cho mỗi 1 USDC đã giao dịch luỹ kế, cộng 10.000 ban đầu; vượt thì 1 request mỗi 10 giây |

**Ảnh hưởng.** Nếu backtest dùng một mình cả hạn mức, mỗi phút tải được khoảng 20 trang × 1000 = **20.000 nến**. Toàn bộ lịch sử `1h` của một market (khoảng 9.300 nến, 10 trang) tốn chừng 600 weight, tức nửa phút. Lịch sử `1m` của 7 ngày cũng khoảng 10 trang. Bucket được chia sẻ qua Redis theo key `sodex:ip:<egress>`, nên marketdata, reco và engine trên cùng IP dùng chung hạn mức. `waitOnLimit` trong backtest thử lại tối đa 20 lần khi gặp `rateLimited`.

---

## Thiếu gì / ảnh hưởng tới Ask AI

1. **Nến chi tiết chỉ giữ khoảng 10.000 bar.** `1m` ≈ 7 ngày, `5m` ≈ 35 ngày, `15m` ≈ 104 ngày. Backtest hoặc Research Lab ở khung dưới `1h` mà cần dài hơn thì DRIFT phải tự lưu, ví dụ để `candles_1m` chạy liên tục ở production. Khung `1h`/`1d` có khoảng 13 tháng, đủ cho chiến lược chậm nhưng chỉ có một chu kỳ thị trường.
2. **Funding history gần như không có.** SoDEX không cung cấp. DB của DRIFT chỉ có những gì marketdata ghi được: máy dev có ≈ 7 ngày và phủ ≈ 35%. Production **chưa đo được**. Ask AI và Research Lab chưa thể kiểm định funding carry. Muốn làm thì phải bảo đảm marketdata ghi liên tục ở production và chờ đủ dữ liệu (vài tháng).
3. **Không có lịch sử public trades.** Endpoint chỉ trả 500 trade mới nhất. Muốn mô phỏng khớp lệnh hay hàng đợi maker thì phải tự ghi.
4. **Spot thanh khoản rất mỏng.** Khoảng 6–9 nghìn USDC/ngày (trung vị) so với khoảng 100 triệu/ngày ở perps. Ask AI không nên trích kết quả backtest spot như thể sẽ khớp được. Nên ưu tiên perps cho BTC/ETH, hoặc gắn cảnh báo về thanh khoản.
5. **Phí lệch giữa code và API.** Đã xử lý ở DEC-112: dùng phí của market trên `/symbols`; bảng trong code là dự phòng, cùng mức công bố.
6. **Nến có khoảng trống** (≈ 0.5–2% ở `1h`) và có bar `v = 0`. Engine backtest và Skeptic phải coi đây là thiếu dữ liệu, không phải giá phẳng.
7. **Vốn tối thiểu thấp cho grid và recurring (25–100 USDC), cao cho DCA (166–759 USDC, đổi theo ngày) và funding arb (2000).** Ask AI cần lấy số này từ `recommend()` lúc chạy, không ghi cứng.
