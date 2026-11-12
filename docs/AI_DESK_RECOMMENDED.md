# AI Desk — Recommended: flow chi tiết

> Trạng thái: **đã code bản đầu (2026-11-04, DEC-105)**: Recommended, Why this one, Your bots, Paper mode, Test results, Use real money. Ask AI chưa làm. Kế hoạch chung: `docs/AI_DESK.md`. Đối chiếu với code ngày 2026-10-31.
>
> Nhãn trong tài liệu:
> - **[Có sẵn]**: code đã có, dùng lại.
> - **[Phải làm]**: chưa có, phải code.
> - **[Cần chốt]**: quyết định sản phẩm, code không được tự chọn.
>
> Mọi con số trong ví dụ là minh hoạ, không phải dữ liệu thật.

## 1. Tóm tắt một phút

| Nút | Nó làm gì | Có đụng tiền thật không |
|---|---|---|
| **Try with fake money** | Tạo một bot paper chạy thật theo giá thật của SoDEX, nhưng lệnh chỉ được mô phỏng trong DRIFT | Không. Không gửi gì lên SoDEX, không ký, không cần 2FA |
| **Why this one?** | Mở trang giải thích vì sao hệ thống chọn chiến lược này, dựa trên dữ liệu của lần đề xuất đó | Không. Chỉ đọc |
| **Use real money** | Tạo bot thật từ cấu hình đã thử, đi qua đúng luồng Start hiện có | Có. Cần kiểm tra trước khi chạy, xác nhận và 2FA |

**Paper mode chưa tồn tại** trong code: mọi nơi đang ghi "Paper · Coming soon". **Paper mode là một phần bắt buộc của Recommended bản đầu**: không có kết quả thử thì người mới không có căn cứ để quyết định.

"AI" ở Recommended là **quy tắc cố định** (`recommend()`), không phải mô hình ngôn ngữ. Cùng đầu vào cho cùng kết quả. Không được quảng cáo là AI dự đoán thị trường.

## 2. Toàn bộ flow

```
Mở AI Desk › Recommended
  │
  ├─ Trả lời 3 câu: mục tiêu · mức chịu lỗ · số vốn
  │
  ├─ Hệ thống chạy recommend()
  │     ├─ không có gì phù hợp → báo lý do, gợi ý đổi câu trả lời
  │     └─ có → hiện 1 đề xuất
  │
  ├─ [Why this one?] → trang giải thích → quay lại hoặc bấm thử
  │
  └─ [Try with fake money]
        ├─ tạo bot paper, chạy ngay
        ├─ bot đặt lệnh giả theo giá thật, mô phỏng khớp
        ├─ Your bots theo dõi như bot thường, gắn nhãn PAPER
        ├─ khách xem kết quả bất kỳ lúc nào
        └─ khi muốn dùng thật:
              [Use real money] → tính lại cấu hình → form có sẵn → kiểm tra → 2FA → bot live
```

## 3. Bước 1: trả lời câu hỏi

**Bản phác trước đó thiếu mục tiêu và sai mức lỗ. Canvas đã sửa theo mục này.** `recommend()` cần 4 đầu vào (`RecoGoals`):

| Đầu vào | Khách thấy | Giá trị thật | Nguồn |
|---|---|---|---|
| `goal` | What do you want? | `automate`, `range`, `accumulate`, `steady` | [Có sẵn] |
| `maxDrop` | How much loss can you handle? A little / Some / A lot | `5`, `10`, `20` (% vốn) | [Có sẵn], nhãn [Phải làm] |
| `capital` | How much do you want to use? | Số quote, khách nhập | [Có sẵn] |
| `assets` | Không hỏi | Mặc định BTC, ETH | [Cần chốt] |

Đã làm onboarding thì điền sẵn từ `GET /api/v1/goals`.

**Khi bấm:**
1. Web gọi `PUT /api/v1/goals` để lưu câu trả lời. [Có sẵn]
2. Web gọi `POST /api/v1/reco/plan`. [Có sẵn]
3. API đọc thống kê market (biến động, độ đi ngang, funding, giá) và lịch sử trade của khách, gọi `recommend()`, lưu vào `ai_suggestions`.

