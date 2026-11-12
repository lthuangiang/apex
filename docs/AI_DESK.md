# DRIFT — AI Desk (kế hoạch, 2026-10-31)

> **Cập nhật 2026-11-11 (DEC-164):** hướng sản phẩm của AI Desk là **concept B+ (DEC-166)**: người quản lý tiền có what-if, thành tích và nút ✦ ở mọi màn; chat của **concept B "Desk AI"** thành panel: trợ lý trò chuyện cho người mới (báo cáo sáng, sửa lỗi có xem trước, hỏi đáp, tạo bot qua chat, theo tiếp). Thiết kế: canvas "AI Desk redesign", hàng "AI Desk · concept B+" (màn chính) và "AI Desk · concept B" (các màn chat). Ask AI dạng phòng thử giả thuyết (mục 4, `AI_DESK_ASK.md`) và Research Lab vẫn để sau. Nguyên tắc ở mục 3 giữ nguyên. LLM, chi phí, lưu trữ, giờ báo cáo và pháp lý: DEC-165 (Claude API, `claude-sonnet-5-5`, 20 câu/ngày, 90 ngày, 08:00 giờ địa phương, beta đóng).

> **Đã code (2026-11-12, AI Desk B+):** trang chủ `/desk` (thẻ Mục tiêu, Needs you có what-if, sức khoẻ bot, Desk AI panel), so sánh phương án `/desk/compare/:id` và Apply thành version "AI suggested" (DEC-176), Thành tích `/desk/record` + Switch back (DEC-177), Desk AI hỏi đáp / báo cáo sáng / lịch sử (DEC-188, DEC-189), lần đầu chưa có bot, tạo bot qua chat (tiền ảo trước), báo kết quả tiền ảo, nút ✦ "Ask about this" trên Trading Agent / Strategy Lab / Portfolio (DEC-TBD-desk-chat). Route: `docs/SCREENS.md` mục AI Desk; bảng: `docs/DOMAIN.md` mục 7.6. E2E: `e2e/flows/tests/p14-desk.spec.ts` (Claude API giả). Luật cứng của Desk AI: code tạo fact, LLM chỉ viết lời, mọi số phải khớp fact, ngoài phạm vi / hết lượt / LLM lỗi → câu mẫu, không có công cụ thực thi.

> Trạng thái: **giai đoạn A đã code (2026-11-04, DEC-105)**; giai đoạn 0 đo dữ liệu ở `docs/AI_DESK_DATA.md`; Ask AI, Research Lab chưa làm. Bằng chứng nền: `reports/Chiến lược bot crypto perps.md` (repo altisss-agent-team).
> Tên làm việc trước đây: Quant Desk. Mockup: hàng "AI Desk" trên canvas DRIFT Redesign. Flow chi tiết: `docs/AI_DESK_RECOMMENDED.md`.

## 1. Ý tưởng

AI Desk là bàn làm việc của đội AI, phục vụ hai nhóm khách trên cùng một dây chuyền kiểm định. Giá trị là **sàng lọc**: thử nhiều chiến lược, loại gần hết, chỉ trình ra cái còn sống sót kèm bằng chứng. **AI không ra lệnh.** Lệnh do strategy thuần trong `packages/strategies` đặt, qua engine và risk hiện có.

Lý do: LLM trực tiếp giao dịch không có bằng chứng lợi thế (Alpha Arena, FINSABER), còn dùng AI để tăng tốc nghiên cứu thì không chịu độ trễ, không tốn phí giao dịch và tái lập được.

## 2. Cấu trúc sản phẩm

| Phần | Cho ai | Làm gì | Nguồn |
|---|---|---|---|
| **Recommended** | Beginner | Không gõ gì. Chọn mức chịu lỗ, nhập vốn, nhận một đề xuất bằng lời thường | `packages/shared/src/reco/engine.ts`, sau này thêm chiến lược đã kiểm định |
| **Your bots** | Mọi người | Nhận xét về bot kèm hành động, thay cho "hãy kiểm tra lại" | Quy tắc của AI Analyst (`packages/shared/src/portfolio/analyst.ts`) |
| **Ask AI** | Pro | Chat để dò chiến lược; mỗi ý tưởng đi qua dây chuyền | Mô hình ngôn ngữ + Research, Backtest, Skeptic |
| **Research Lab** | Chỉ team | Theo dõi dây chuyền, giả thuyết, bản tin | Nội bộ, khách không thấy |

