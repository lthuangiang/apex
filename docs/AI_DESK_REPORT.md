# AI Desk — Strategy report: tiêu chí và cách trình bày

> Trạng thái: **đề xuất, chưa code**. Kế hoạch chung: `docs/AI_DESK.md`. Mọi ngưỡng trong tài liệu là đề xuất ban đầu, chỉnh sau khi có dữ liệu thật.

## 1. Hai loại giải thích, không được lẫn

| | Why this one? | Strategy report |
|---|---|---|
| Dùng cho | Gợi ý theo quy tắc (Spot Grid, DCA...) | Chiến lược do đội AI nghiên cứu |
| Trả lời | Vì sao hợp với **mục tiêu của tôi**? | Chiến lược này có **bằng chứng** không? |
| Có kiểm định | Không | Có |
| Nhãn | Suggested for you | Passed, Needs more evidence, Do not use, Verified |
| Tài liệu | `docs/AI_DESK_RECOMMENDED.md` | Tài liệu này |

## 2. Report phải trả lời 3 câu của khách

1. **Tôi nên làm gì?** Một kết luận duy nhất ở đầu trang.
2. **Tiền của tôi có thể ra sao?** Quy ra số tiền của khách, không dùng tỷ lệ kỹ thuật.
3. **Vì sao tin được?** 5 câu hỏi, mỗi câu trả lời Yes, Not sure hoặc No kèm một câu giải thích.

Không có chữ Sharpe, drawdown, holdout, overfitting ở bản Simple.

## 3. Ba phiên bản của cùng một báo cáo

Cùng dữ liệu, chỉ khác độ sâu. Khách bấm chuyển được.

| Phiên bản | Cho ai | Hiện gì |
|---|---|---|
| **Simple** | Mặc định, mọi người | Kết luận · số tiền · 5 câu hỏi · việc tiếp theo |
| **Detailed** | Muốn xem bằng chứng | Thêm số đo được và mức cần đạt của từng câu |
| **Pro** | Người quen quant | Thêm chỉ số kỹ thuật |

## 4. Năm tiêu chí

Tính trên kết quả đã trừ phí và funding.

| # | Câu hỏi (Simple) | Đo gì | Yes | Not sure | No |
|---|---|---|---|---|---|
| C1 | Did it make money after fees? | Lãi ròng toàn kỳ | > 0 và kỳ ≥ 12 tháng | > 0 và kỳ dưới 12 tháng | ≤ 0 |
| C2 | Did it work on data the AI never saw? | Lãi ròng trên giai đoạn niêm phong | > 0 | Niêm phong dưới 3 tháng | ≤ 0 |
| C3 | Is it better than just holding? | Lãi so với giữ coin cùng mức rủi ro, trên giai đoạn niêm phong | Hơn từ 10% trở lên | Hơn dưới 10% | Thua |
| C4 | Could it be luck? | Số lệnh và deflated Sharpe (đã tính số lần thử) | ≥ 100 lệnh và ≥ 0,95 | 30–99 lệnh hoặc 0,80–0,95 | Dưới 30 lệnh hoặc dưới 0,80 |
| C5 | Does it survive small changes? | Tỷ lệ biến thể tham số ±20% có lãi | ≥ 90% | 70–89% | Dưới 70% |

"Không có dữ liệu" tính là Not sure, không được coi là Yes.

## 5. Kết luận là quy tắc cố định

Xét theo thứ tự, AI không được tự viết kết luận:

| Điều kiện | Kết luận | Câu chính | Ai thấy | Việc tiếp theo |
|---|---|---|---|---|
| Có ít nhất một No | **Do not use** | Do not use this strategy. | Pro, Research Lab | Không có nút chạy |
| Có Not sure | **Needs more evidence** | Promising, but not proven. Only test it with fake money. | Pro, Research Lab | Thử paper, chỉ pro |
| Cả 5 là Yes | **Passed** | Passed our tests. Next step is 30 days with fake money. | Pro, Research Lab | Paper 30 ngày |
| Passed và paper đạt cổng ở `docs/AI_DESK.md` | **Verified** | Verified. It passed our tests and 30 days with fake money. | Mọi người, cả beginner | Vào Recommended |

Beginner chỉ thấy chiến lược Verified. Hiện chưa có chiến lược nào đạt mức này.

## 6. Phần tiền

Quy kết quả về vốn khách đã nhập, hoặc 5.000 USDC nếu chưa nhập.

| Dòng trên trang | Cách tính |
|---|---|
| End result | Vốn × lãi ròng % toàn kỳ |
| Worst drop | Vốn × sụt giảm lớn nhất % |
| Months up / down | Đếm tháng lãi và tháng lỗ |
| On data the AI never saw | Vốn × lãi ròng % giai đoạn niêm phong |

Luôn kèm: *"Past results do not predict future returns."* Chỉ số chưa đo được thì ghi "Not measured".

## 7. Bản Pro

Kỳ dữ liệu · số lệnh · Sharpe in-sample · Sharpe niêm phong · deflated Sharpe · số lần thử · max drawdown · tỷ lệ biến thể ±20% có lãi.

## 8. Cần chốt

1. Ngưỡng ở mục 4, nhất là mốc 0,95 và 100 lệnh. Chiến lược chậm rất khó đủ 100 lệnh.
2. Chiến lược Needs more evidence có cho pro thử bằng tiền thật không? Tao đề xuất không, chỉ paper.
3. Beginner có nên thấy danh sách "Do not use" để tin hệ thống hơn không? Tao đề xuất chỉ hiện số đếm, ví dụ "33 of 38 ideas rejected".