### 3.1 Goal check: kiểm tra mục tiêu kiếm tiền

Khách nghĩ bằng tiền mỗi ngày, ví dụ "100 USD, mỗi ngày một ly cafe 2 USD". Goal check quy mục tiêu đó ra % năm để khách tự thấy nó cao hay thấp. Dùng chung cho beginner và pro, không bắt buộc nhập. [Phải làm]

**Cách tính:** % năm = số tiền mỗi ngày × 365 ÷ vốn × 100. Vốn cần = số tiền mỗi ngày × 365 ÷ % năm giả định.

| % năm | Nhãn | Câu hiển thị |
|---|---|---|
| ≤ 20% | Reasonable goal | A modest target. It is not guaranteed, and some days will lose money. |
| > 20% đến 100% | Very ambitious | Few strategies keep this up. Chasing it means taking much more risk. |
| > 100% | Not realistic | Reaching this would need very high risk. You could lose most of your money. |

Ngưỡng 20% và 100% là đề xuất ban đầu. [Cần chốt]

**Luật bắt buộc:**
1. Goal check **không ảnh hưởng** đề xuất. Không truyền vào `recommend()`, không tăng đòn bẩy, không nới mức lỗ để đuổi theo mục tiêu.
2. Không được hiện như dự báo. Không dùng "you will earn", không dùng lãi kép, không ước tính thời gian đạt mục tiêu.
3. Dòng vốn cần ở mức 10% và 20% năm phải ghi "Examples, not forecasts".
4. Khi đã có chiến lược Verified, có thể so với kết quả thật của chiến lược đó. Chưa có thì không hiện số so sánh.

Ví dụ:

| Vốn | Mục tiêu mỗi ngày | % năm | Nhãn |
|---|---|---|---|
| 100 USDC | 2 USDC | 730% | Not realistic |
| 1.000 USDC | 2 USDC | 73% | Very ambitious |
| 5.000 USDC | 2 USDC | 14,6% | Reasonable goal |

Vốn 100 USDC có thể không đủ mức tối thiểu của nhiều chiến lược. Khi đó `recommend()` trả trạng thái không có đề xuất, phải hiện đúng lý do.

## 4. Bước 2: hệ thống chọn thế nào

Ví dụ: khách mới, chọn `range`, `Some` (10%), 5.000 USDC, BTC + ETH.

1. **Người mới hay cũ:** dưới 30 vị thế đã đóng là người mới, bỏ qua mọi quy tắc theo lịch sử. Giao diện phải nói rõ gợi ý không dùng lịch sử của khách.
2. **Loại trừ (chỉ người cũ):** ví dụ lệnh dưới 15 phút đang lỗ thì không gợi ý kiểu giao dịch nhanh; lệnh từ 8× gây trên 50% khoản lỗ thì bot perp chỉ dùng 1×.
3. **Lọc ứng viên theo điều kiện thị trường:** ví dụ Grid cần `rangeScore` ≥ 0.6; vốn phải đủ mức tối thiểu của chiến lược; bot futures có mức lỗ tại stop vượt 10% thì bị loại.
4. **Chấm điểm:** mục tiêu + lịch sử + thị trường + chi phí. Ví dụ Spot Grid BTC với `range`: mục tiêu 40, lịch sử 0, thị trường 20 × 0,8 = 16, chi phí 5, tổng 61.
5. **Tính tham số:** khoảng giá, số lưới, stop, `maxLoss` = 5.000 × 10% = 500 USDC.

**Không có ứng viên:** hiện "No strategy fits your answers yet. Try a larger capital or a different goal." kèm lý do trong `notSuggested`. Không được lấp bằng một đề xuất kém.

**Điểm phải sửa:** `recommend()` có thể trả thêm một bot phụ và chia vốn 60/40. Người mới 5.000 USDC sẽ chỉ thấy bot chính dùng 3.000. Recommended chỉ hiện một bot, nên cần thêm tuỳ chọn tắt bot phụ để bot chính dùng đủ vốn. [Phải làm]

## 5. Bước 3: thẻ đề xuất