- Mục **AI Analyst bỏ khỏi sidebar**, gộp vào AI Desk. Thứ tự sidebar: AI Desk → Strategy Lab → Trading Agent.
- Không có công tắc Beginner / Pro. Onboarding hỏi "đã từng trade chưa" để chọn màn mở đầu; đổi lúc nào cũng được. Ai muốn tự chỉnh thì sang Strategy Lab.
- Bot sinh ra từ AI Desk vẫn là bot bình thường, dùng chung Trading Agent, Home và Risk.
- Nhãn phải đúng: gợi ý từ quy tắc ghi "Suggested for you"; chỉ chiến lược đã qua dây chuyền mới được ghi "Verified". Chưa có thì hiện trạng thái trống, không lấp bằng số mẫu.

## 3. Nguyên tắc không đổi

1. AI không gọi signer, không đặt lệnh, không có API key. Chỉ đọc dữ liệu và ghi vào bảng của AI Desk.
2. Risk chỉ được giảm: agent được giảm size, pause, đề nghị dừng; không được tăng đòn bẩy, size hay vượt giới hạn account.
3. Chiến lược là cấu hình trong khung có sẵn, không phải code tự do. Khung là DSL khai báo, kiểm tra bằng zod, chạy bằng hàm thuần `step()`.
4. Mọi quyết định có nhật ký: đầu vào, phiên bản prompt và model, kết quả, lý do.
5. Khách duyệt mọi bước lên tiền thật, kèm 2FA.
6. Không hứa lợi nhuận, không ước tính SoPoints. "Không tìm thấy lợi thế" là kết quả hợp lệ.

## 4. Giới hạn của Ask AI

1. Chat không đặt lệnh và không có đường tắt: chỉ tạo giả thuyết, giả thuyết phải qua đủ dây chuyền.
2. Chat không xem được holdout. Mọi lần thử được đếm theo tài khoản, thử càng nhiều Skeptic chấm càng chặt.
3. Có trần số lần thử và token mỗi ngày, hoặc tính vào gói trả phí.

## 5. Đội agent

| Agent | Việc | Quyền |
|---|---|---|
| Research | Sinh giả thuyết từ dữ liệu và câu hỏi của pro, viết spec DSL | Đọc dữ liệu, ghi spec |
| Backtest | Chạy spec qua `runBacktest`, tính sau phí và funding, tách in-sample / holdout | Chạy job backtest |
| Skeptic | Bác bỏ: đếm số lần thử, deflated Sharpe, đổi tham số, đổi giai đoạn, so với ngẫu nhiên | Ghi verdict, có quyền loại |
| Risk | Đọc bot đang chạy, đề nghị giảm size hoặc pause theo luật | Chỉ giảm |
| Reporter | Viết bản tin ngày và giải thích | Chỉ đọc |

Điều phối bằng job trong `apps/jobs`, không phải vòng lặp agent tự do. Mỗi lượt có ngân sách token và giới hạn số lần thử.

## 6. Dây chuyền

```
Hypothesis → Backtest → Skeptic → Paper → Small live → Live
```

| Cổng | Điều kiện qua (mặc định, chỉnh sau khi có dữ liệu) |
|---|---|
| Backtest → Skeptic | Sau phí và funding dương; tối thiểu 100 lệnh hoặc 12 tháng |
| Skeptic → Paper | Holdout không thua buy-and-hold rủi ro tương đương; deflated Sharpe qua ngưỡng; ổn định khi đổi tham số ±20% |
| Paper → Small live | Tối thiểu 30 ngày; PnL paper nằm trong khoảng kỳ vọng từ backtest; khách duyệt + 2FA |
| Small live → Live | Tối thiểu 60 ngày; slippage thực không tệ hơn giả định; khách duyệt + 2FA |
| Tự xuống hạng | Drawdown vượt ngưỡng, hoặc kết quả ra khỏi khoảng kỳ vọng |

## 7. Giai đoạn

