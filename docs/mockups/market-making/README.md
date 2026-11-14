# Mockup: Market Making — chọn market rẻ và giảm Price PnL

Người dùng duyệt ngày 2026-11-14 (làm cả D1 và D2). Bản chép từ canvas "Whale Watch & Copy Trade", hàng D (https://claude.ai/artifact/HszwXR1UNMaTcGV51uHLoU, private). Câu chữ PM duyệt, chép đúng artboard. Khung nét đứt "EXISTING" giữ nguyên như app; chỉ phần có nhãn NEW là mới.

| File | Là gì |
|---|---|
| `MM-Markets.dc.html` | D1 · Tạo bot Market Making, bước chọn market: bảng xếp hạng theo chi phí / $1M |
| `MM-Markout.dc.html` | D2 · Trading Agent của bot MM: "Where the price PnL comes from" + "Ways to lower it" |

## Công thức (số quá khứ 24h, không dự báo; thiếu dữ liệu → "Not available", không bao giờ 0 giả)

- **One price step (bps)** = tick size ÷ giá giữa × 10.000.
- **Usual spread** = trung vị (best ask − best bid) theo số tick trong 24h (lấy mẫu sổ lệnh).
- **1-min swing (bps)** = độ lệch chuẩn của % thay đổi giá giữa giữa các nến 1m, 24h.
- **Markout của một fill** (bps, dương = có lợi cho bên đặt lệnh maker): lệnh mua `(mid sau Δt − giá khớp) ÷ giá khớp`, lệnh bán ngược dấu. Δt = 5 s / 30 s / 60 s.
- **Price PnL / $1M (D1)** = trung bình markout 30 s (theo notional) × 1.000.000 / 10.000, tính trên giao dịch công khai 24h của SoDEX ở phía maker; nếu market đã có bot MM của DeskLabs chạy trong 24h thì ưu tiên fill thật của bot.
- **Total cost / $1M** = phí maker SoDEX / $1M + builder fee MM (0,003% = 30) + (−Price PnL).
- **D2** dùng fill thật của chính bot, 24h: markout 5/30/60 s, số vòng mua bán đóng lỗ / tổng.

## Cài đặt mới ở D2 (cần CHỐT số trước khi code)

1. **Quote one step back**: dùng field có sẵn (`quoteLevel` / `distanceBp`), chỉ là gợi ý.
2. **Close only at your entry price or better**: field mới, mặc định tắt. Lệnh đóng post-only, giá ≥ giá vào (mua) / ≤ (bán). Cần chốt: có giới hạn thời gian giữ vị thế không (vẫn tôn trọng `inventoryLossStop` và trần chi phí).
3. **Pause on fast moves**: field mới, mặc định tắt. Huỷ báo giá khi giá giữa chạy quá N bước giá trong T giây, chờ W giây rồi báo giá lại. Cần chốt N / T / W mặc định.

Mọi thay đổi cài đặt đi qua bản nháp (Edit bot); không tự áp.
