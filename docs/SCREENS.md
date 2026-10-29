# DRIFT — Màn hình, route và toàn vẹn dữ liệu

> Một phần của bộ tài liệu DRIFT. Đọc `CLAUDE.md` ở gốc repo trước. Số mục giữ nguyên như bản gốc để các tham chiếu "mục X" vẫn đúng (xem bảng mục lục trong `CLAUDE.md`).

## 8. Màn hình và route

Desktop và mobile dùng **cùng một route**, layout responsive. Artboard mobile là layout khi màn hình < 768px.

| Route | Artboard desktop | Artboard mobile |
|---|---|---|
| `/signup` | Onboarding 1 · Create account | Mobile · Onboarding 1 |
| `/onboarding/connect` | Onboarding 2 · Connect SoDEX | Mobile · Onboarding 2 |
| `/onboarding/import` | Onboarding 3 · Import history | Mobile · Onboarding 3 |
| `/onboarding/analysis` | Onboarding 4 · Account analysis | Mobile · Onboarding 4 |
| `/onboarding/goals` | Onboarding 5 · Your goals | Mobile · Onboarding 5 |
| `/onboarding/plan` | Onboarding 6 · Strategy plan | Mobile · Onboarding 6 |
| `/` (chưa đăng nhập) | Landing · Public (trang fluid, DEC-69) | cùng artboard, responsive |
| `/risk-disclosure` | Public · Risk Disclosure (mở cho mọi người, DEC-69) | cùng artboard, responsive |
| `/` (đã đăng nhập) | Desktop · Overview | Mobile · Home |
| `/portfolio` | Desktop · Portfolio | Mobile · Portfolio |
| `/orders` | Desktop · Execution & Orders | Mobile · Orders |
| `/risk` | Desktop · Risk Center | Mobile · Risk Center |
| `/analyst` | Desktop · AI Analyst | Mobile · AI Analyst |
| `/agent/:botId` | Desktop · Trading Agent | Mobile · Trading Agent |
| `/bots` | Strategy Lab · My bots & catalog | Mobile · Strategy Lab |
| `/bots/new/:strategy` | Create · <Strategy> (8 artboard) | Mobile · Create <Strategy> (8 artboard) |
| `/bots/:botId/edit` | Strategy Lab · Edit running bot | Mobile · Edit bot |
| `/settings` | Desktop · Settings | Mobile · Settings |
| `/admin/builder-revenue` | Desktop · Builder Revenue (chỉ đội DRIFT) | Mobile · Builder Revenue |
| `/admin/users` | Chưa có artboard (DEC-64, chỉ role `team`, chỉ đọc) | Chưa có artboard |

**Điều hướng:**
- Sidebar desktop: Overview, Portfolio, Trading Agent, Strategy Lab, Execution & Orders, Risk Center, AI Analyst | Builder Revenue (chỉ đội DRIFT), Settings.
- Bottom nav mobile: Home, Portfolio, Agent (ở giữa), Strategy, More (gồm Settings và link tới Orders, Risk, AI Analyst).
- Mục "Trading Agent" trên sidebar mở bot đang chạy gần nhất. Nếu người dùng có nhiều bot thì có thanh chọn bot ở đầu trang.

**Không có wizard nhiều bước.** Nút "New bot" mở tab catalog của `/bots`. Mỗi thẻ trong catalog dẫn tới `/bots/new/:strategy`.

### 8.1 Onboarding
- Bước 2 bắt buộc dùng master wallet. Hiện đúng các field typed-data mà ví sẽ hiển thị, tô nổi `builderID` và `maxFeeRate`.
- Các trạng thái của bước 2: start → wallet connected → review → signing (ví đang mở) → creating (đang đăng ký và đọc lại) → done | rejected (người dùng huỷ, không có gì thay đổi) | error (kèm lý do từ SoDEX).
- Bước 3 import balances, transfers, fills, funding. Hiện tiến độ từng mục. Không lấp chỗ trống; giai đoạn nào thiếu thì hiện là thiếu.
- Bước 4 hiển thị các số sau:
  - lãi gộp đã chốt (gross realized PnL), phí, funding ròng;
  - lãi ròng = lãi gộp − phí − funding;
  - win rate tính trên các vị thế đã đóng;
  - drawdown;
  - kết quả theo market và theo thời gian giữ lệnh.
  Không tính PnL chưa chốt và phải ghi rõ điều đó.
