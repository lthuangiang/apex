# Mockup: Market Making — ước tính chi phí chỉ cho "Where to quote" 0

Issue #543. Người dùng duyệt bố cục ngày **2026-11-26**; PM duyệt câu chữ cùng ngày (câu 3 đã sửa thành "Fees here: {fees} per $1M. Price moves are not estimated when Where to quote is above 0, so the real cost can be higher."). Quyết định: DEC-396. Số liệu market trong sheet là số minh hoạ.

| File | Là gì |
|---|---|
| `index.html` | Toàn bộ sheet: 1 form Create (mức 0 / mức 2), 2 dialog "Compare all markets", 3 bản 390 px, 4 ghi chú Market hours, câu chữ mới, ghi chú triển khai |
| `mm-est-cpm-l0-1440.png` / `mm-est-cpm-l2-1440.png` | Khối dưới Contract ở mức 0 (giữ nguyên) và mức 2 |
| `mm-est-cpm-compare-1440.png` | Dialog so sánh, mức 0 (hai cột bị bỏ khi mức ≠ 0 gạch chéo) và mức 2 |
| `mm-est-cpm-l0-390.png` / `mm-est-cpm-l2-390.png` | Bản 390 px kèm bottom sheet |
| `mm-est-cpm-full-1440.png` | Cả sheet |

## Tóm tắt

- Mức 0: như cũ (DEC-228).
- Mức khác 0 (kể cả ô rỗng / sai): không có số nào của mô hình. Gợi ý xếp theo sức chứa "{market} · up to {capacity}/day"; dòng contract đang chọn chỉ còn phí; bảng bỏ "Price PnL / $1M" và "With usual price moves / $1M", bỏ "Cheapest first" và nhãn "Cheapest", xếp theo sức chứa.
- Market hours (team): thêm câu "Est. CPM models quotes at the best price (Where to quote 0)." ở chú giải Est. CPM.
