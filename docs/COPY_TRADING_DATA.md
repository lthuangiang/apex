# Dữ liệu Hyperliquid cho Copy Trading v1 (Mốc 0, DEC-163)

Đo ngày **2026-11-11** từ máy dev (một IP), chỉ đọc. Nguồn tài liệu: [Rate limits and user limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits) (đọc cùng ngày). Fixture rút gọn cho test nằm cạnh test của từng package.

## Giới hạn (theo tài liệu chính thức, khớp DEC-163)

| Mục | Giá trị | Ghi chú |
|---|---|---|
| REST | **1.200 weight / phút / IP** | Chung cho mọi request `info` |
| `l2Book`, `allMids`, `clearinghouseState` | weight **2** | |
| Các `info` khác (`userFills`, `userFillsByTime`, `userFunding`…) | weight **20** + **1 cho mỗi 20 dòng** trả về | Một trang 2.000 fill ≈ 120 weight |
| `userRole` | weight **60** | Dùng nhận diện vault; vai trò không đổi nên lưu lại, chỉ hỏi ví mới |
| WS | 10 kết nối, 1.000 subscription, **10 ví khác nhau** trên các kênh theo user, 2.000 tin gửi / phút | DEC-163 dùng 8 + chừa 2 để đổi ví |

**Đo thực tế:** gọi liên tiếp khoảng 12 trang `userFillsByTime` (2.000 dòng/trang) trong vòng 1 phút thì nhận **429**, khớp cách tính ở trên. Sau 429 có lúc kết nối bị timeout (`UND_ERR_CONNECT_TIMEOUT`) khoảng 1 phút: client phải lùi lại, không gọi dồn.

## Endpoint và trường dữ liệu

- **Leaderboard:** `GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` (không có trong tài liệu chính thức). JSON khoảng **39 MB**, `{ leaderboardRows: [...] }`, **48.160 dòng**. Mỗi dòng: `ethAddress`, `accountValue`, `displayName` (đa số null), `prize`, `windowPerformances: [["day"|"week"|"month"|"allTime", {pnl, roi, vlm}]]`. Ứng viên (DEC-TBD-copy-candidates): lọc `accountValue` 25k–10M USD, `month.pnl` ≥ 10k, `week.pnl` > 0, rồi lấy **300 ví ROI 30 ngày cao nhất** (ngày 2026-11-12: ~1.000 ví qua sàn). Trước đó là top 200 theo `month.pnl` (ngưỡng ~824k USD), toàn cá mập và gần như luôn bị ẩn.
- **`userFillsByTime`** `{user, startTime, aggregateByTime:false}`: tối đa **2.000 fill / lần**, xếp cũ → mới; phân trang bằng `startTime = time cuối + 1`. Trường: `coin, px, sz, side ("B"|"A"), time, startPosition, dir, closedPnl, hash, oid, crossed, fee, feeToken, tid, cloid?, twapId, liquidation?`.
  - `startPosition` là vị thế có dấu trước fill → đủ để cắt episode, không cần `dir`.
  - `dir` thấy được: `Open Long`, `Close Long`, `Open Short`, `Close Short`, `Buy`, `Sell` (spot).
  - `liquidation: {liquidatedUser, markPx, method}` có cả khi ví **nhận** vị thế bị thanh lý của người khác. Ví bị thanh lý chỉ khi `liquidatedUser` = chính ví.
  - `coin`: perp gốc (`BTC`, `kPEPE`), spot `@107`, perp HIP-3 có tiền tố sàn (`para:TER`, `xyz:…`).
