# Mockup: chọn market và đòn bẩy theo market ở bước Budget and safety

Người dùng duyệt ngày 2026-11-13. Bản chép từ canvas "Copy Trading · pick markets and leverage" (https://claude.ai/artifact/Uq28KnVgocU4iHWpj7fNeL, private). Câu chữ PM duyệt, chép đúng như artboard.

| File | Là gì |
|---|---|
| `CopyMarkets.dc.html` | Bước 2 "Budget and safety", desktop. **Chỉ thẻ có nhãn CHANGED / NEW là thay đổi**; khung nét đứt "NOT PART OF THIS CHANGE" giữ nguyên như app hiện tại |
| `CopyMarkets-Mobile.dc.html` | Phần "Markets we'll copy" ở 390: mỗi market một thẻ |

## Quy tắc (thay DEC-163 mục 6 phần "tự chọn mọi market")

1. Mặc định tick mọi market trader dùng mà SoDEX niêm yết. Người dùng bỏ tick được; tối thiểu 1 market (không có thì nút Continue khoá, câu "Pick at least one market.").
2. Market bỏ tick không bao giờ mở lệnh. Trader giao dịch ở đó → ghi "Skipped", lý do mới `market_off`.
3. Đòn bẩy: mặc định một giá trị theo mức an toàn (Careful 1×, Balanced 2×, Bold 3×), thấp hơn ở market mà SoDEX cho tối đa thấp hơn. Công tắc "Set per market" mở nút −/+ từng dòng, trần = min(maxLeverage của SoDEX cho market đó, 5×), sàn 1×.
4. Đòn bẩy **không** đổi cỡ mỗi lệnh copy (vẫn số tiền cố định). Mỗi dòng hiện: ký quỹ mỗi vị thế = cỡ lệnh ÷ đòn bẩy, và khoảng cách thanh lý ước tính (dùng `liquidationDistance` sẵn có, chỉ isolated; cross hoặc thiếu dữ liệu → "Not available").
5. Trần tổng giữ như cũ: budget × đòn bẩy của mức an toàn.
6. Cột "Trader's trades · 30D": số episode đã đóng của trader theo market trong 30 ngày, field mới tính từ cùng dữ liệu leader-stats. Thiếu → "Not available", không bao giờ 0 giả.
7. Có market bị bỏ tick (còn ≥ 1) → cảnh báo "You're copying part of this trader's trades…".
8. Config S12: giữ `markets` (danh sách đã chọn) + `leverageByMarket` (tuỳ chọn, `{market: int}`); thiếu thì dùng `leverage`. Engine đặt đòn bẩy theo từng market trên SoDEX. Config cũ đọc được như trước.
9. Review (bước 3) và Trading Agent › Configuration hiện danh sách market đã chọn và đòn bẩy từng market.

Chữ trong ngoặc vuông (`[N]`, `[X]%`) là chỗ trống minh hoạ.
