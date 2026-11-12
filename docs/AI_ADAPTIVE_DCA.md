# DRIFT — AI Adaptive DCA (S11)

> Trạng thái: **đã code, thử nghiệm (2026-11-04, DEC-107)**. Chỉ tạo và chạy được với tài khoản được team bật AI Desk.
> Kế hoạch gốc: 2026-11-03 (DEC-96, DEC-97). Field spec: `docs/STRATEGIES.md` S11.

## 1. Yêu cầu (người dùng, 2026-11-03)

- AI xác định thị trường Sideway, Bullish hay Bearish.
- Chỉ kích hoạt DCA khi có tín hiệu phù hợp.
- Tự điều chỉnh khoảng cách DCA theo ATR.
- Không tăng vốn vô hạn khi thua.
- Có Maximum Exposure và Hard Stop Loss.
- AI quyết định Continue / Reduce / Exit.

"AI" ở đây là **quy tắc cố định** trên nến 5 phút (gộp từ nến 1 phút), cùng đầu vào cho cùng kết quả. Không phải mô hình
ngôn ngữ, không dự báo giá. Câu chữ UI ghi rõ "Rules, not predictions".

## 2. Vì sao không dùng lõi DCA cũ

DCA cũ (`common/dca-bot.ts`) đặt sẵn mọi lệnh DCA theo khoảng cố định ngay khi mở chu kỳ. Không có cách tính lại khoảng
cách theo ATR cho từng lệnh hay dừng thêm lệnh khi thị trường đổi. S11 là module riêng (`packages/strategies/src/adaptive-dca`),
dùng lại sổ cái, làm tròn, ATR, regime (`volume-farm/signal.ts`).

## 3. State machine và quy tắc

```
idle ──regime hợp lệ + RSI──▶ entering (lệnh đầu, market) ──khớp──▶ in_cycle ──take profit khớp──▶ idle
                                                                    ├─ Reduce (ngừng thêm, chốt ở hoà vốn) ⇄ Continue
                                                                    └─ Exit / hard stop ──▶ exiting ──đóng──▶ idle (cooldown)
maxLoss của bot (ở mọi phase) ──▶ halted, dừng bot và đóng vị thế
```

### 3.1 Dữ liệu và thời điểm quyết định

- Engine gửi 120 nến **1 phút đã đóng** (`candles_1m`) mỗi phút. Chiến lược bỏ nến chưa đóng, gộp theo mốc 5 phút
  (`floor(t / 5 phút)`) và **chỉ giữ nhóm đủ 5 nến**, nên mọi chỉ số (regime, ATR-14, RSI-14) tính trên nến 5 phút **đã
  đóng**. Thiếu một phút dữ liệu thì cả nến 5 phút đó bị bỏ (chuỗi thưa hơn, không bịa nến).
- Quyết định được xét **mỗi phút**, nhưng đầu vào chỉ đổi khi có nến 5 phút mới đóng. Vào lệnh có thể xảy ra ở bất kỳ phút
  nào trong nến 5 phút kế tiếp, với dữ liệu của nến đã đóng trước đó. Riêng hard stop và max loss được xét **mỗi lần có giá**.

### 3.2 Quy tắc

| Bước | Quy tắc |
|---|---|
| Vào chu kỳ | Long: regime SIDEWAY hoặc TREND_UP và RSI ≤ `entryRsi` (mặc định 45). Short: SIDEWAY hoặc TREND_DOWN và RSI ≥ 100 − `entryRsi`. Lệnh đầu là market |
| Lệnh thêm | Chỉ **một** lệnh limit trên sổ: giá khớp gần nhất ∓ ATR × `atrMultiplier` × 1.2^(k−1), tối thiểu 0.3%. ATR đo lại lúc đặt |
| Take profit | Limit reduce-only ở giá trung bình × (1 ± `takeProfitPct`), đặt lại sau mỗi lần khớp thêm |
| Continue | Đặt lệnh thêm kế tiếp nếu còn lượt và còn chỗ dưới trần |
| Reduce | Khi (a) regime ngược hướng (long gặp TREND_DOWN, short gặp TREND_UP), hoặc (b) HIGH_VOLATILITY và đã khớp ≥ 70% số lệnh thêm. Bot **huỷ lệnh thêm đang chờ, không thêm lệnh mới**, và **đặt lại take profit ở giá hoà vốn của chu kỳ**, rồi chờ giá hồi. Không bán lỗ |
| Hoà vốn | Giá mà đóng toàn bộ vị thế ở đó thì lãi giao dịch bù đủ **phí đã trả + funding của chu kỳ + phí của chính lệnh đóng** (maker + builder): long P = (avg·q + chi phí) / (q·(1 − f)), short P = (avg·q − chi phí) / (q·(1 + f)); làm tròn tick về phía an toàn |
| Thoát Reduce | Ngay phút đầu tiên quyết định trở lại Continue (regime không còn ngược, và không còn điều kiện (b)): take profit về mức đầy đủ, đặt lại lệnh thêm |
| Exit | Regime ngược hướng **liên tục** ≥ 240 phút (đếm theo các lần xét mỗi phút; một phút không ngược là đếm lại từ đầu): huỷ lệnh, đóng toàn bộ bằng market reduce-only |
| Hard stop | Giá đi ngược ≥ `hardStopLossPct` so với **giá trung bình** của vị thế: đóng toàn bộ bằng market |
| Max loss | Lỗ ròng của bot (đã chốt + chưa chốt − phí − funding) ≥ `maxLoss`: huỷ lệnh, **dừng bot** và đóng vị thế |
| Sau Exit / hard stop | Nghỉ `cooldownMinutes`; sau take profit thì xét chu kỳ mới ngay |

