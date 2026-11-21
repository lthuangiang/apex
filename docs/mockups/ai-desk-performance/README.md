# Mockup: AI Desk — How your bots performed

Thẻ "How your bots performed" trên AI Desk (#234, thiết kế #232, DEC-314).

| File | Là gì |
|---|---|
| `ai-desk-performance.html` | Thiết kế gốc của thẻ (#232) |
| `desk-card-1440.png`, `desk-card-390.png`, `desk-card-empty.png` | Ảnh chụp thiết kế gốc |
| `cost-labels.html` | Sửa nhãn chi phí (#415): ghi rõ "per $1M" và thêm số USDC thật cho từng phần. Người dùng duyệt ngày **2026-11-21** |
| `cost-labels-1440.png`, `cost-labels-390.png` | Ảnh chụp `cost-labels.html` ở 1440 và 390 |

## Đã code (#415)

- Dòng "Cost per $1M traded, by part" trên thanh màu; mỗi phần ghi "{amount} per $1M" kèm "{usdc} USDC in these 7 days / 30 days" (từ `sodexFee`, `builderFee`, `priceMove` của API).
- Dòng so sánh ghi "{amount} per $1M more / less than {before}".
- Thiếu giá (`priceMove` null): phần giá chỉ hiện "Not available", không có dòng USDC.
- Chip "New" và các khung ghi chú tím trong mockup là ghi chú cho người duyệt, không có trong app.