- Bước 6 lấy kết quả từ engine đề xuất (mục 10). Mỗi đề xuất trích đúng các số phân tích mà nó dựa vào, có phần "What we didn't suggest, and why", và mở `/bots/new/:strategy` với các giá trị đó điền sẵn dưới dạng AI parameters.

### 8.2 Màn tạo bot (`/bots/new/:strategy`)

- "Before it starts" chạy dry run trên form chưa lưu (DEC-56); bot Perps có thêm check "Leverage on SoDEX" (`leverage_conflict`, DEC-58): chặn khi có vị thế / bot DRIFT khác dùng cùng symbol với thiết lập khác, chỉ khác cài đặt thì cảnh báo + xác nhận riêng. Balance của bot Perps so với margin dùng được (`am` Cross, `ami` Isolated).
Bố cục: header (tên chiến lược, badge engine, badge LIVE · MAINNET, chip disabled "Paper · Coming soon"), panel trực quan, panel tham số, panel "Before it starts".

**Panel tham số (DEC-68, lệch artboard có chủ đích theo yêu cầu người dùng).** Field spec, label, rule giữ nguyên STRATEGIES.md; chỉ đổi thứ tự và chỗ hiện:
- Section theo thứ tự: **Market** → **Amount** (ô vốn ngay sau Market) → **Strategy** → **Risk** → **Advanced settings** (đóng mặc định, nhớ trạng thái mở/đóng trong trình duyệt). Bảng field của từng section: UI_REVIEW G3, code ở `apps/web/src/features/bots/fields.ts` (`amount`, `advanced`, `row`, `width`).
- Dưới Amount: "Available: X USDC on Spot / Perps" (từ `/api/v1/portfolio`, thiếu thì "Available: Not available"); DCA có câu "Your total is the base order plus every safety order." và "Max capital used" / "Max margin used" (cùng công thức `capitalOf`); Perps có "Position up to ≈ margin × leverage"; Funding Arb có "Split 50/50".
- Hai ô cùng hàng (Base + Safety, Margin + Leverage, Lower + Upper) xuống một cột dưới 480 px.
- Advanced đóng: dòng tóm tắt (lựa chọn hiện tại · "{n} optional not set"); có field cần giá trị thì "{n} fields need a value" màu đỏ. Lỗi server ở field trong Advanced thì tự mở và focus field lỗi đầu tiên. Ô **Bot name** nằm cuối Advanced.
- AI parameters báo cần vốn → cuộn tới, focus và viền lỗi ô vốn (UI_REVIEW E7).
- Preview chưa có dữ liệu: dải thấp ~72 px "Fill in the settings to see the preview."; desktop cột preview dính đỉnh khi cuộn. Dưới 1024 px: preview rỗng nằm sau Amount, có dữ liệu thì nằm ngay trước Advanced; Save draft / Start on mainnet là thanh dính đáy trên bottom nav, còn thiếu điều kiện thì bấm Start cuộn tới mục đầu tiên còn thiếu.

**Panel trực quan** có 2 tab: `Preview` (mặc định) và `Backtest` (mục 11). Tab Preview được vẽ lại mỗi khi field thay đổi:
- Grid (spot / futures): biểu đồ giá với dải grid, mỗi level một đường, nhãn Upper / Last / Lower / Stop. Với futures thì thêm giá thanh lý **lấy từ SoDEX**, DRIFT không tự tính.
- DCA (spot / futures): thang lệnh gồm base và các safety order, kèm % biến động, giá, khối lượng; đường take-profit.
- Recurring Buy: 6 lần mua tiếp theo và tiến độ ngân sách.
- Rebalancing: thanh tỷ trọng mục tiêu và dải cho phép của từng tài sản.
- Funding Arbitrage: chân spot + chân perp = phơi nhiễm ≈ 0, kèm 21 kỳ funding gần nhất.
- TWAP: timeline các lát lệnh, khối lượng và khoảng cách giữa các lát.

