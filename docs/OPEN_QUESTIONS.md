# DRIFT — Câu hỏi còn mở

> Một phần của bộ tài liệu DRIFT. Đọc `CLAUDE.md` ở gốc repo trước. Số mục giữ nguyên như bản gốc để các tham chiếu "mục X" vẫn đúng (xem bảng mục lục trong `CLAUDE.md`).

## 15. Câu hỏi còn mở (hỏi trước khi code phần liên quan)

1. `expiresAt` tối đa và ý nghĩa của `0`; (cách xoá key đã rõ, mục 5.5). (`DRIFT_BUILDER_ID` đã chốt ở DEC-24; `keyType = 1` theo tài liệu SoDEX.)
2. ~~Nguồn market info~~: đã có trong tài liệu SoDEX (mục 5.6).
3. ~~Isolated margin, endpoint funding~~: đã có (mục 5.6). Còn lại: dấu của funding (mục 5.5).
4. Quyền của key: đã chốt hai chữ ký (DEC-25). Còn lại: kiểm chứng trên mainnet rằng key mask `14` đặt và huỷ được lệnh nhưng bị từ chối `transferAsset` (`docs/SODEX.md` mục 5.2). Ngoài ra cần câu chữ UI cho màn Onboarding 2 theo luồng hai chữ ký (artboard hiện tại vẽ một chữ ký). Khi đã kiểm chứng thì đặt `SODEX_CONNECT_ENABLED=true`.
5. Kline: đã có độ phân giải `1m` và giới hạn mỗi lần (mục 5.6). Còn lại: độ sâu lịch sử, phải đo trên mainnet.
6. Rate limit SoDEX: đã có số công khai (`docs/VOLUME_MAKER.md` mục 17.1). Còn cần hỏi: **WebSocket chỉ cho 10 user khác nhau trên mỗi IP** và 1200 weight/phút trên mỗi IP. Với hàng nghìn account, DRIFT cần nhiều IP egress hoặc hạn mức riêng cho partner. Đây là ràng buộc lớn nhất cho việc scale engine (`docs/ARCHITECTURE.md` mục 3.3).
7. Engine đề xuất (mục 10): product duyệt các ngưỡng và trọng số.
8. Điều kiện resume của `RISK_DRAWDOWN`; ngưỡng dữ liệu stale.
9. Số bot tối đa trên mỗi account và mỗi market; mục tiêu năng lực (mục 3.5).
10. Có thông báo qua Telegram trong v1 không.
11. Lịch sử SoDEX lùi được bao xa: đo trên mainnet ngày 2026-10-27 thì fill Perps chỉ trả khoảng 10,000 dòng gần nhất, position đã đóng thì cũ hơn (DEC-34). Cần SoDEX xác nhận giới hạn chính thức.
12. Volume Maker (mục 17.5): xác nhận bằng văn bản từ SoDEX, và mức builder fee riêng cho bot này.
13. Spot Grid: cách khởi tạo phần tài sản cơ sở để đặt lệnh bán lúc start (mua market một lần, hay chỉ đặt lệnh mua) (`docs/STRATEGIES.md` S1).
14. Rebalancing: tần suất kiểm tra (đề xuất 5 phút) và loại lệnh khi rebalance (limit sát giá hay market) (S6).
15. Funding Arbitrage: SoDEX có cho chuyển margin giữa Spot và Perps bằng API key không (S7).
16. TWAP: dùng TWAP native của SoDEX cho perps hay tự chia lát (S8).
17. Câu chữ email OTP (`apps/api/src/messages/en.json`) đang là bản nháp: cần duyệt hoặc thay bằng câu chữ của thiết kế.
18. Gia hạn key (Renew): SoDEX có cho đăng ký lại key cùng tên `DRIFT` không (thay key cũ hay báo trùng), hay phải đổi tên / xoá key cũ trước? Tài liệu không ghi.
19. Futures Grid "Must be closer than liquidation." (S2, DEC-65): ước lượng giá thanh lý của vị thế lưới *trước khi mở* bằng công thức nào (maintenance margin của SoDEX theo market/tier, vị thế khi khớp hết)? SoDEX chỉ trả `liquidationPrice` cho vị thế đang mở.
