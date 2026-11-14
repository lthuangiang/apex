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
- Order book (DEC-157): engine đọc REST `getOrderbook` mỗi 3 s cho **mỗi market khác nhau** đang có bot Market Making (cache theo market, không theo bot). Mở cho mọi perp nên weight theo IP tăng theo số market đang dùng; xem giới hạn 1200 weight/phút/IP ở `docs/OPEN_QUESTIONS.md`.

Nguồn: [SoPoints Layer 1 Season](https://sodex.com/documentation/sopoints/layer-1-season), [Season 1](https://sodex.com/documentation/sopoints/season-1), [API rate limits](https://sodex.com/documentation/for-developers/developers/trading/api-rate-limits), [REST schema](https://sodex.com/documentation/for-developers/api-reference/trading-api/rest-v1/schema).

### 17.2 Bot làm gì
- Đặt báo giá hai phía bằng lệnh **post-only (GTX)** trên bất kỳ perp nào đang TRADING trên SoDEX (DEC-157), đòn bẩy 1–40× (mặc định 5×, DEC-99), làm mới mỗi N giây, giữ tồn kho (inventory) gần 0.
- Mục tiêu: tạo thanh khoản thật và khối lượng thật trong thời gian sự kiện, với **chi phí có trần**.
- Tham số và thông báo lỗi lấy theo artboard **Create · Volume Maker** và Bot Spec mục 3d / 4.

### 17.3 Quy tắc bắt buộc (chỉ cho Market Making; không áp dụng cho Volume Farming, DEC-101)
1. **Chống self-trade do DRIFT tự làm**, vì SoDEX không có STP. Trước mỗi lần đặt hoặc thay lệnh, engine kiểm tra mọi lệnh đang mở của account trên market đó, tính trên **tất cả bot**:
   - Lệnh mua phải có giá < giá ask thấp nhất của chính account.
   - Lệnh bán phải có giá > giá bid cao nhất của chính account.
   - Vi phạm thì bỏ lệnh và ghi `SELF_TRADE_BLOCKED`.
   - Mỗi account chỉ có một writer (shard lease, mục 3.3), nên phép kiểm tra này không bị race.
2. **Chỉ là maker.** Không có lệnh taker, trừ lệnh đóng reduce-only khi dừng bot. Chi phí của lệnh đó vẫn tính vào ngân sách.
3. **Trần chi phí.** chi phí = phí đã trả + lỗ đã chốt + lỗ chưa chốt trên tồn kho. Đạt 80% thì cảnh báo, 100% thì dừng. Hiện chi phí trên mỗi 1 triệu USD khối lượng theo thời gian thực.
4. **Tồn kho (DEC-100, thay quy tắc 50% / 100% cũ).** `u` = giá trị vị thế / max open position (mặc định 2 × order size, người dùng sửa được).
   - **Flat** (vị thế dưới mức tối thiểu của SoDEX): bid và ask đối xứng ở mid·(1 ∓ d), mỗi bên một order size.
   - **Có vị thế** (ngay từ fill đầu, không chờ 50%): phía đóng là lệnh post-only **reduce-only** ở mid·(1 ± d·(1−u)), cách mid ít nhất 1 tick; phía tăng vị thế lùi ra mid·(1 ∓ d·(2+2u)), khối lượng ≤ phần còn trống tới max open position. Vẫn báo giá hai phía để kiếm spread, không thành bot chỉ đóng lệnh.
   - **Đạt max open position** (u ≥ 1): chỉ báo giá phía đóng.
   - Khối lượng lệnh đóng = vị thế − phần chưa khớp của các lệnh đóng khác còn sống hoặc đang huỷ, làm tròn xuống theo lot; dưới mức tối thiểu thì không đặt.
   - SoDEX từ chối reduce-only (không phải vì post-only / risk) 2 lần liên tiếp thì lệnh đóng chuyển sang post-only thường, vẫn giới hạn theo khối lượng trên. Chưa kiểm chứng trên mainnet việc SoDEX nhận GTX kèm reduceOnly.
   - Fill thì báo giá lại sau tối thiểu 2 s (quy tắc 5).
   - **Đối soát:** fill của mọi lệnh bot đã gửi đều được tính, kể cả lệnh đã huỷ / thay (giới hạn theo khối lượng còn lại của lệnh). Engine đọc lịch sử khớp của SoDEX mỗi 10 s cho mỗi account + market, và đọc vị thế thật mỗi 30 s khi đây là bot duy nhất của account trên market đó; lệch quá 30 s thì lấy vị thế SoDEX, ghi "Position re-synced from SoDEX" và gắn cờ cần chú ý. Lệnh huỷ chưa được xác nhận sau 60 s thì coi là xong.
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
- **Thay đổi (2026-10-30, DEC-80):** bỏ cờ `VOLUME_MAKER_ENABLED`. Volume Maker (và Volume Farm mới) chỉ hiện và chạy cho tài khoản được team bật ở Users › Volume bots. Quyết định bật cho ai là của team; vẫn nên xin xác nhận của SoDEX trước khi bật rộng.

### 17.6 Theo dõi trên Trading Agent
- Khối lượng đã tạo / mục tiêu; chi phí đã dùng / ngân sách.
- Chi phí trên mỗi 1 triệu USD khối lượng; tỷ lệ maker (phải là 100%).
- Tồn kho hiện tại; số lần `SELF_TRADE_BLOCKED`; hạn mức request còn lại.
- **Where the price PnL comes from** (DEC-227, artboard `MM-Markout`): fill thật của chính bot 24 giờ, markout
  5 / 30 / 60 s so với giá giữa (`mid_1s`), một bước giá (tick ÷ giá giữa), số vòng mua bán đóng lỗ "N of M" (vòng = vị
  thế 0 → 0, đảo chiều tách làm hai, lỗ theo Price PnL chưa trừ phí). Câu "In short" chỉ hiện khi một bước giá nhỏ hơn
  trung vị |Δ giá giữa 30 s| trên các fill; câu "Losers lose more steps than winners win." chỉ hiện khi lỗ trung bình mỗi
  đơn vị của vòng lỗ lớn hơn lãi trung bình của vòng lãi. API `GET /api/v1/bots/:id/mm-markout`.
- **Ways to lower it**: mở `/bots/:id/edit?suggest=<option>`, chỉ điền sẵn form (không lưu nháp, không tự áp).
  `quote-back` = `quoteLevel` + 1 (tối đa 20); `pause-fast` bật cài đặt tương ứng (closeAtEntry là BETA, không có trong "Ways to lower it" cho tới khi replay v2 chứng minh giảm lỗ); "Move to a cheaper
  market" mở bước chọn market.
- **Close only at your entry price or better** (`closeAtEntry`, mặc định tắt, BETA): lệnh đóng vẫn post-only reduce-only, giá =
  max(giá tốt nhất phía đóng, giá vào) khi long, min(…) khi short; giá vào (`avgCost`) chưa gồm phí, làm tròn tick về phía
  có lợi. Vị thế mở (tính từ lúc rời trạng thái phẳng) quá 30 phút → đóng theo cách thường, Decisions ghi một lần
  "Closing at the best price". Trần chi phí và `inventoryLossStop` vẫn áp dụng như cũ.
- **Pause on fast moves** (`pauseOnFastMoves`, mặc định tắt): giá (cao nhất − thấp nhất) trong 6 s gần nhất ≥ max(3 bước giá, 2 bp của giá) → huỷ
  ngay lệnh mở, chỉ giữ lệnh đóng reduce-only; mỗi lần kích hoạt gia hạn thêm 15 s; hết hạn thì báo giá lại. Decisions ghi
  "Quotes paused on a fast move" / "Quoting again after a fast move". Độc lập với Smart quoting.

### 17.7 Gợi ý market theo chi phí / $1M (DEC-228, thay phần xếp hạng của DEC-227)
- **UI:** không còn bước "Choose a market" riêng. `/bots/new/volume_maker` mở thẳng form; dưới field Contract có khối
  "Suggested for market making": tối đa 3 market (đủ dữ liệu, không "Too little volume", rẻ nhất trước), bấm thì điền
  Contract; dòng "Estimated cost here: …" cho contract đang chọn; "Compare all markets" mở bảng đầy đủ (sheet trên mobile,
  dialog trên desktop). Chi phí hiện dạng **khoảng**: đầu dưới = chỉ phí (phí maker SoDEX + builder fee MM của người xem,
  `feesPerMillion`, khi giá không chạy ngược), đầu trên = ước tính có cả lỗ giá thường gặp (`totalCostPerMillion`): dòng
  gợi ý "{market} · {low}–{high} per $1M · up to {capacity}/day", đầu trên ≤ đầu dưới thì một số (số thấp hơn), chi phí ≤ 0
  ghi "0 or less". Bảng có hai cột "Fees only / $1M" và "With usual price moves / $1M" (xếp theo cột thứ hai), không có cột
  nguồn số (Your bots / Model; logic trộn vẫn giữ ở backend), dòng giải thích dưới bảng nói đầu trên không phải mức tối
  đa. Bảng mặc định ẩn market "Too little volume" và chưa đủ dữ liệu, nút "Show all markets ({n} hidden)" ↔ "Hide markets
  with too little volume", lựa chọn giữ trong phiên. Chưa market nào đủ dữ liệu: "Suggestions appear once we have a day of
  SoDEX data.".
- **API** `GET /api/v1/markets/mm-cost` (phần thị trường cache 5 phút; phần của người xem tính mỗi lần): mỗi market có
  `stepBps`, `swingBps`, `volume24h`, `capacityPerDay`, `tooLittleVolume`, `candleMinutes24h`, `activeMinutes24h`,
  `hoursWithData`, `trades24h`, `notional24h`, `publicPricePnlPerMillion` (đối chiếu), `pricePnlPerMillion`, `source`,
  `yourRoundTrips`, `totalCostPerMillion`; kèm `modelVersion`, `model {a, k}`, `suggested`. Danh sách đã xếp.
- **Mô hình:** PnL giá (bps trên volume) = a × bước − k × dao động 1 phút, chặn ≤ 0. Bước = tick ÷ giá đóng nến 1m mới
  nhất; dao động = độ lệch chuẩn mẫu % thay đổi giữa các nến 1m 24 giờ, chỉ tính khi ≥ 720 nến và ≥ 720 phút có volume (một phút có volume = volume quote ≥ $50; market thưa gần như phút nào cũng có giao dịch vài cent, nên đếm volume > 0 không chặn được)
  (thiếu → không đủ dữ liệu). Hệ số mới nhất trong `mm_model_coefs`, chưa có thì a = 0,25, k = 0,095 (version 0).
- **Bot của người xem:** fill 24 giờ của bot MM live của chính người xem ở market đó → PnL giá gồm phần chưa chốt (vị thế
  ròng trong cửa sổ định giá ở giá đóng nến mới nhất), trộn (n × thực + 50 × mô hình) / (n + 50), n = số vòng đóng; nguồn
  `source` = "yours" (không hiện trên bảng). Bot của người khác không bao giờ hiện trong số của người xem.
- **Chi phí / $1M** = phí maker SoDEX của market (`makerFee` × 1.000.000, thiếu thì 0,012%) + builder fee MM của người
  dùng (rate × 10) − PnL giá × 100.
- **Sức chứa** "up to … / day" = 5% volume 24h; dưới $100K / ngày là "Too little volume", không gợi ý, xếp sau.
- **Xếp hạng:** đủ dữ liệu + đủ sức chứa (chi phí tăng dần; mọi chi phí ≤ 0 coi như bằng nhau và xếp theo sức chứa), rồi
  "Too little volume", rồi thiếu dữ liệu. "Most volume" trong bảng xếp theo sức chứa.
- **Fit hằng ngày** (scheduler, mỗi 10 phút kiểm tra, một lần cho ngày UTC hôm qua): mỗi (bot, market, ngày) live,
  quoteLevel 0, ≥ 50 vòng đóng, market đủ 720 phút có volume là một điểm (bước, dao động, PnL giá, trọng số = volume). Bot
  của team luôn dùng; bot của user khác chỉ dùng khi có ≥ 3 tài khoản như vậy. Dưới 5 điểm: giữ a = 0,25, fit k; đủ 5
  điểm: fit cả hai, a trong [0; 0,5], k ≥ 0. Không có điểm → không ghi dòng mới.
- **Nguồn dữ liệu thị trường:** như DEC-227 (WS `bookTicker` + `trade` trên kết nối Perps sẵn có, top 30 + market có bot
  MM; markout công khai gom theo giờ vào `mm_market_hourly`, giữ 48 giờ), cộng lưu thô theo giờ cho v2 (DEPLOY mục 4).