**AI parameters (kiểu Bitget). Không có tab.** Chỉ có một nút chuyển trạng thái trong panel tham số: `Clear parameters` khi đang có giá trị do AI điền, và `✦ AI parameters` sau khi đã xoá.
1. Mở màn hình thì gọi engine đề xuất (mục 10) với (strategy, market, user). Trong lúc chờ: field hiện skeleton, nút Start bị disable.
2. Kết quả trả về gồm: giá trị cho mọi field bắt buộc, một dòng "basis", 3 lý do ("Why these values"), timestamp, suggestion id. Giá trị phải đúng quy tắc field và tick / lot / min size của SoDEX; client vẫn validate lại.
3. Field số do AI điền có chip `AI`. Người dùng sửa field nào thì chip của field đó đổi thành `Edited`.
4. `Clear parameters` xoá trống mọi field số (placeholder đổi thành `e.g. <giá trị AI>`), select giữ lựa chọn đầu tiên, và nút đổi thành `✦ AI parameters`.
5. `✦ AI parameters` gọi lại engine và ghi đè. Nếu người dùng đã sửa field, phải hỏi trước: "Replace your N edits with AI parameters?"
6. Đổi market: nếu đang dùng giá trị AI thì gọi lại engine; nếu đã xoá / nhập tay thì giữ giá trị và validate lại.
7. Engine lỗi hoặc chậm quá 5 s: mở form với field trống và thông báo "AI parameters unavailable. Fill manually or try again." Không bao giờ chặn việc tạo bot.
8. Câu chữ luôn có "not a profit forecast". Không hiển thị lợi nhuận kỳ vọng.

**"Before it starts"**: tất cả phải đạt thì Start mới bật; mục nào lỗi thì có link sửa.
- API key còn hiệu lực.
- Builder fee approval ≥ 10 (0.01%) trên Spot và Perps; account của chính builder được miễn (DEC-46, DEC-47).
- Số dư ≥ vốn + phí ước tính.
- Mọi lệnh ≥ min size của SoDEX sau khi làm tròn theo tick/lot.
- 2FA đã bật.
- Nằm trong giới hạn rủi ro của account.
- Giá được cập nhật trong vòng ≤ 5 s.

Sau đó là checkbox xác nhận và nút `Start on mainnet`. Khi bấm: disable nút, gửi đúng một request kèm `Idempotency-Key`, hiện "Start requested · waiting for backend". Bot chỉ chuyển Running khi backend xác nhận và SoDEX đã ack các lệnh đầu tiên.

### 8.3 Trading Agent (`/agent/:botId`)

- Bot `draft` chỉ nằm ở Strategy Lab: `/agent/:botId` của bot `draft` chuyển (replace) sang `/bots/:botId/edit`, `archived` sang `/bots` (DEC-57).
- Header: tên bot, badge trạng thái kèm reason code, runtime, version cấu hình.
- Thanh vòng đời (Stopped → Starting → Running → Paused → Stopping); bước hiện tại được tô, bước đang chờ backend thì dùng viền nét đứt.
- Các nút theo trạng thái: Pause / Resume / Start…, "Stop agent…" đặt tách riêng ở cuối trang.
- Bảng "Decisions & actions" (time, decision, why, result), thẻ cấu hình kèm nút "Edit bot", thẻ lỗi gần đây có mã lỗi.

### 8.4 Sửa bot (`/bots/:botId/edit`)
- Khoá: strategy, market, mode. Muốn đổi thì Stop rồi Duplicate.
- Field cần re-grid (range, levels, spacing, investment, size DCA): huỷ lệnh rồi đặt lại; dialog ghi rõ số lệnh và khoảng trống ~2 s.
- Field áp dụng ngay (stop, take profit, max loss, hành động kết thúc): không đụng tới lệnh.
- "Retune with AI": điền giá trị đề xuất mới vào các field sửa được, đánh dấu thay đổi, rồi đi qua cùng dialog diff + apply.
- Có lịch sử version.

### 8.5 Settings (`/settings`)
Các tab: SoDEX access · Security · Notifications · Trading defaults · Profile.
- **SoDEX access:** account, key `••last4`, ngày hết hạn, lần dùng gần nhất, quyền (Read ✓, Place/cancel ✓, Withdraw/transfer ✕ never), Renew key (ký), Disconnect (dialog + 2FA). Thẻ builder fee: Approved 0.01% → `Revoke (set to 0)…` (dialog + ký + 2FA); Revoked → `Sign to approve 0.01% again`.
- **Security:** bật 2FA (QR → mã 6 số → backup code), các phương thức đăng nhập, danh sách phiên đăng nhập có nút sign out.
- **Notifications:** lỗi bot / lệnh unknown / bot bị pause (luôn bật, switch bị disable), cảnh báo rủi ro, thay đổi key / phí, mọi fill, tóm tắt hằng ngày. Kênh: in-app, email (Telegram **[confirm]**).
- **Trading defaults:** Mode = LIVE (chỉ đọc, ghi "Paper trading: coming soon"), max loss mặc định, múi giờ, định dạng số.
- **Profile:** tên, email, export CSV, xoá tài khoản (chỉ bật khi mọi bot đã dừng).

