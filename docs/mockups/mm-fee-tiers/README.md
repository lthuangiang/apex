# Mockup: Market Making — builder fee theo bậc volume

Bản chép của design sheet "Market Making Fee Tiers" (https://claude.ai/artifact/C2LtzvnasRUSNNiaajwTeZ, private). Người dùng duyệt phương án **2b** (Strategy Lab hiện mức riêng, thanh tiến độ và bậc kế tiếp) ngày **2026-11-16**. Câu chữ ở mục 3 và 6 của sheet đã duyệt; số phí lấy từ `packages/shared/src/fees.ts`, không viết cứng.

| File | Là gì |
|---|---|
| `index.html` | Toàn bộ sheet: 1 landing (đã làm ở #171), 2a–2d Strategy Lab và form tạo MM, 3 câu chữ, 5a–5b Settings › SoDEX access (ST-02), 6 thông báo đổi bậc, 7 câu hỏi đã chốt |

## Đã code (DEC-TBD-mm-fee-tier-ui)

- 2b + 2c: thẻ Market Making trong Strategy catalog (`apps/web/src/components/mm-fee-tiers.tsx`).
- 2d: dòng phí "Before it starts" của form tạo Market Making, kèm bảng bậc.
- 5a + 5b: thẻ "DeskLabs builder fee" ở Settings.
- Sau khi duyệt sheet, người dùng yêu cầu thêm (2026-11-16): **bảng 3 bậc luôn hiện** ở cả ba chỗ, mọi trạng thái (kể cả `custom` và khi chưa có volume); chỉ đánh dấu "You" khi mức đến từ bậc volume. Vì vậy nút "How the rate drops" của 2a không còn cần.
