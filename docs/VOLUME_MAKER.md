# DRIFT — Volume Maker

> Một phần của bộ tài liệu DRIFT. Đọc `CLAUDE.md` ở gốc repo trước. Số mục giữ nguyên như bản gốc để các tham chiếu "mục X" vẫn đúng (xem bảng mục lục trong `CLAUDE.md`).

## 17. Volume Maker (bot sự kiện) **[phát hành có điều kiện]**

### 17.1 Điều lệ SoDEX đã kiểm tra (tài liệu công khai, ngày 26/10/2026)
- Mùa hiện tại "Layer 1 Season": bắt đầu 01/09/2026 12:00 UTC, kéo dài 20 tuần. Điểm đến từ khối lượng giao dịch spot + futures và open interest, cùng với Wealth/SLP Vault, mời bạn, Squad. Pool 900.000 SoPoints/tuần. Snapshot thứ Ba 12:00 UTC, phân phối thứ Sáu 12:00 UTC.
- Trọng số theo "Dynamic Weighting Model", chỉnh hằng tuần và **không công bố công thức**.
- SoDEX ghi rõ "zero tolerance for wash trading or any form of manipulative farming" và "Real liquidity contribution is always prioritized over robotic repetition".
- Tài liệu **không cấm** bot hay giao dịch qua API, nhưng cũng không định nghĩa wash trading và không có ngưỡng phạt cụ thể.
- API lệnh có `timeInForce`: `GTC=1`, `IOC=3`, `GTX=4` (post-only); `FOK` chưa hỗ trợ. Có `reduceOnly` (perps), `clOrdID` (`^[0-9a-zA-Z_-]{1,36}$`, duy nhất theo account). **Không có field self-trade prevention**.
- Fill có `isMaker`, `fee`, `builderFee`. `makerFeeRate` có thể âm (rebate).
- Rate limit: mỗi API key 20 lệnh/giây và 600 lệnh/phút; giới hạn theo địa chỉ ví là 1 request trên mỗi 1 USDC đã giao dịch luỹ kế, cộng sẵn 10.000 request ban đầu; khi bị giới hạn thì chỉ được 1 request mỗi 10 giây. Tối đa 1.000 lệnh mở (spot + perps).

Nguồn: [SoPoints Layer 1 Season](https://sodex.com/documentation/sopoints/layer-1-season), [Season 1](https://sodex.com/documentation/sopoints/season-1), [API rate limits](https://sodex.com/documentation/for-developers/developers/trading/api-rate-limits), [REST schema](https://sodex.com/documentation/for-developers/api-reference/trading-api/rest-v1/schema).

### 17.2 Bot làm gì
- Đặt báo giá hai phía bằng lệnh **post-only (GTX)** trên BTC-PERP hoặc ETH-PERP, đòn bẩy 1×, làm mới mỗi N giây, giữ tồn kho (inventory) gần 0.
- Mục tiêu: tạo thanh khoản thật và khối lượng thật trong thời gian sự kiện, với **chi phí có trần**.
- Tham số và thông báo lỗi lấy theo artboard **Create · Volume Maker** và Bot Spec mục 3d / 4.

### 17.3 Quy tắc bắt buộc
1. **Chống self-trade do DRIFT tự làm**, vì SoDEX không có STP. Trước mỗi lần đặt hoặc thay lệnh, engine kiểm tra mọi lệnh đang mở của account trên market đó, tính trên **tất cả bot**:
   - Lệnh mua phải có giá < giá ask thấp nhất của chính account.
   - Lệnh bán phải có giá > giá bid cao nhất của chính account.
   - Vi phạm thì bỏ lệnh và ghi `SELF_TRADE_BLOCKED`.
   - Mỗi account chỉ có một writer (shard lease, mục 3.3), nên phép kiểm tra này không bị race.
2. **Chỉ là maker.** Không có lệnh taker, trừ lệnh đóng reduce-only khi dừng bot. Chi phí của lệnh đó vẫn tính vào ngân sách.
3. **Trần chi phí.** chi phí = phí đã trả + lỗ đã chốt + lỗ chưa chốt trên tồn kho. Đạt 80% thì cảnh báo, 100% thì dừng. Hiện chi phí trên mỗi 1 triệu USD khối lượng theo thời gian thực.
4. **Tồn kho.** Vượt 50% max inventory thì nghiêng báo giá về phía giảm tồn kho. Đạt 100% thì chỉ báo giá phía giảm.
5. **Rate limit.** Chu kỳ làm mới ≥ 2 s; thay lệnh theo batch; tôn trọng mọi giới hạn ở 17.1. Hết hạn mức thì chạy chậm lại, không được dồn lệnh.
6. **Cấm theo thiết kế:**
   - giao dịch giữa các account của cùng một người;
   - phối hợp báo giá giữa nhiều người dùng;
   - ngẫu nhiên hoá thời gian hay khối lượng để tránh bị phát hiện;
   - bất kỳ thiết lập nào chỉ tạo khối lượng mà không có thanh khoản thật nằm trên sổ lệnh.
7. **Câu chữ.** Không bao giờ hứa hẹn hay ước tính SoPoints. Luôn hiện: "SoDEX doesn't publish how volume converts to SoPoints and penalises wash trading, so points are not guaranteed." Checkbox xác nhận dùng câu riêng cho Volume Maker (theo artboard).

### 17.4 Builder fee riêng **[confirm]**
Đề xuất thu **0.01%** (`fee: 10` trong field `builder` của lệnh) cho bot này thay vì 0.05%, để DRIFT không hưởng lợi từ khối lượng người dùng bỏ tiền ra mua. Phí tính trên từng lệnh, nên làm được mà không cần người dùng approve lại.

### 17.5 Điều kiện phát hành
- Xin **xác nhận bằng văn bản** từ SoDEX rằng: bot market-making post-only, có chống self-trade và chạy qua API key của DRIFT, được phép tham gia Layer 1 Season (và các sự kiện sau), và không bị risk engine đánh dấu chỉ vì hoạt động đều đặn.
- Chưa có xác nhận: ẩn Volume Maker sau feature flag `VOLUME_MAKER_ENABLED=false`. Catalog không hiển thị, route trả 404.
- Có xác nhận: ghi ngày và nội dung xác nhận vào đây, rồi mới bật flag.
- **Trạng thái (2026-10-28):** đã code theo mục này (DEC-43), `VOLUME_MAKER_ENABLED=false` trong compose và `.env`. **Chưa có xác nhận của SoDEX.** Bật cờ ở api, engine và web cùng lúc.

### 17.6 Theo dõi trên Trading Agent
- Khối lượng đã tạo / mục tiêu; chi phí đã dùng / ngân sách.
- Chi phí trên mỗi 1 triệu USD khối lượng; tỷ lệ maker (phải là 100%).
- Tồn kho hiện tại; số lần `SELF_TRADE_BLOCKED`; hạn mức request còn lại.
