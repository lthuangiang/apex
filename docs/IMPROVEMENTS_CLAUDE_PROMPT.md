# Prompt cho Claude CLI: implement IMPROVEMENTS

Bạn làm trong monorepo DRIFT (pnpm, turbo, Next 16, Fastify, Drizzle). Nhiệm vụ: implement toàn bộ `docs/IMPROVEMENTS.md`, từ IMP-01 đến IMP-05, chạy từ đầu đến cuối.

**Chủ dự án không ở máy và không trả lời được. Không hỏi, không dừng chờ.** Gặp điểm chưa rõ thì chọn cách an toàn nhất, ghi vào báo cáo và làm tiếp. Một IMP bị chặn thì bỏ qua phần bị chặn, ghi lý do và làm IMP khác.

Báo cáo bằng tiếng Việt, dễ hiểu. Câu chữ trên giao diện bằng tiếng Anh.

## 1. Đọc trước

1. `docs/IMPROVEMENTS.md`: **spec chính**.
2. `docs/STRATEGIES.md`, `docs/SCREENS.md` mục màn Create, `docs/DECISIONS.md`.
3. `docs/mockups/create-bot/Create.dc.html`: bố cục widget chart. Số là mẫu, không đưa vào code. Giao diện thật dùng `@drift/ui` và mẫu của trang hiện có.
4. Code: `packages/strategies/src/common/dca-bot.ts`, `common/grid-bot.ts`, `spot-dca/`, `futures-dca/`, `twap/`, `rebalancing/`, `packages/strategies/src/__tests__/`, `apps/web/src/features/bots/fields.ts`, `apps/web/src/features/bots/components/create-bot.tsx`, `visual-panel.tsx`, `bot-edit.tsx`, `apps/engine/src/engine.ts`, `apps/marketdata`, `packages/sodex`.

Repo có thể đang có thay đổi chưa commit, kể cả phần AI Desk. Đọc lại file ngay trước khi sửa. Không revert, không ghi đè việc đang có.

## 2. Thứ tự

Làm theo thứ tự, xong bước nào chạy test bước đó:

1. IMP-01: Entry condition dùng chung.
2. IMP-02: Next cycle.
3. IMP-05 bước Chart.
4. IMP-05 bước Liquidation map (phần code được phép, xem mục 4).
5. IMP-03: Start at cho TWAP.
6. IMP-04: Initial buy cho Rebalancing.

## 3. Quyết định đã chốt

Tất cả ghi vào DEC mới trong `docs/DECISIONS.md`. Mục nào do bạn tự chọn thì ghi "chọn theo khuyến nghị, chờ duyệt".

| Việc | Quyết định |
|---|---|
| Giá nhảy qua cả khoảng | Long và Short vẫn vào, form cảnh báo |
| Hạn chờ giá | Không có, kể cả After pullback |
| Lệnh vào của DCA | Market IOC như base order hiện tại |
| Spot DCA | Dùng cơ chế chung, đọc được cấu hình cũ |
| Grid Neutral | At price là cắt qua mức; In a range chỉ vào khi giá trong khoảng |
| Thư viện chart | TradingView Lightweight Charts, ghim đúng phiên bản, ghi công theo yêu cầu giấy phép. Không dùng được thì tự vẽ SVG |
| Tab mặc định | Price |
| Mobile | Chart đặt dưới ô Market, thu gọn được |
| Kéo đường trên chart | Không làm đợt này, chỉ nhập số |
| IMP-03 | Start at: Now hoặc thời điểm theo múi giờ trong Settings |
| IMP-04 | Initial buy: All now (mặc định) hoặc Over N hours, chia phần bằng nhau |

## 4. Liquidation map: giới hạn bắt buộc

Hiện chưa có nhà cung cấp dữ liệu nào được chọn và không có API key.

**Được làm:** interface `LiquidationProvider` phía server, endpoint có cache, UI tab Liquidation map kiểu Coinglass, biến môi trường cấu hình nhà cung cấp, provider giả chỉ dùng trong test.

