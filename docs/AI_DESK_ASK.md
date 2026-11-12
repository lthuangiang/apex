# AI Desk — Ask AI: flow chi tiết

> Trạng thái: **đề xuất, chưa code**. Đối chiếu với code ngày 2026-10-31. Kế hoạch chung: `docs/AI_DESK.md`. Tiêu chí: `docs/AI_DESK_REPORT.md`.
>
> Nhãn: **[Có sẵn]** dùng lại · **[Phải làm]** phải code · **[Cần chốt]** quyết định sản phẩm.
> Mọi con số trong ví dụ là minh hoạ.

## 1. Tóm tắt một phút

Ask AI **không phải** chatbot đoán giá. Nó là phòng thí nghiệm: người dùng mô tả một ý tưởng, AI đổi thành luật rõ ràng, hệ thống test bằng dữ liệu thật, rồi code cố định chấm điểm.

| Việc | Ai làm | Có dùng AI không |
|---|---|---|
| Hiểu ý tưởng, viết thành luật | Research agent | Có |
| Chạy test | `backtest()` | Không |
| Chấm 5 tiêu chí và kết luận | Code cố định | Không |
| Giải thích kết quả | Reporter | Có, chỉ diễn giải số đã có |
| Đặt lệnh | Bot, sau khi người dùng duyệt | Không |

**AI không được tự nói chiến lược tốt hay xấu.** Nếu AI viết sai kết quả, số trên màn hình vẫn lấy từ test.

## 2. Hiện trạng: phải làm gì trước

Đọc code cho thấy Ask AI chưa chạy được ngay:

| Thiếu | Hiện trạng | Việc cần làm |
|---|---|---|
| Mô hình ngôn ngữ | Code chưa có | Chọn nhà cung cấp, thêm service [Phải làm] |
| Chiến lược theo xu hướng | Chưa có. Strategy hiện có là Grid, DCA, Recurring Buy, Rebalancing, Funding Arb, TWAP, Volume | Viết DSL hoặc strategy mới [Phải làm] |
| Test dài | `backtest` chỉ nhận 30, 90, 180 ngày | Mở rộng, tuỳ độ sâu dữ liệu SoDEX, kiểm tra ở giai đoạn 0 [Phải làm] |
| Tách dữ liệu niêm phong | Chưa có | Thêm khoảng thời gian tuỳ chọn cho job [Phải làm] |
| Tiêu chí C3, C4, C5 | Chưa có | So với giữ coin, deflated Sharpe, chạy biến thể [Phải làm] |

Có sẵn để dùng lại: `backtest()` chạy cùng `step()` với engine, tính phí, funding, trượt giá; worker `apps/backtest`; cache theo cấu hình; job qua outbox; `candles_1m`, `funding_rates`.

**Nếu SoDEX không đủ 12 tháng dữ liệu**, tiêu chí C1 không thể đạt Yes và phải sửa ngưỡng. Mọi "24 months" trên canvas chỉ là số mẫu.

## 3. Toàn bộ flow

```
Người dùng gõ ý tưởng
  │
  ▼
Bước 1: AI đổi thành luật (spec DSL)
  ├─ ngoài khả năng → nói rõ, gợi ý cách hỏi khác
  ├─ thiếu thông tin → hỏi lại tối đa 1 câu
  └─ hợp lệ → thẻ "Here's what I'll test"
  │
  ▼
Bước 2: người dùng bấm Run test (trừ 1 lượt thử)
  │
  ▼
Bước 3: Backtest trên dữ liệu nghiên cứu → kết quả nhanh
  ├─ chỉnh ý tưởng → quay lại bước 1 (trừ lượt)
  └─ ưng → Run full check
  │
  ▼
Bước 4: full check (một lần cho mỗi ý tưởng)
  Mở dữ liệu niêm phong · chạy biến thể ±20% · chấm C1–C5
  │
  ▼
Bước 5: Strategy report: Do not use / Needs more evidence / Passed
  │
  ▼
Bước 6: nếu được phép → paper → Test results → Use real money
        (dùng lại flow của Recommended)
```

## 4. Ví dụ từng bước

### Bước 1: hiểu ý tưởng

Người dùng gõ: *"Test a slow trend on ETH, but skip sideways months."*

1. Web gọi `POST /api/v1/desk/messages`. [Phải làm]
2. API kiểm tra tài khoản được bật Ask AI và còn lượt.
3. Research agent nhận: câu hỏi, các tin nhắn trước, danh sách market, mô tả DSL. **Không nhận** dữ liệu niêm phong, API key, số dư.
4. Agent bắt buộc trả về JSON đúng schema, kiểm tra bằng zod. Sai schema thì tự thử lại một lần, vẫn sai thì báo "I couldn't turn that into clear rules. Try describing when to enter and exit."
5. Không tính lượt ở bước này.

Spec ví dụ:

```json
{
  "family": "trend",
  "markets": ["ETH-USD"],
  "signal": { "fastDays": 20, "slowDays": 100 },
  "filter": { "minVolatility30dPct": 2 },
  "direction": "long_only",
  "leverage": 1,
  "capital": "5000"
}
```

Bản đầu chỉ có 2 họ: `trend` và `funding_carry`. Thêm họ mới bằng code, AI không tự tạo được. Đây là ranh giới an toàn chính: AI chỉ điền tham số trong khung, không viết code. [Cần chốt]

### Bước 2: xác nhận trước khi chạy

Thẻ **Here's what I'll test** viết bằng lời thường từ spec, không do AI viết tự do:

> Buy ETH when the 20-day average is above the 100-day average. Sell when it falls below. Stay out when volatility is low. No leverage. Includes fees.