**Giai đoạn A (làm được ngay, song song): AI Desk bằng quy tắc, kèm Paper mode.** Gộp AI Analyst vào AI Desk. Recommended dùng engine khuyến nghị sẵn có, có Paper mode và trang kết quả (`docs/AI_DESK_RECOMMENDED.md`); Your bots đổi nhận xét thành hành động, bấm là tạo bản nháp thay đổi để khách duyệt. Không cần mô hình ngôn ngữ, không ghi "Verified".

**Giai đoạn 0 (1 tuần): kiểm tra dữ liệu.** Xác nhận phí spot và taker, lệnh tối thiểu, rate limit, lịch funding, public trades của SoDEX. Đủ sâu lịch sử candles và funding cho backtest. Kết thúc: bảng thông số, biết thiếu gì.

**Giai đoạn 1 (3 tuần): Research Lab, chỉ team, không đặt lệnh.** DSL chiến lược (bắt đầu từ trend chậm và funding carry), Research + Backtest + Skeptic, sổ thí nghiệm. Kết thúc: chạy 50+ giả thuyết. **Cổng quyết định:** có ít nhất một chiến lược qua Skeptic trên SoDEX? Không có thì dừng mở rộng, AI Desk chỉ giữ giai đoạn A, Lab là công cụ nội bộ.

**Giai đoạn 2 (3 tuần): Paper cho chiến lược của Lab.** Dùng lại Paper mode của giai đoạn A để chạy 30 ngày các chiến lược đã qua Skeptic, thêm trang Report và bản tin ngày. Paper mode cũng mở cho mọi bot hiện có ("Paper · Coming soon").

**Giai đoạn 3 (3 tuần): Verified và Ask AI.** Chiến lược đã kiểm định lên Recommended; mở Ask AI cho pro; duyệt live vốn nhỏ; Risk agent. Admin bật theo tài khoản như Volume bots.

**Giai đoạn 4: mở rộng.** Mở rộng rãi sau khi có tư vấn pháp lý về việc gợi ý chiến lược. Cân nhắc cho chiến lược của pro thành nguồn đề xuất cho beginner.

Ước lượng là phỏng đoán ban đầu, chưa tính sức đội.

## 8. Dữ liệu mới

- `research_runs`: câu hỏi hoặc mục tiêu, model, prompt version, ngân sách, số lần thử.
- `hypotheses`: spec DSL, giả thuyết, hash, trạng thái theo dây chuyền.
- `evaluations`: kết quả backtest, verdict Skeptic, số liệu holdout.
- `desk_notes`: bản tin ngày.
- Bot sinh từ Desk dùng lại `bots` + `bot_versions`, thêm `hypothesis_id`.

## 9. Chi phí

Agent chạy theo lượt, không chạy mỗi phút. Chi phí chính là backtest và token nghiên cứu; Ask AI làm chi phí tăng theo từng khách nên cần trần theo tài khoản. Số cụ thể đo ở giai đoạn 1.

## 10. Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Đội AI không tìm được lợi thế | Cổng ở giai đoạn 1; giai đoạn A vẫn có giá trị riêng; nói thẳng với khách |
| Overfitting do thử nhiều | Đếm mọi lần thử, deflated Sharpe, holdout niêm phong, Research và chat không xem holdout |
| Beginner hiểu gợi ý là cam kết | Lời thường, nêu rõ có thể lỗ bao nhiêu, phân biệt "Suggested" và "Verified" |
| Prompt injection từ dữ liệu ngoài | Dữ liệu ngoài là dữ liệu, agent không có quyền đặt lệnh |
| Pháp lý | Gợi ý chiến lược gần với tư vấn đầu tư; tư vấn trước khi mở rộng; không hứa lợi nhuận |
| Rate limit dùng chung | Backtest dùng dữ liệu đã lưu, không gọi SoDEX trực tiếp |

## 11. Cần quyết định

1. Đã chốt: tên **AI Desk**, mục riêng trên sidebar; chat cho pro, đề xuất sẵn cho beginner; không có công tắc mode.
2. Bản đầu của Research Lab cho team nội bộ (đề xuất) hay cho vài khách thử?
3. Trần chi phí AI mỗi tài khoản và ai trả?