**Không được làm:**
- Không lấy dữ liệu từ trang web Coinglass hay trang nào khác. Không crawl, không gọi endpoint nội bộ.
- Không đăng ký tài khoản, không mua dịch vụ, không tự thêm key.
- Không dùng logo hay thương hiệu Coinglass.
- Không đưa dữ liệu giả vào production.

Khi chưa cấu hình nhà cung cấp, tab **ẩn hoàn toàn**, chỉ còn Price. Ghi rõ trong báo cáo: tính năng này chưa chạy được trên môi trường thật cho tới khi chủ dự án chọn nhà cung cấp.

## 5. Luật an toàn

1. Bot đang chạy và cấu hình cũ phải giữ nguyên hành vi. Thêm trường mới là tuỳ chọn, có giá trị mặc định. Không đổi cách sinh clOrdID của lệnh hiện có.
2. Config cũ phải parse được. Bot đang `running` phải nạp lại được sau khi deploy, kể cả state cũ thiếu trường mới. Có test.
3. Strategy vẫn là hàm thuần `step()`, không I/O. Tiền và giá dùng decimal string.
4. Dữ liệu thanh lý chỉ để hiển thị, không đưa vào `step()`, `recommend()` hay bất kỳ quyết định đặt lệnh nào.
5. Cooldown là thời gian cố định khách chọn. Không thêm thời gian hay kích thước ngẫu nhiên để tránh phát hiện.
6. Không chạm luồng 2FA, signer, API key. Không code rút hay chuyển tiền. Không log secret.
7. Không dùng mainnet, tiền thật hay tài khoản thật. Test dùng `@drift/sodex-mock`.
8. Không đăng nhập bằng mật khẩu thật, không nhập 2FA.
9. Không hứa lợi nhuận. Vùng thanh lý không được gọi là hỗ trợ hay kháng cự.

## 6. Chất lượng

- Theo quy ước repo: lỗi qua `AppError`, ghi qua `idempotent`, câu chữ mới vào `apps/web/messages/en.json` theo cách repo đang làm với `_pendingReview`.
- Cập nhật `docs/STRATEGIES.md`, `docs/SCREENS.md` nếu màn hình đổi.
- Form sửa bot đang chạy: chỉ cho sửa theo đúng quy tắc hiện có của từng trường.
- Trạng thái "Waiting for price" hiện ở trang bot, Trading Agent và Strategy Lab.
- Chart lỗi thì form vẫn dùng được.
- Test bắt buộc: các ca liệt kê trong từng IMP, cấu hình cũ, state cũ, Pause và Stop khi đang chờ, backtest chạy được với điều kiện mới, Long và Short.
- Chạy typecheck, lint, test cho mọi package đã sửa, cuối cùng chạy toàn repo. Test API và engine có thể chập chờn khi máy tải cao: chạy lại riêng test đó trước khi kết luận. Không xoá hay nới test để cho pass.
- Mở app ở local xem màn hình nếu môi trường cho phép. Không được thì ghi rõ.

## 7. Git

**Không commit, không push, không tạo PR, không build image, không deploy, không chạy migration trên môi trường thật.** Giữ thay đổi trong working tree để chủ dự án review.

## 8. Khi xong

- Xoá khỏi `docs/IMPROVEMENTS.md` các mục đã làm xong hoàn toàn. Giữ lại phần chưa xong, ghi rõ còn thiếu gì.
- Viết báo cáo vào `docs/IMPROVEMENTS_REPORT.md`:
  1. Từng IMP: xong, xong một phần, hay bị chặn.
  2. Kết quả test thật, số pass và fail, kèm test còn lỗi.
  3. Những gì chưa xem được trên màn hình.
  4. Quyết định tự chọn và DEC tương ứng.
  5. Dependency mới và giấy phép.
  6. Việc chủ dự án cần làm: chọn nhà cung cấp dữ liệu, biến môi trường, migration nếu có.
  7. Rủi ro khi deploy cho bot đang chạy.