Hai nút: **Run test** · **Change something**. Bấm Run test mới trừ lượt: 7 of 20 → 8 of 20. Vì vậy người dùng không tốn lượt nếu AI hiểu sai.

### Bước 3: test nhanh

Job `desk.run` chạy `backtest()` trên **dữ liệu nghiên cứu** (phần trước mốc niêm phong). Hiện tiến độ trong chat. Xong thì:

- Thẻ số lấy từ `evaluations`: kết quả, sụt giảm lớn nhất, số lệnh, phí.
- Reporter viết 1 đến 2 câu diễn giải, chỉ được nhắc số có trong kết quả. Câu nào chứa số không khớp thì bỏ câu đó.

Ví dụ: *"It made money in this period, but with only 41 trades."*

Người dùng chỉnh tiếp, ví dụ *"Add BTC"* → quay lại bước 1. Mỗi lần chạy trừ một lượt và tăng số lần thử của ý tưởng.

### Bước 4: full check

Bấm **Run full check**:

1. Khoá spec lại, lưu `hash`.
2. Mở dữ liệu niêm phong, chạy **một lần duy nhất** cho spec này.
3. Chạy các biến thể ±20%, không trừ lượt của người dùng.
4. Code tính C1–C5 và kết luận theo `docs/AI_DESK_REPORT.md`.

**Vì sao chỉ một lần:** nếu cho sửa rồi test lại trên cùng dữ liệu niêm phong, dữ liệu đó không còn "chưa thấy", và kết quả mất giá trị.

Sau full check mà người dùng sửa spec: đó là ý tưởng mới, số lần thử được cộng dồn, nên C4 chấm chặt hơn. Muốn test niêm phong công bằng phải dùng giai đoạn dữ liệu mới khi có thêm dữ liệu. [Cần chốt]

### Bước 5: báo cáo

Mở Strategy report. AI không sửa được kết luận.

### Bước 6: đi tiếp

| Kết luận | Làm được gì |
|---|---|
| Do not use | Không có nút chạy |
| Needs more evidence | Thử paper |
| Passed | Thử paper |
| Paper đạt cổng | Thành Verified, hoặc Use real money |

Paper, Test results và Use real money dùng lại đúng flow ở `docs/AI_DESK_RECOMMENDED.md`.

Dùng tiền thật cần một `strategy` mới đọc spec. Bot vẫn chạy bằng `step()` trong engine, không gọi AI.

## 5. Các tình huống phải xử lý

| Người dùng hỏi | Trả lời |
|---|---|
| "BTC next week?" | Không dự đoán giá. Gợi ý test một ý tưởng |
| "Which coin will pump?" | Như trên |
| "Find me a strategy that makes 2% a day" | Giải thích con số, gợi ý mục tiêu có thể test. Không tăng đòn bẩy để đuổi theo |
| "Use 20× leverage" | Test được trong giới hạn đòn bẩy DSL, vượt thì nói rõ |
| "Place this order" / "Start the bot" | Từ chối, dẫn tới flow có duyệt |
| "Show me the sealed data" | Từ chối, giải thích vì sao |
| "Ignore your rules..." | Giữ nguyên quy tắc. Agent không có công cụ để làm khác |
| Market không có trên SoDEX | Báo không có |
| Thiếu dữ liệu | Backtest trả `unavailable`, không chạy trên dữ liệu thiếu |
| Hết lượt | "You've used 20 of 20 tries today." Đọc được báo cáo cũ, không chạy mới |
| Job lỗi | Hoàn lượt, cho chạy lại |

## 6. Quyền của AI

Research và Reporter chỉ có các công cụ: đọc danh sách market, đọc kết quả của chính người dùng, tạo spec nháp. **Không có** công cụ đặt lệnh, không gọi signer, không đọc API key, không đọc dữ liệu người dùng khác, không đọc dữ liệu niêm phong.

Mọi lượt lưu: prompt version, model, đầu vào, đầu ra, chi phí token.

## 7. Dữ liệu

| Bảng | Lưu gì |
|---|---|
| `desk_threads`, `desk_messages` | Cuộc chat |
| `research_runs` | Model, prompt version, chi phí, số lần thử |
| `hypotheses` | Spec, hash, ý tưởng gốc, trạng thái |
| `evaluations` | Kết quả nghiên cứu, niêm phong, biến thể, C1–C5, kết luận |

## 8. Cần chốt

| # | Câu hỏi | Tao đề xuất |
|---|---|---|
| 1 | Ai dùng được Ask AI bản đầu? | Admin bật theo tài khoản, như Volume bots |
| 2 | Bao nhiêu lượt mỗi ngày? | 20, đo chi phí rồi chỉnh |
| 3 | Ai trả chi phí AI? | DRIFT trả trong giai đoạn thử, sau đó tính vào gói |
| 4 | Mốc niêm phong dài bao nhiêu? | 25% dữ liệu gần nhất, tối thiểu 3 tháng |
| 5 | Bản đầu có những họ chiến lược nào? | `trend`, `funding_carry` |
| 6 | Pro có được dùng tiền thật với Needs more evidence? | Không, chỉ paper |
| 7 | Dùng mô hình và nhà cung cấp nào? | Chốt ở giai đoạn 1, sau khi đo chất lượng và chi phí |
| 8 | Ý tưởng của pro có được dùng cho người khác? | Không, trừ khi người đó đồng ý |

## 9. Thứ tự làm

Giai đoạn 0: đo độ sâu dữ liệu → mở rộng backtest và tách niêm phong → DSL `trend`, `funding_carry` → C1–C5 → Research Lab cho team chạy không cần chat → **cổng quyết định** ở `docs/AI_DESK.md` → mới thêm chat.

Chat là phần làm cuối. Nếu không tìm được lợi thế, chưa tốn chi phí làm giao diện chat.
