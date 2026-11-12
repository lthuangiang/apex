# DRIFT — Danh sách cải tiến

> Việc để làm sau, **chưa code**. Khi làm xong thì chuyển quyết định sang `docs/DECISIONS.md` và xoá mục ở đây.

## Vấn đề chung: bot vào lệnh theo lúc bấm Start

Đối chiếu code ngày 2026-10-31:

| Chiến lược | Lệnh đầu tiên | Chọn điều kiện vào được không | Mức ưu tiên |
|---|---|---|---|
| Futures DCA | Market ngay | **Không** | Cao |
| Spot DCA | Market ngay, hoặc chờ giá ≤ một mức | Một phần, và mức này chặn mọi Cycle | Cao |
| Spot Grid | Market mua phần cho các mức phía trên, cùng lúc đặt limit | Một phần: `triggerPrice`, phải cắt qua mức | Cao |
| Futures Grid | Long hoặc Short: market mở vị thế. Neutral: chỉ limit | Một phần: `triggerPrice` | Cao |
| TWAP | Chạy ngay; từng phần là limit IOC | Có `priceLimit`, không có giờ bắt đầu | Trung bình |
| Rebalancing | Limit IOC mua đủ tỷ trọng ngay | Không | Trung bình |
| Funding Arb | Chờ funding đạt ngưỡng rồi market | **Có**, đúng logic của nó | Không cần |
| Recurring Buy | Theo lịch, có `skipAbovePrice` | **Có** | Không cần |
| Volume Maker, Volume Farm | Theo logic tạo khối lượng | Không áp dụng | Không làm |

Nguyên nhân: mỗi chiến lược tự làm một kiểu điều kiện vào lệnh, hoặc không có. Nên gom thành một cơ chế chung.

## IMP-01: Entry condition dùng chung

**Áp dụng:** Futures DCA, Spot DCA, Spot Grid, Futures Grid.

**Form:** thêm nhóm "First entry" ở màn tạo và sửa bot:

| Lựa chọn | Hành vi |
|---|---|
| **Now** (mặc định) | Như hiện tại |
| **At price** | Chờ giá tới mức đã chọn |
| **In a range** | Chờ giá vào khoảng thấp – cao |

**Luật đã chốt**

| Tình huống | Long | Short | Neutral (chỉ Grid) |
|---|---|---|---|
| At price P | Vào khi giá ≤ P | Vào khi giá ≥ P | Vào khi giá cắt qua P |
| In a range [L, H] | Vào khi giá ≤ H, kể cả nhảy xuống dưới L | Vào khi giá ≥ L, kể cả nhảy lên trên H | Chỉ vào khi L ≤ giá ≤ H |

Với Spot Grid và Spot DCA, coi như Long.

Quyết định đã chốt:
1. Giá nhảy qua cả khoảng: Long và Short vẫn vào, vì giá tốt hơn mong muốn. Form phải cảnh báo điều này.
2. Không có hạn chờ ở bản đầu.
3. Lệnh vào của DCA dùng market IOC như base order hiện tại.
4. Áp dụng cho Spot DCA, thay `price_at_or_below` và vẫn đọc được cấu hình cũ.

Với Grid, khi điều kiện đạt thì chạy `start()` như hiện tại.

**Cách làm**

1. Tạo `packages/strategies/src/common/entry.ts`: schema `entry` và hàm thuần `entryReady(entry, direction, prevPrice, price)`.
2. DCA: thêm phase `waiting_entry` ở `common/dca-bot.ts`. Grid: dùng lại phase `waiting_trigger` ở `common/grid-bot.ts`.
3. Khi chờ, bot không đặt lệnh và không khoá margin. Bot vẫn là Running, UI hiện "Waiting for price" kèm điều kiện.
4. `Start` vẫn kiểm tra đủ vốn lúc bấm. Lúc giá tới mà thiếu vốn thì lệnh bị từ chối và bot pause như các lỗi khác.
5. Điều kiện chỉ áp dụng cho lần vào đầu tiên. Cycle sau theo IMP-02.

**Tương thích**

- Bot không có `entry` chạy như Now.
- `triggerPrice` của Grid đọc thành At price kiểu cắt qua, giữ đúng hành vi cũ.
- Spot DCA cũ có `price_at_or_below` đọc thành At price cộng Next cycle = Same as first entry, vì code hiện tại chặn mọi Cycle.
- Điều kiện vào là hàm thuần nên backtest dùng được, không cần sửa riêng.

**Test:** chưa đạt điều kiện không đặt lệnh · đạt thì chỉ vào một lần · Long và Short · giá nhảy qua khoảng · Neutral ngoài khoảng không vào · cấu hình cũ giữ hành vi · Pause, Stop khi đang chờ.

**Sửa thêm:** `apps/web/src/features/bots/fields.ts`, `apps/web/messages/en.json`, `docs/STRATEGIES.md`. `aiParameters()` mặc định Now.

## IMP-02: Chờ giá lùi trước khi mở Cycle mới

**Áp dụng:** Futures DCA, Spot DCA. Làm chung với IMP-01.

**Hiện trạng:** Futures DCA mở Cycle mới bằng market ở nhịp giá kế tiếp, nên có thể mua ngay sát giá vừa bán. Spot DCA có `startLevel` thì mọi Cycle đều phải chờ mức này, dù nhãn là "Start".

| "Next cycle" | Hành vi |
|---|---|
| **Immediately** (mặc định) | Như hiện tại |
| **After pullback** | Long: chờ giá thấp hơn giá chốt lời x%. Short: cao hơn x% |
| **Cooldown** | Chờ một số phút cố định do khách chọn |
| **Same as first entry** | Dùng lại điều kiện của IMP-01 mỗi Cycle |