| Trên thẻ | Lấy từ | Ghi chú |
|---|---|---|
| Spot Grid · BTC | `strategy`, `market` | [Có sẵn] |
| Mô tả chiến lược | Câu cố định theo từng chiến lược | [Phải làm], 7 chiến lược |
| You could lose up to | `values.maxLoss` hoặc `maxLoss` | Xem cảnh báo dưới đây |
| How often / Works best when | Câu cố định theo chiến lược | [Phải làm] |
| When it loses | Câu cố định theo chiến lược | [Phải làm] |
| Nhãn "Suggested for you" | Mọi đề xuất từ quy tắc | Không được ghi "Verified" |

**Mức lỗ phải nói đúng:**
- Có `maxLoss`: ghi "Bot aims to stop near this level. Fast price moves can lose more." Không được ghi "bot luôn dừng đúng mức này", vì giá có thể nhảy qua mức stop.
- Recurring Buy không có stop và không bán: ghi "No loss limit. Value follows the market."
- Mọi chiến lược trả `lossAtStopPct: null` phải kiểm lại từng trường hợp trước khi hiện số.

## 6. "Why this one?"

Mở `/desk/why/<suggestionId>`, gọi `GET /api/v1/reco/suggestions/:id`. **Trang này hiển thị đúng dữ liệu của lần đề xuất đó, không tính lại.** Vì vậy số trên thẻ và trên trang luôn khớp nhau.

| Phần | Nội dung | Nguồn | Trạng thái |
|---|---|---|---|
| Vì sao hợp với bạn | Tối đa 3 lý do | `reasons` | [Có sẵn] |
| Thị trường đang thế nào | Ví dụ "BTC đi ngang 80% số ngày trong 180 ngày qua. Câu này mô tả giá, không phải lợi nhuận." | `basis` | [Có sẵn] |
| Bot sẽ làm gì | Chuyển tham số thành câu thường | `values` | [Phải làm] |
| Vì sao không chọn cái khác | Ví dụ "Futures Grid vượt mức lỗ 10% bạn chọn." | `notSuggested` | [Có sẵn], phải lưu cùng suggestion |
| Khi nào thua | Câu cố định | Theo chiến lược | [Phải làm] |
| Dữ liệu tính lúc | Thời điểm tính, phiên bản quy tắc | `computedAt`, `inputsVersion` | [Có sẵn] |

Ví dụ "Bot sẽ làm gì":

> Bot chia 5.000 USDC thành nhiều lệnh mua và bán từ 90.000 đến 110.000. Giá giảm thì mua, giá tăng thì bán lại. Giá xuống dưới 87.000 thì bot dừng. Nếu lỗ khoảng 500 USDC, bot cũng dừng. Đề xuất này tính lúc 14:30 ngày 31/10.

**Không làm trong bản đầu: khoe kết quả backtest.** Khoảng giá của Grid được chọn từ chính 180 ngày gần nhất, nên backtest trên giai đoạn đó sẽ đẹp giả tạo. Chỉ cho xem nếu có nhãn rõ và không đặt làm số nổi bật. [Cần chốt]

## 7. Lối đi thẳng tiền thật

Recommended không có nút đi thẳng tiền thật. Ai không muốn thử paper thì vào Strategy Lab, dùng link `/bots/new/<strategy>?suggestion=<id>` có sẵn. Có thể đặt link nhỏ "Set it up yourself" ở trang Why this one.

## 8. "Try with fake money": chuyện gì xảy ra

### 8.1 Khi bấm nút

1. Web gọi `POST /api/v1/bots` với cấu hình từ suggestion và `mode: "paper"`. [Phải làm]
2. API lưu bot và phiên bản cấu hình. Bảng `bots` thêm cột `mode` (`live`, `paper`), mặc định `live`. [Phải làm]
3. Bot paper chạy ngay, **không cần** builder fee, API key hay 2FA vì không có tiền thật. Vẫn kiểm tra cấu hình và lệnh tối thiểu. [Phải làm]
4. Tạo số dư giả riêng cho bot bằng đúng số vốn đã chọn. Số này không liên quan ví SoDEX. [Phải làm]
5. Khách được chuyển sang trang bot, có nhãn **PAPER** rõ ở mọi nơi. [Phải làm]