**Thứ tự ưu tiên:** max loss → hard stop → Exit → Reduce → Continue. Hai mức đầu được xét ở mọi lần có giá và trước khi xét
quyết định mỗi phút, nên Exit 4 giờ không bao giờ chặn hard stop hay max loss.

### 3.3 Trần vị thế

- `maxExposure` là **giá trị danh nghĩa** của vị thế (đã gồm đòn bẩy), tính bằng |khối lượng| × **giá trung bình** (giá vốn,
  không phải giá thị trường). Tiền ký quỹ cần = `maxExposure` / đòn bẩy (đây là "vốn" hiện trên Strategy Lab).
- Trước mỗi lệnh thêm: nếu giá trị hiện tại + lệnh thêm > trần thì **không đặt**, ghi "Holding", giữ take profit và chờ;
  hard stop / max loss vẫn áp dụng.
- Mặc định đã chỉnh cho khớp: thang 100 + 100 + 150 + 225 + 337.5 = **912,5 USDC** (4 lệnh thêm × 1.5) nằm dưới trần
  1.000; trần là lưới an toàn, không phải giới hạn thường xuyên chạm. (Bản trước đặt 5 lệnh thêm: thang 1.418,75 > trần nên
  lệnh thứ 5 không bao giờ được đặt.)

## 4. Backtest: phương pháp, kết quả, bài học

### 4.1 Phương pháp (dùng chung engine `runBacktest`)

| Mục | Cách làm |
|---|---|
| Dữ liệu | Nến 1 phút thật của SoDEX (REST công khai), 5 ngày 2026-10-30 → 11-04, BTC-USD và ETH-USD. Funding thật từ `funding_rates` của DRIFT (100 kỳ trong cửa sổ) |
| Tín hiệu | Mỗi nến 1 phút, `timer` mang 120 nến tới hết nến vừa đóng, như engine thật. Không có sổ lệnh lịch sử (S11 không dùng) |
| Khớp | Đường giá trong nến O→L→H→C (nến tăng) hoặc O→H→L→C (nến giảm). Limit chỉ khớp khi giá đi xuyên qua; lệnh đặt trong một nến chỉ khớp từ nến sau. Nhiều lệnh bị vượt trong cùng một đoạn thì khớp theo thứ tự bất lợi. Market khớp ở giá mở nến sau ± trượt giá 0.05% |
| Phí | Phí của market trên `/symbols` (Perps maker 0.012%, taker 0.04%; DEC-112) + builder 0.01%. Engine và backtest cùng dùng phí một chiều = maker + builder để tính hoà vốn |
| PnL | Lãi/lỗ = equity cuối − vốn; equity = tiền + vị thế đánh giá theo giá cuối (vị thế còn mở tính lãi lỗ chưa chốt) |
| Sụt giảm lớn nhất | Lớn nhất của (đỉnh equity − equity) trên **toàn bot**, theo từng nến, đơn vị **USDC**; quy ra **% vốn** (vốn = tiền ký quỹ cần, 500 USDC cho cả hai cấu hình) |
| Chuẩn hoá | So **lãi / sụt giảm** và **vị thế lớn nhất** (giá vốn), vì hai chiến lược dùng mức vị thế khác nhau |

### 4.2 Kết quả với đúng cấu hình mặc định (2×, lệnh 100 / 100 USDC, 4 lệnh thêm, trần 1.000)