---

### 8.x Overview — Watchlist (DEC-74)
- Danh sách riêng (`watchlist_items`), tối đa 8 market Spot hoặc Perps, thứ tự do người dùng chọn. Lần đọc đầu seed từ `goals.markets` (4 cái đầu, perps `<X>-USD`, bỏ market SoDEX không có); sau đó độc lập với goals, bỏ hết cũng không seed lại.
- API: `GET /api/v1/watchlist`, `PUT /api/v1/watchlist` (thay toàn bộ, `Idempotency-Key`, market phải có trong `/api/v1/markets` đúng engine, > 8 hoặc trùng → `VALIDATION_FAILED`). `GET /api/v1/overview` trả `watchlist[]` có `engine`, `price` (perps: mark price; spot: giá gần nhất `md:last`), `change24hPct`, `spark`.
- Thẻ: tiêu đề + nút bút chì "Edit watchlist"; dòng phụ "Price · 24h"; chip "Spot" / "Perps" cạnh tên; thiếu giá ghi "Not available", không lọc mất dòng. Rỗng: "Your watchlist is empty." + "Add market".
- Bấm một dòng mở menu: "New bot on <market>" (→ `/bots?tab=catalog&market=&engine=`, catalog chỉ còn chiến lược dùng được market đó; link "Set up …" mang `market` sang Create để điền sẵn) và "Remove".
- Chế độ sửa: mỗi dòng có tay kéo, ▲ ▼ ("Move <market> up/down"), × ("Remove <market>"); "+ Add market" mở chọn Perps/Spot + `MarketPicker` (market đã có: disabled, "Added"); đủ 8 thì disabled, ghi "Up to 8 markets"; "Save" giữ "Saving…" tới khi API trả về; "Cancel" bỏ thay đổi.
- `MarketPicker` (màn Create / Edit): dưới ô market có nút ☆ / ★ "Add to watchlist" / "On watchlist · remove <market>".

### 8.x Portfolio — số dư theo engine (DEC-58)
- Dưới 4 ô tổng có hàng "Accounts": thẻ Spot (Value, Available USDC, In orders) và thẻ Perps (Account value theo index, Usable as margin = `am`, Usable for isolated = `ami`, Margin in use, Unrealized PnL, Open positions, haircut của Multi-Asset Margin, cảnh báo USDC âm).
- Tab "Balances": Spot (từng coin) và Perps (bảng collateral: Asset · Balance · Index price · Value · Ratio · Counts as margin).

## 9. Toàn vẹn dữ liệu (áp dụng cho mọi màn hình)

1. Mọi con số có đơn vị (USDC, USDT, %, ×), và khi cần thì kèm khung thời gian và dòng "Updated hh:mm:ss".
2. Loading → skeleton. Rỗng → empty state rõ ràng kèm bước tiếp theo. Lỗi → thông báo + nút thử lại; không bao giờ hiển thị `0` thay cho giá trị bị lỗi.
3. Dữ liệu cũ (giá / vị thế cũ hơn 30 s **[confirm ngưỡng]**) hiện badge stale kèm thời điểm cập nhật cuối.
4. Giá trị dương/âm luôn có dấu và mũi tên hoặc nhãn, không chỉ dựa vào màu.
5. Giá thanh lý, margin, funding lấy từ SoDEX. SoDEX không trả thì hiện "Not provided", không tự ước tính.
6. Giá làm tròn theo tick, khối lượng theo lot. Dùng `Intl.NumberFormat` theo định dạng số người dùng chọn; bảng dùng tabular numbers.
7. Thời gian hiển thị theo múi giờ trong Settings (mặc định UTC+7, lưu dưới dạng tên IANA).
8. Nội dung phân tích tách bạch *dữ liệu quan sát được*, *diễn giải* và *việc nên kiểm tra*, có nguồn và thời điểm, và ghi "not financial advice / not a forecast".