### 8.2 Khi bot chạy

Chiến lược và engine giữ nguyên `step()`, chỉ thay cổng đặt lệnh:

| Thành phần | Bot live | Bot paper |
|---|---|---|
| Giá, sổ lệnh, funding | Thật | Thật, cùng nguồn |
| Logic chiến lược | `step()` | `step()`, cùng code |
| Cổng đặt lệnh | `HttpGateway`, ký và gửi SoDEX | `PaperGateway` mới, không ký, không gọi SoDEX |
| Khớp lệnh | SoDEX | Mô phỏng trong DRIFT |
| Phí | Thật | Tính theo mức phí thật |

**Luật mô phỏng khớp (đề xuất, phải kiểm lại khi code):**
- Lệnh limit: chỉ khớp khi giá **đi xuyên qua** giá lệnh, không khớp khi vừa chạm. Khách có thể đứng sau hàng đợi nên tính bảo thủ.
- Lệnh market: khớp ở giá xấu của sổ lệnh, cộng trượt giá 0,05% như `BACKTEST_SLIPPAGE`.
- Phí: maker hoặc taker cộng builder fee.
- Perps: tính funding theo dữ liệu thật.
- Số dư giả không đủ thì từ chối lệnh, giống SoDEX.

Ví dụ ngày đầu:

| Lúc | Xảy ra | Kết quả giả |
|---|---|---|
| 14:30 | Bot đặt 20 lệnh mua, 20 lệnh bán | Không có gì lên SoDEX |
| 18:10 | Giá BTC đi xuyên 99.000 | Lệnh mua 0,01 BTC khớp, trừ phí giả |
| 22:45 | Giá đi xuyên 100.000 | Lệnh bán khớp, lãi giả 10 USDC trừ phí |

### 8.3 Điều bắt buộc về an toàn

1. Bot paper **không bao giờ** được đi qua `HttpGateway`. Engine phải chọn cổng theo `mode` tại một chỗ, có test riêng, và `HttpGateway` tự từ chối nếu nhận bot paper.
2. Dữ liệu paper **không được** tính vào: Portfolio, Home, equity, Volume, Builder Revenue, Risk Center, Emergency Halt của tiền thật, đối soát phí.
3. Bot paper không chiếm rate limit ghi và không ảnh hưởng bot thật.
4. Không gọi lệnh paper là "lời" thật. Mọi số có nhãn **Simulated**.

### 8.4 Màn hình bot paper (canvas: AI Desk · Fake-money test)

Mở ngay sau khi bấm nút. Your bots cũng có thẻ dẫn tới đây.

| Khối | Nội dung | Cách tính |
|---|---|---|
| Đầu trang | Tên bot, nhãn PAPER, Day N | N tính từ lúc bot bắt đầu |
| Simulated balance | Số dư giả hiện tại | Tiền giả + coin giả × giá hiện tại |
| Simulated profit | Lãi / lỗ sau phí | Balance − vốn ban đầu |
| Fees | Phí giả đã trả | Tổng phí từng lệnh mô phỏng, cộng funding với perps |
| Trades | Số lần khớp | Đếm fill mô phỏng |
| Biggest drop | Sụt giảm lớn nhất | Từ đỉnh tới đáy của balance, so với giới hạn lỗ của khách |
| Biểu đồ | Balance theo ngày | Ghi snapshot mỗi phút, gom theo ngày |
| What the bot did | Nhật ký lời thường | Từ sự kiện bot và fill mô phỏng |
| Hành động | See results · Stop test | |

Ngày đầu chưa có lệnh khớp: hiện "Waiting for the price to reach the first order", không hiện biểu đồ trống.

Bot chạm stop hoặc `maxLoss`: dừng như bot thật, gửi thông báo ghi rõ "fake money", mở trang kết quả.

### 8.5 Trang kết quả (canvas: AI Desk · Test results)

Xem được bất kỳ lúc nào, không cần chờ hết kỳ. Kết luận là **quy tắc cố định**, không để AI viết tự do:

