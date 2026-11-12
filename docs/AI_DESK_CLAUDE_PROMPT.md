# Prompt cho Claude CLI: AI Desk

Bạn đang làm trong monorepo DRIFT (pnpm, turbo, Next 16, Fastify, Drizzle). Nhiệm vụ: xây **AI Desk phần Recommended, Your bots và Paper mode** theo tài liệu dưới đây. **Không làm Ask AI và không thêm mô hình ngôn ngữ** trong đợt này.

Trả lời bằng tiếng Việt, dễ hiểu. Câu chữ trên giao diện bằng tiếng Anh.

## 1. Đọc trước khi code

Đọc hết, theo thứ tự:

1. `docs/AI_DESK.md`: kế hoạch chung và nguyên tắc không đổi.
2. `docs/AI_DESK_RECOMMENDED.md`: flow chi tiết. **Đây là spec chính.**
3. `docs/AI_DESK_REPORT.md`: chỉ để biết phân biệt "Suggested" với "Verified".
4. `docs/DECISIONS.md`: quy ước đánh số DEC và các quyết định cũ.
5. Mockup HTML ở `docs/mockups/ai-desk/`: `AIDesk.dc.html`, `AIDesk-Bots.dc.html`, `AIDesk-Why.dc.html`, `AIDesk-Paper.dc.html`, `AIDesk-Result.dc.html`, `AIDesk-GoLive.dc.html`, `M-AIDesk.dc.html`, `M-AIDesk-Paper.dc.html`. Dùng để lấy bố cục và câu chữ. Số trong mockup là mẫu, không đưa vào code. Giao diện thật dùng `@drift/ui` và mẫu của các trang hiện có, không chép style của mockup.
6. Code liên quan: `packages/shared/src/reco/`, `packages/shared/src/portfolio/analyst.ts`, `apps/api/src/modules/reco/`, `apps/api/src/modules/bots/service.ts`, `apps/engine/src/gateway.ts`, `apps/engine/src/engine.ts`, `apps/engine/src/http-gateway.ts`, `packages/strategies/src/sim/`, `apps/web/src/features/bots/`, `apps/web/src/features/onboarding/components/strategy-plan.tsx`.

Không tự bịa quy tắc nghiệp vụ. Spec không nói thì chọn cách an toàn nhất, ghi vào báo cáo cuối và làm tiếp. Chỉ dừng hỏi khi việc đó đụng tới tiền thật.

## 2. Các quyết định đã chốt

Dùng các mặc định sau, ghi thành DEC mới trong `docs/DECISIONS.md` với ghi chú "chọn theo khuyến nghị, chờ duyệt":

| Việc | Quyết định |
|---|---|
| Tên | AI Desk, mục riêng trên sidebar. Thứ tự: AI Desk, Strategy Lab, Trading Agent |
| AI Analyst | Bỏ khỏi sidebar, quy tắc chuyển sang tab Your bots. URL cũ chuyển hướng sang tab này |
| Mode | Không có công tắc Beginner / Pro |
| Ai thấy AI Desk | Admin bật theo tài khoản ở Users, giống Volume bots |
| 30 ngày paper | Không bắt buộc để dùng tiền thật, chỉ cảnh báo |
| Chưa kết nối SoDEX | Vẫn dùng được Recommended và paper. Nếu kiến trúc cản trở, ghi rõ trong báo cáo và giữ yêu cầu kết nối ở bản đầu |
| Giới hạn bot paper | 3 bot đang chạy mỗi tài khoản |
| Tài sản mặc định | BTC, ETH |
| Backtest ở Why this one | Không hiện |
| Ngưỡng Goal check | 20% và 100% mỗi năm, đặt trong `RECO_CONFIG` |

## 3. Luật an toàn, không được vi phạm

1. Bot paper **không bao giờ** đi qua `HttpGateway`, không gọi signer, không gửi gì lên SoDEX. Engine chọn cổng theo `mode` tại đúng một chỗ, và `HttpGateway` tự từ chối bot paper.
2. Dữ liệu paper không được tính vào Portfolio, Home, equity, Volume, Builder Revenue, Risk Center, đối soát phí, thống kê account. Emergency Halt phải dừng cả bot paper nhưng không tính chúng là tiền thật.
3. Không đổi `mode` của bot tại chỗ. Dùng tiền thật là tạo bot mới.
4. Bot paper mô phỏng khớp theo mục 8.2 của spec: limit chỉ khớp khi giá đi xuyên qua, market cộng trượt giá, tính phí và funding.
5. Không chạm tới luồng 2FA và `startChecks` của bot thật, ngoài việc gọi lại chúng.
6. Không hứa lợi nhuận, không dự báo, không ước tính SoPoints. Gợi ý theo quy tắc ghi "Suggested for you", không bao giờ ghi "Verified". Không gọi tính năng này là AI dự đoán.
7. Goal check không được truyền vào `recommend()` và không ảnh hưởng đề xuất.
8. Trading only: không code rút tiền hay chuyển tiền. Không log secret hay full key.
9. Không dùng dữ liệu thật hay chạy bot trên mainnet để kiểm thử. Test dùng `@drift/sodex-mock`.

