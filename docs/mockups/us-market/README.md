# US Market + SoDEX Wealth: bản phác đã duyệt

Chủ sản phẩm duyệt ngày 2026-11-28 (DEC-402). Dữ liệu trong ảnh là **dữ liệu mẫu**; câu chữ là bản nháp, câu mới vào `_pendingReview` để PM duyệt khi code.

- `us-market.html`: một file tự chứa, năm màn.
- Ảnh PNG `-1440.png` (bản 390 px làm khi code, theo `docs/DESIGN.md`).

| # | Màn | Ảnh |
|---|---|---|
| 01 | Strategy Lab: hai tab giữ nguyên, thêm banner mở trang US Market và nhãn "Trades …" trên thẻ chiến lược | `01-strategy-lab-1440.png` |
| 02 | US Market (trang riêng `/markets/us`, mở từ banner): dải "Your SoDEX Wealth", khối Anthropic (vANT, ANT-USD kèm độ sâu sổ lệnh), khối SoDEX Wealth funds (chỉ đọc, link ra SoDEX), khối US fund tokens ("Watching") | `02-us-market-1440.png` |
| 03 | Tạo bot trên market có sổ mỏng: bảng độ sâu sổ lệnh và kiểm "Largest position" | `03-new-bot-depth-1440.png` |
| 04 | Signal Research: tin công ty Anthropic gắn với ANT-USD; tin sản phẩm không giao dịch | `04-signal-research-1440.png` |
| 05 | Portfolio › My Wealth (chỉ đọc) | `05-my-wealth-1440.png` |

## Quy tắc đi kèm bản phác (DEC-402)

- **Chỉ đọc với Wealth.** Không nạp, rút, chuyển trong DeskLabs (quy tắc sản phẩm 1 giữ nguyên). Nút "Invest on SoDEX" và "Open SoDEX Wealth" là link ra ngoài.
- **Không hiện lợi suất hay % lợi nhuận của quỹ.** API Wealth không trả; chỉ hiện NAV, quy mô quỹ, và số liệu vị thế của chính người dùng mà API trả. Thiếu thì "Not provided".
- **Độ sâu sổ lệnh** = tổng notional 10 mức giá mỗi phía. Nhãn: `Thin` khi một phía dưới 10.000 USD, `Very thin` khi dưới 1.000 USD.
- **Giới hạn theo sổ lệnh** cho market có nhãn `Thin` / `Very thin`: tổng vị thế tối đa của bot mới không lớn hơn phía mỏng hơn; lệnh khớp ngay để vào vị thế không quá 25% phía nó ăn; lệnh đóng vị thế không bao giờ bị giữ lại (sổ mỏng thì đóng thành nhiều phần, có ghi Decisions); lệnh chờ của grid không bị cắt.
- **Trạng thái sổ lệnh** lấy từ dữ liệu thật (`Trading`, `Empty`, `Halted`); không có nhãn "US market open" (không có nguồn lịch thị trường).
- **Không dùng logo** của bên thứ ba; tên quỹ và market viết bằng chữ, đúng như SoDEX trả.
- **Chưa làm trong gói này:** bot rổ quỹ (sổ lệnh quỹ đang trống), nút "Tell me when it trades", nạp / rút Wealth trong DeskLabs.