| Điều kiện (xét theo thứ tự) | Kết luận hiện ra |
|---|---|
| Chạm stop hoặc giới hạn lỗ | Reached your loss limit |
| Dưới 14 ngày (`minDaysForComparison`) | Too early to judge |
| Lỗ, chưa chạm giới hạn | Lost money, within your limit |
| Có lãi, chưa chạm giới hạn | Made money, within your limit |

Hệ thống **không bao giờ** kết luận "nên dùng tiền thật". Chỉ trình bày, khách tự quyết.

Nội dung trang:
- Kết luận và số dư cuối, lãi / lỗ, phí, số lệnh, sụt giảm lớn nhất.
- **So với chỉ giữ BTC:** vốn × (giá cuối / giá đầu − 1). Bot thua việc giữ coin cũng phải hiện thẳng, không giấu.
- **Vì sao ra kết quả này:** câu theo quy tắc từ số liệu, ví dụ giá ra khỏi khoảng bao nhiêu ngày, phí chiếm bao nhiêu phần lãi.
- Câu bắt buộc: *"Simulated results can look better than real trading. Real orders may not fill the same way."*
- Hành động: **Use real money** · Keep testing · Try another strategy. Kết quả lỗ vẫn có nút Use real money nhưng không phải nút chính.

### 8.6 Khi nào hết paper

Không tự kết thúc, trừ khi chạm stop hoặc khách dừng. Gợi ý xem kết quả sau 14 và 30 ngày bằng thông báo. Khách có thể dùng thật bất kỳ lúc nào. [Cần chốt, xem mục 10]

## 9. "Use real money"

Màn hình: canvas AI Desk · Use real money.

1. Bấm trên trang kết quả.
2. Hệ thống **tính lại tham số** bằng `aiParameters()` với giá hiện tại, vì khoảng giá cũ có thể đã lệch. [Có sẵn hàm, phải nối]
3. Có khác cấu hình paper thì nêu rõ: "Grid range moved from 90,000–110,000 to 95,000–115,000." [Phải làm]
4. Hiện cấu hình thật, số dư thật trên SoDEX và kết quả `startChecks`. Thiếu vốn hoặc thiếu builder fee thì báo và chặn. Khách vẫn mở được form để chỉnh.
5. Khách tick xác nhận và nhập 2FA, gọi `startBot` như luồng cũ.
6. Tạo bot **mới** `mode: live`. Bot paper dừng, kết quả giữ lại để so sánh.

Bot paper không được đổi `mode` tại chỗ: tránh lẫn dữ liệu giả và thật trên cùng một bot.

## 10. Cần chốt trước khi code

| # | Câu hỏi | Tao đề xuất | Lý do |
|---|---|---|---|
| 1 | Có bắt buộc đủ 30 ngày paper mới dùng thật? | Không, chỉ cảnh báo | Strategy Lab vẫn cho chạy thật ngay, khoá ở đây không có tác dụng. Mốc 30 ngày chỉ giữ cho nhãn Verified |
| 2 | Chưa kết nối SoDEX có dùng được Recommended và paper không? | Có, để người mới thử trước | Cần kiểm tra và sửa vì API đề xuất đang đọc account đã kết nối |
| 3 | Một khách chạy tối đa bao nhiêu bot paper? | 3 | Mỗi bot tốn tài nguyên engine |
| 4 | Tài sản mặc định? | BTC, ETH | Thanh khoản tốt, dễ hiểu |
| 5 | Có hiện backtest ở Why this one? | Chưa | Tránh số đẹp giả tạo (mục 6) |

## 11. Việc phải code

**Recommended:** trang AI Desk và 3 câu hỏi · tắt bot phụ · câu mô tả 7 chiến lược · trang Why this one · lưu `notSuggested` cùng suggestion.

**Paper mode (cùng bản đầu):** cột `mode` · `PaperGateway` và mô phỏng khớp · số dư giả · snapshot balance · tách dữ liệu paper khỏi mọi thống kê · nhãn PAPER và Simulated · trang bot paper · trang kết quả · màn Use real money · bộ test an toàn ở mục 8.3.

Chi tiết Ask AI viết riêng.
