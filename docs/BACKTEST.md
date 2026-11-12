# DRIFT — Backtest

> Một phần của bộ tài liệu DRIFT. Đọc `CLAUDE.md` ở gốc repo trước. Số mục giữ nguyên như bản gốc để các tham chiếu "mục X" vẫn đúng (xem bảng mục lục trong `CLAUDE.md`).

## 11. Backtest

### 11.1 Hành vi trên UI (tab `Backtest` trong panel trực quan của màn tạo bot)
- Chọn kỳ 30D / 90D (mặc định) / 180D. Chỉ chạy khi bấm `Run backtest`, không tự chạy.
- Dùng giá trị field hiện tại (AI hoặc đã sửa). Khi đổi field hoặc đổi kỳ thì kết quả cũ hiện "Out of date · run again".
- Các trạng thái: `idle` → `running` ("Simulating N one-minute candles…") → `done` | `failed` (kèm lý do, nút thử lại) | `unavailable` ("Backtest unavailable for this market").
- Kết quả gồm:
  - kết quả ròng sau phí (giá trị tuyệt đối và %), phí (cộng funding với perps), max drawdown;
  - 1–2 chỉ số riêng của chiến lược (bảng dưới);
  - đường equity mô phỏng (đường nét đứt = mức vốn ban đầu) và danh sách "Assumptions".
- Luôn hiện câu: "Simulated on past prices. Not a forecast; future results will differ." **Không** hiển thị APR hay lợi nhuận kỳ vọng.

| Chiến lược | Chỉ số riêng |
|---|---|
| Spot / Futures Grid | Fills · time in range |
| Spot DCA | Completed cycles · max safety orders used |
| Futures DCA | Completed cycles · stop loss hits |
| Recurring Buy | Buys made · avg buy price · value vs cost |
| Rebalancing | Net result vs buy-and-hold · rebalances |
| Funding Arbitrage | Funding collected · periods in position · max leg gap |
| TWAP | Avg fill vs arrival price · slices filled · worst slice slippage |
| Scalp Farming | Volume made · trades · winning trades · maker share (DEC-102) |

### 11.2 Engine mô phỏng
- **Dùng chung `packages/strategies`** với engine thật. Backtest chỉ thay lớp I/O bằng một exchange giả lập.
- Dữ liệu: `candles_1m` khi DRIFT có đủ cho cả kỳ; nếu không thì nến SoDEX mịn nhất còn đủ (30D → 5m, 90D → 15m, 180D → 1h; SoDEX chỉ giữ 1m khoảng 7 ngày, DEC-40). Funding lịch sử (perps) lấy từ `funding_rates` do `marketdata` ghi. Không đủ dữ liệu cho kỳ đã chọn thì trả về `unavailable`.
- **Scalp Farming (`volume_farm`, DEC-102)** chỉ chạy trên nến 1 phút, kỳ **5D** hoặc **30D**. SoDEX giữ nến 1 phút dưới 7 ngày (đo 2026-11-04), nên 5D luôn đủ; worker lấy `candles_1m` của DRIFT rồi bù khoảng trống bằng nến 1 phút của SoDEX. 30D chỉ chạy khi DRIFT có đủ nến 1 phút. Mỗi nến, `timer` gửi kèm 120 nến 1 phút gần nhất (như engine). Không có sổ lệnh lịch sử nên tín hiệu chạy chế độ chỉ-nến (độ tin cậy thấp hơn khi chạy thật); UI ghi rõ điều này.
- Mô hình khớp lệnh (bảo thủ):
  - Lệnh limit chỉ khớp khi giá **đi xuyên qua** mức đặt: low < giá mua, hoặc high > giá bán.
  - Lệnh market khớp ở giá open của candle kế tiếp + 0.05% trượt giá *(chỉnh được)*.
  - Trong một candle, nếu cả lệnh mua lẫn lệnh bán đều có thể khớp, thì xử lý theo thứ tự bất lợi cho người dùng.
- Phí: maker/taker của SoDEX + builder fee của chiến lược (0.01%, Market Making 0.003%, Scalp Farming 0.005%; DEC-46, DEC-94) theo đúng quy tắc chiều (mục 5.3). Funding áp dụng mỗi kỳ.
- Giới hạn rủi ro của bot (stop, max loss, take profit) được mô phỏng y như engine thật.
- Job chạy qua NATS `backtest.run`. Kết quả lưu DB và cache theo `(strategy, market, paramsHash, period, dataVersion)`.
- Test: với cùng bộ fixture candle, backtest và engine (exchange giả lập) phải ra cùng chuỗi hành động.
