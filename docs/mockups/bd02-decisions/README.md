# BD-02: Decisions → Orders (người dùng duyệt 2026-11-16)

Nguồn: canvas "BD-02 Decisions → Orders" (https://claude.ai/artifact/JwbyxThfp9BUcWuiZyApnp, bản 1794819422-e832). Code theo các file ở đây; canvas đổi thì DevOps chép lại.

| File | Nội dung | Phạm vi |
|---|---|---|
| `Main.dc.html` | Trading Agent › Decisions: dòng gộp, pill Result có link (desktop) | **Code** |
| `Orders.dc.html` | Execution & Orders: lệnh được làm nổi bật trên trang đang tải | **Code** |
| `OrdersFiltered.dc.html` | Lệnh không có trên trang đang tải → lọc theo lệnh đó | **Code** |
| `Mobile.dc.html`, `MobileOrders.dc.html` | Bản 390 px | **Code** |
| `Empty.dc.html`, `Loading.dc.html` | Trạng thái rỗng / đang tải | **Code** |
| `canvas.json` | Bố cục và ghi chú quy tắc | Tham khảo |

Quy tắc chốt khi review (cũng ở ghi chú trên canvas):
1. Gộp: các quyết định liên tiếp cùng tên event thật trên cùng bot, mỗi cái cách cái trước ≤ 60 s. Chỉ gộp "Bid pulled", "Ask pulled" (mỗi phía riêng) và "Quote skipped". Không thêm log requote.
2. Không bao giờ gộp: Order filled, Position cut, Stopped, Paused / Resumed, Smart quoting adjusted / back to normal, Order requests, cảnh báo chi phí, lỗi, kết quả Unknown và Rejected.
3. Pill tổng hợp của nhóm đếm kết quả, xấu nhất trước: Unknown, Rejected, Open, Partially filled, Filled, Cancelled.
4. Mọi pill kết quả link tới lệnh theo clOrdID (kể cả Rejected và Not placed · confirmed): mở Execution & Orders `?botId=&order=<clOrdID>`, cuộn tới dòng, làm nổi bật 2.5 s, chuyển focus vào dòng. Không có trên trang đang tải thì lọc theo lệnh đó, có chip để bỏ lọc. Không thêm panel hay drawer trên trang Agent.
5. Nhãn pill dùng lại `orders.status.*` ("Partially filled", "Unknown · reconciling", "Not placed · confirmed").

Số và lệnh trên artboard là ví dụ để dựng bố cục.