**Đánh đổi:** tránh mua đỉnh và giảm số vòng trả phí, nhưng giá tăng thẳng thì bot đứng ngoài. Không hứa cách nào tốt hơn. Nên so bằng backtest trên cùng dữ liệu.

Cooldown phục vụ chiến lược. Không thêm thời gian ngẫu nhiên để tránh phát hiện.

## IMP-03: Giờ bắt đầu cho TWAP

**Hiện trạng:** TWAP chạy ngay sau Start. `priceLimit` đã chặn giá xấu cho từng phần.

**Đề xuất:** thêm "Start at": Now hoặc một thời điểm do khách chọn, theo múi giờ trong Settings. Không dùng Entry condition của IMP-01, vì TWAP là lệnh chia nhỏ theo thời gian.

## IMP-04: Mua dần khi khởi tạo Rebalancing

**Hiện trạng:** Rebalancing mua đủ tỷ trọng ngay khi Start bằng limit IOC, kể cả vốn lớn. `maxTradePct` có giới hạn nhưng chưa phải chia dần theo thời gian.

**Đề xuất:** thêm "Initial buy": All now (mặc định) hoặc Over N hours. Cần chốt: chia theo phần bằng nhau hay theo thanh khoản. Ưu tiên thấp vì Rebalancing không phụ thuộc nhiều vào giá vào của một tài sản.

## IMP-05: Chart và bản đồ thanh lý ở màn tạo bot

**Mục tiêu:** khách nhìn vùng giá ngay khi đặt tham số, không phải mở SoDEX hay Coinglass ở tab khác.

**UI đã duyệt hướng:** giữ nguyên form tạo bot. Thêm một widget **bên dưới** widget Preview / Backtest ở cột trái, không đổi cột Settings, không thêm bước. Mockup: `docs/mockups/create-bot/Create.dc.html` và các màn Create trên canvas DRIFT Redesign.

**Widget gồm**

- Tiêu đề theo market đang chọn, ví dụ `BTC-PERP · 1h · SoDEX`.
- Khung thời gian: 15m, 1h, 4h, 1D.
- Tab **Price**: nến của SoDEX kèm các mức của bot.
- Tab **Liquidation map**: kiểu Coinglass. Nền tím đậm, dải ngang theo mức độ, sáng hơn là nhiều hơn, có thang màu, nến nằm đè lên, kèm các mức của bot.
- Chưa chọn market thì hiện "Choose a market to see its chart."
- Đổi setting thì các đường đứt nét đổi theo ngay. Click chart để copy giá; kéo đường để đặt giá làm sau.

**Hiển thị theo chiến lược**

| Chiến lược | Chart | Mức của bot | Liquidation map |
|---|---|---|---|
| Spot Grid, Futures Grid | Có | Upper, Lower, Stop, giá kích hoạt | Có |
| Spot DCA, Futures DCA | Có | Entry, các safety, take profit, stop | Có |
| Recurring Buy | Có | Skip above | Có |
| TWAP | Có | Price limit | Có |
| Funding Arb | Có, tab Price | Không | Không |
| Volume Maker, Volume Farm | Có, tab Price | Không | Không |
| Rebalancing | Không có widget | Không | Không |

Mockup hiện chưa vẽ đường Skip above, Price limit, take profit và stop của DCA. Khi code làm theo bảng này.

**Chia 2 bước**

1. **Chart:** nến lấy từ dữ liệu SoDEX, không phụ thuộc bên ngoài. Làm cùng IMP-01 để First entry hiện trên chart.
2. **Liquidation map:** đã có nguồn Hyperliquid công khai (DEC-92). Trước khi bật trên prod phải kiểm tra điều khoản dùng lại dữ liệu. Muốn dữ liệu toàn thị trường thì thêm nhà cung cấp có giấy phép qua `LiquidationProvider`.

**Điều kiện của Liquidation map**

- Chọn nhà cung cấp có API và giấy phép **cho phép hiển thị lại cho khách của SaaS**. Không lấy dữ liệu từ trang web của Coinglass, không dùng logo hay thương hiệu của họ. [Cần chốt nhà cung cấp và chi phí]
- API key giữ ở server, cache theo market và khung thời gian, không gọi từ trình duyệt.
- Không có dữ liệu cho market thì ẩn tab, chỉ còn Price.
- Bắt buộc có câu: dữ liệu là **ước tính từ sàn khác, không phải vị thế trên SoDEX**, và giá có thể xuyên qua vùng thanh lý.
- Không dùng dữ liệu này để tự đặt lệnh hay tự chỉnh tham số. Không gọi đây là hỗ trợ hay kháng cự.

**Cần chốt khi code**

1. Thư viện chart. Ứng viên: TradingView Lightweight Charts, kiểm tra điều khoản ghi công trước khi dùng.
2. Tab mặc định. Đề xuất: Price. Mockup mở Liquidation map chỉ để review.
3. Mobile: mockup chưa có. Đề xuất đặt chart dưới ô Market và cho thu gọn.

**Test:** đổi market đổi chart · đổi setting đổi đường ngay · thiếu dữ liệu nến hiện trạng thái lỗi · market không có dữ liệu thanh lý ẩn tab · form vẫn dùng được khi chart lỗi.

## Chưa cần làm

- **Funding Arb:** đã chờ funding đạt ngưỡng.
- **Recurring Buy:** đã có lịch và `skipAbovePrice`.
- **Volume Maker, Volume Farm:** mục tiêu là khối lượng, không phải giá vào.

## Thứ tự

1. IMP-01, IMP-02 và bước Chart của IMP-05, làm cùng nhau.
2. Bước Liquidation map của IMP-05, sau khi có nguồn dữ liệu.
3. IMP-03.
4. IMP-04.