- **Trần lịch sử:** ví giao dịch dày không lấy đủ 30 ngày. Ví top #1 (2026-11-11): fill cũ nhất trả về chỉ cách ~22 giờ, 15 trang (30.000 fill) vẫn chưa hết. Tài liệu ghi chỉ 10.000 fill gần nhất. **Quy tắc:** job dừng ở **10.000 fill** (~5 trang, ~600 weight); chạm mức này → `historyIncomplete` (chỉ hiện ở tab All). Ví loại này gần như luôn bị ẩn vì giữ lệnh quá ngắn.
- **`clearinghouseState`** `{user}`: `assetPositions[].position {coin, szi, entryPx, positionValue, unrealizedPnl, leverage {type, value}, liquidationPx, maxLeverage, cumFunding}`, `marginSummary`, `time`.
- **`userFunding`** `{user, startTime}`: tối đa **500 dòng / lần**; `delta {type:"funding", coin, usdc, szi, fundingRate, nSamples}`. `usdc` dương = nhận.
- **`userRole`** `{user}`: `{"role":"user"}`; vault trả `vault` (theo tài liệu; chưa gặp vault trong mẫu đo).

## Map sang SoDEX Perps

SoDEX `GET /api/v1/perps/markets/symbols` ngày đo: **105 market TRADING** (gồm cổ phiếu, hàng hoá: `TSLA-USD`, `XAUT-USD`…).
- Perp gốc Hyperliquid `X` → `X-USD`; `kX` → `1000X-USD` (`kPEPE` → `1000PEPE-USD`, `kBONK`, `kSHIB`).
- Spot `@N` không tính vào thống kê. Perp HIP-3 (`dex:COIN`) **không map** (sàn khác của builder khác, giá có thể khác) nhưng vẫn tính vào mẫu số của SoDEX coverage.

## Ngân sách weight dự kiến (1 IP)

| Tầng | Cách tính | Weight / phút |
|---|---|---|
| T2 leaderboard (đêm) | ≤ 300 ví (ví dày dừng sau 1 trang) × (≤ 5 trang fill × ~120 + funding ~25–45 × trang + `userRole` 60 lần đầu) | trải ~4–6 giờ ở ~500/phút |
| T1 follow | ≤ 40 ví × `userFills` (20 + ≤100) mỗi 2 phút | đọc `userFillsByTime` từ lần đọc trước nên mỗi lần ~20–25 weight → 40 × ~22 ÷ 2 ≈ **~440 / phút** (DEC-163 ước ~400) |
| T0 copy | 8 ví × `clearinghouseState` (2) mỗi 30 s | ~32 |
| DEC-92 (nếu bật) | như hiện tại | ~422 |

Bật DEC-92 thì T2 chạy chậm lại (bucket dùng chung có reserve), không vượt 1.200.

## Quan sát cho sản phẩm

- Nhiều ví top 200 theo PnL có rất ít episode trong 30 ngày (mẫu: 1 và 10 episode), nên bị ẩn bởi "< 20 episode". Tab Steady có thể ít người. Nếu cần nhiều hơn: tăng số ứng viên (ví dụ top 500, tốn thêm thời gian chạy đêm), không nới bộ lọc khi chưa hỏi.
- Profit 30D tính lại từ fill (ví mẫu: 1,676 triệu USD) gần với `month.pnl` của leaderboard (1,728 triệu); chênh lệch vì leaderboard có unrealized và chưa cộng funding.

## Đo mẫu ứng viên mới (2026-11-12, DEC-TBD-copy-candidates)

10 ví lấy đều trong top 300 theo ROI (sau sàn an toàn), chạy đúng code job đêm (dừng sớm bật):
- **1/10 qua bộ lọc** (vào Steady: 34 lệnh đóng, hold trung vị ~11 giờ, coverage 0,80). Cách cũ (top PnL): 0/13.
- Lý do ẩn: 7 ví "< 20 lệnh đóng" (2 ví không có fill perp nào trong 30 ngày: lãi từ vị thế giữ lâu hoặc spot), 1 ví giao dịch chủ yếu market SoDEX không có (coverage 0,005).
- Thời gian: trung bình ~4,4 giây / ví (cách cũ > 1 phút / ví) → 300 ví ≈ 25 phút.
- Ước tính: ~10% ứng viên hiện được → khoảng 30 trader / đêm. Muốn nhiều hơn thì tăng số ứng viên (rẻ hơn nhiều so với trước) hoặc xét lại ngưỡng "20 lệnh đóng" (DEC-163, chưa đổi).