## 4. Thứ tự làm

Làm theo từng mốc, xong mốc nào chạy test mốc đó.

**Mốc 0: kiểm tra, không sửa code.** Đo qua REST SoDEX công khai hoặc `apps/marketdata` độ sâu lịch sử nến và funding của BTC, ETH, phí spot và perps, lệnh tối thiểu, vốn tối thiểu từng chiến lược trong `recommend()`. Ghi vào `docs/AI_DESK_DATA.md`. Kết quả dùng cho Ask AI sau này, không chặn các mốc sau. Nếu môi trường không có mạng, ghi rõ chưa đo được và đi tiếp.

**Mốc 1: AI Desk bằng quy tắc.**
- Cờ bật theo tài khoản, sidebar, các tab Recommended, Your bots. Tab Ask AI hiện "Coming soon".
- 3 câu hỏi nối `PUT /api/v1/goals` và `POST /api/v1/reco/plan`.
- Tuỳ chọn tắt bot phụ trong `recommend()` để bot chính dùng đủ vốn; hành vi của onboarding giữ nguyên.
- Thẻ đề xuất, câu mô tả cho 7 chiến lược trong `@drift/shared` hoặc messages, mức lỗ đúng theo mục 5 của spec, gồm trường hợp không có giới hạn.
- Trạng thái không có đề xuất, Verified trống.
- Goal check theo mục 3.1.
- Trang Why this one theo mục 6, lưu `notSuggested` cùng suggestion.
- Your bots: nhận xét kèm hành động. Dùng lại quy tắc của `analyze()`. "Review draft" mở form sửa bot, không tự sửa bot.

**Mốc 2: Paper mode.**
- Migration: cột `bots.mode`, các bảng hoặc cột cần cho số dư giả và snapshot. Migration chạy được trên dữ liệu cũ, mặc định `live`.
- `PaperGateway` hiện thực `Gateway`, chia sẻ logic với `packages/strategies/src/sim` nếu hợp lý.
- API tạo bot paper, bỏ qua kiểm tra builder fee và API key, vẫn kiểm tra cấu hình và lệnh tối thiểu.
- Tách dữ liệu paper khỏi mọi truy vấn thống kê ở mục 8.3.

**Mốc 3: màn hình Paper.**
- Trang Fake-money test, nhãn PAPER ở mọi nơi hiển thị bot.
- Trang Test results, kết luận theo bảng quy tắc ở mục 8.5, so với chỉ giữ coin.
- Màn Use real money theo mục 9: tính lại bằng `aiParameters()`, hiện thay đổi, gọi `startChecks` và `startBot`.
- Thông báo khi bot paper dừng, ghi rõ "fake money".
- Mobile theo mockup.

## 5. Yêu cầu chất lượng

- Theo quy ước sẵn có: logic thuần trong `packages/shared`, lỗi qua `AppError`, ghi qua `idempotent`, câu chữ mới trong `apps/web/messages/en.json` mục `_pendingReview` theo cách repo đang làm.
- Tiền và giá dùng decimal string, không dùng number để tính.
- Mọi màn hình làm đủ trạng thái: loading, rỗng, lỗi.
- Test bắt buộc:
  - Bot paper không gọi `HttpGateway` hay signer, kể cả khi có API key.
  - `HttpGateway` từ chối bot paper.
  - Dữ liệu paper không xuất hiện trong từng thống kê ở mục 8.3.
  - Luật khớp: chạm giá không khớp, xuyên giá khớp, market có trượt giá, thiếu số dư bị từ chối.
  - Kết luận Test results đúng thứ tự cho cả 4 trường hợp.
  - Goal check tính đúng và không đổi kết quả `recommend()`.
  - Tắt bot phụ dùng đủ vốn; onboarding không đổi.
- Chạy `pnpm` typecheck, lint và test của các package đã sửa. Một số test API và engine có thể chập chờn khi máy tải cao, chạy lại riêng test đó trước khi kết luận.
- Mở app chạy thử các màn hình nếu môi trường cho phép. Không đăng nhập bằng mật khẩu thật, không nhập 2FA. Không làm được thì nói rõ.

## 6. Git và phạm vi

- Repo đang có thay đổi chưa commit. Đọc lại file trước khi sửa, không ghi đè hay revert việc đang có.
- **Không commit, không push, không build hay deploy image** trừ khi được yêu cầu.
- Không sửa file ngoài phạm vi. Thấy lỗi khác thì ghi vào báo cáo.

## 7. Báo cáo cuối

Trả lời bằng tiếng Việt:

1. Đã làm gì theo từng mốc, mốc nào chưa xong.
2. Kết quả test thật, kèm số test pass và fail.
3. Những gì chưa kiểm tra được trên màn hình.
4. Quyết định đã tự chọn và DEC tương ứng.
5. Rủi ro còn lại, nhất là phần tách dữ liệu paper.