DCA cố định đối chứng: cùng giá trị lệnh danh nghĩa (50 ký quỹ × 2×), 4 lệnh thêm × 1.5, bước 1% × 1.2, TP 1.5%, SL 8%.

| | Lãi/lỗ | % vốn | Sụt giảm lớn nhất | % vốn | Lãi / sụt giảm | Vị thế lớn nhất | Phí | Funding |
|---|---|---|---|---|---|---|---|---|
| BTC · DCA cố định | +1,43 | +0,29% | 10,78 | 2,16% | 0,13 | 349 | 0,25 | 0,14 |
| BTC · AI DCA | −2,64 | −0,53% | 22,82 | 4,56% | −0,12 | 911 | 1,31 | 0,28 |
| ETH · DCA cố định | +11,77 | +2,35% | 7,47 | 1,49% | 1,58 | 350 | 0,62 | 0,07 |
| ETH · AI DCA | +13,68 | +2,74% | 9,04 | 1,81% | 1,51 | 575 | 1,89 | 0,09 |

### 4.3 Bài học

1. **Exit ngay khi trend ngược là sai với DCA:** DCA long vào lúc giá giảm, đúng lúc regime 5 phút báo TREND_DOWN, nên bản
   đầu Exit 34 lần / 5 ngày trên BTC (lỗ −21 USDC với lệnh 200 USDC, 1×). Đổi thành Reduce, Exit chỉ khi ngược kéo dài.
   Đây là **giả thuyết đang thử**, chưa chứng minh tốt hơn: 5 ngày không đủ.
2. **Khoảng ATR 5 phút hẹp hơn nhiều so với bước 1%:** AI DCA khớp lệnh thêm nhanh và giữ vị thế gấp 2–3 lần DCA cố định.
   Phần lãi tuyệt đối cao hơn trên ETH đến từ vị thế lớn hơn, không phải lợi thế: chuẩn hoá theo sụt giảm thì ngang (ETH) hoặc
   kém (BTC).
3. **Chưa có bằng chứng lợi thế.** Không chỉnh tham số theo 5 ngày này để tránh overfit.

## 5. Theo dõi khi thử nghiệm (đề xuất, chờ duyệt)

| Chỉ số (theo bot) | Nguồn |
|---|---|
| Lãi / sụt giảm, % vốn | equity của bot |
| Số chu kỳ chốt lãi, số lần Exit, số lần hard stop | Decisions / state (`completedCycles`, `exits`) |
| Vị thế lớn nhất / trần | state `peakExposure`, thẻ Trading Agent |
| Thời gian ở Reduce | Decisions "Reduce" / "Continue" |

**Tạm dừng thử nghiệm** (team quyết, không tự động): một bot chạm max loss; hoặc sau 30 ngày dữ liệu nến 1 phút, lãi / sụt giảm
của AI DCA thấp hơn DCA cố định cùng cỡ lệnh trên cả BTC và ETH; hoặc số lần Exit + hard stop nhiều hơn số chu kỳ chốt lãi.
**Mở rộng** chỉ khi backtest 30 ngày và chạy thật vốn nhỏ đều tốt hơn DCA cố định sau khi chuẩn hoá theo sụt giảm.

## 6. Việc đã làm

| Phần | File |
|---|---|
| Chiến lược thuần + test (15) | `packages/strategies/src/adaptive-dca/`, `__tests__/adaptive-dca.test.ts` |
| Registry, vốn cần (= maxExposure / đòn bẩy), lệnh tối thiểu | `packages/strategies/src/{registry,requirements}.ts` |
| Backtest 5D / 30D trên nến 1 phút, chỉ số Cycles / Early exits | `packages/strategies/src/backtest`, `packages/shared/src/api/backtest.ts` |
| Engine: nến 1 phút mỗi phút, chỉ chạy khi AI Desk bật | `apps/engine/src/engine.ts` |
| API: chặn khi chưa bật AI Desk, số liệu cho Trading Agent | `apps/api/src/modules/bots/service.ts`, `packages/shared/src/api/bots.ts` |
| Web: form, catalog (chỉ khi AI Desk bật), thẻ Trading Agent, câu chữ | `apps/web/src/features/bots`, `apps/web/messages/en.json` |

## 7. Còn mở

- Tham số mặc định chờ duyệt (DEC-107).
- Regime dùng chung `detectRegime` của Volume Farming (ngưỡng EMA21 ± 0.2%, ATR > 0.5% là biến động mạnh): đơn giản và nhạy.
  Có thể cần khung dài hơn (15 phút / 1 giờ) cho DCA; cần dữ liệu để quyết.
- Chưa có Preview riêng trên màn tạo bot.
