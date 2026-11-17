# SoDEX Debugger (người dùng duyệt, 2026-11-17)

Trang team `/admin/sodex-debugger`: mọi request REST tới SoDEX và sự kiện WebSocket của user stream mà DeskLabs gửi / nhận, để tìm lỗi và gửi SoDEX một báo cáo sạch. Mục cuối của nhóm TEAM, sau System Architecture Diagram.

| File | Nội dung | Phạm vi |
|---|---|---|
| `sodex-debugger.html` | Mockup có tương tác. Mở bằng `?view=list|detail|report|states&tab=request|response|context`; thu hẹp cửa sổ < 768px để xem layout 390 | **Code** |
| `1440-list.png`, `1440-detail.png`, `1440-report.png`, `1440-states.png` | Ảnh chụp 1440: danh sách, chi tiết, hộp thoại báo cáo, các trạng thái | **Code** |
| `390-list.png`, `390-detail.png` | Ảnh chụp 390 | **Code** |

Số liệu trong mockup là dữ liệu mẫu (DESIGN.md D3).

Quyết định chốt khi duyệt (người dùng, 2026-11-17; DEC-309):
1. Lưu **mọi** lời gọi REST tới SoDEX (mọi service) và vòng đời WS user stream + tin `accountOrderUpdate` / `accountTrade`. Không lưu tin WS thị trường (bookTicker, trades công khai, kline).
2. Giữ 14 ngày cho lỗi / timeout / network / unreadable / rejected và lời gọi chậm (> 1000 ms); 3 ngày cho lời gọi thành công. Vì lưu mọi lời gọi nên câu chữ "1% of successful calls" / "Sampled 1%" trong mockup **không dùng**; thay bằng câu về 3 ngày (xem `apps/web/messages/en.json`, khoá `sodexDebugger.*`).
3. Lưu params của action đã ký, đã bỏ chữ ký, `apiSign`, private key, API secret và header xác thực ("Signature redacted", "Key masked" ••last4).
4. Báo cáo chép ra có địa chỉ account đầy đủ; UI che địa chỉ.
