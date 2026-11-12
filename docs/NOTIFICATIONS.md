# Notifications v2: DeskLabs Bot trên Telegram + thông báo in-app

**Trạng thái:** đã duyệt (**DEC-170**, 2026-11-12). Đã trả lời câu hỏi 10 cũ trong `docs/OPEN_QUESTIONS.md`.
**Thiết kế:** canvas "AI Desk redesign", hàng "Notifications v2" (`NT-Scope`, `NT-Settings`, `NT-Connect`, `NT-Telegram`, `NT-InApp`); bản chép trong `docs/mockups/notifications/`.

## 1. Hiện có

- `apps/jobs/src/notify.ts` (consumer `jobs.notify`, DEC-41) ghi bản in-app và gửi email, dựa trên `notification_settings`.
- `packages/shared/src/api/notifications.ts` có 6 nhóm: `botErrors` (luôn bật), `risk`, `keyFee`, `fills`, `daily`, `copyTrading` (chỉ in-app, DEC-163 §11). Kênh: `in_app`, `email`.
- Web: bấm chuông chuyển sang Settings › Notifications. Không có toast. Poll `useNotifications` mỗi 60 s.

## 2. Mục tiêu

1. Thêm kênh `telegram`. Kết nối bằng một lần bấm **Start**, không phải gõ mã hay dán gì.
2. Thông báo in-app tốt hơn: chuông mở panel, toast cho Bot problems và Risk.
3. **Telegram chỉ báo tin rồi mở app.** Không có nút nào làm đổi bot, lệnh, tiền hay cài đặt.

## 3. Luồng kết nối Telegram

1. **Web:** Settings › Notifications › `Connect Telegram`.
2. **API** `POST /api/v1/telegram/link`: tạo token ngẫu nhiên 32 byte, base64url. Chỉ lưu hash SHA-256 vào `telegram_link_tokens`. Token sống **10 phút**, dùng **1 lần**. Mỗi user chỉ có 1 token còn hiệu lực; tạo token mới thì token cũ bị huỷ.
3. **Web:** hiện nút `Open Telegram` (deep link `https://t.me/<bot>?start=<token>`) và mã QR cho máy tính. Token chỉ gồm `[A-Za-z0-9_-]`, dài ≤ 64 ký tự (giới hạn của tham số `start`).
4. **Telegram → API:** webhook `POST /api/v1/telegram/webhook`, kiểm tra header `X-Telegram-Bot-Api-Secret-Token` (so sánh constant-time). Nhận `/start <token>`.
5. **API:** chỉ chấp nhận khi token hợp lệ, chưa hết hạn, chưa dùng **và** `chat.type = private`. Khi đó upsert `telegram_links`, huỷ token, ghi audit `telegram.connected`, rồi bot gửi tin chào.
   - Token sai, hết hạn hoặc đã dùng: bot trả lời "This link expired. Open DeskLabs › Settings to get a new one." và không gắn gì.
6. **Web:** poll `GET /api/v1/telegram/link` mỗi 2 s khi hộp thoại đang mở. Khi có kết quả thì chuyển sang `Connected` và hiện nút `Send a test message`.

**Ngắt kết nối:**
- Web `DELETE /api/v1/telegram/link` (dialog xác nhận, không cần 2FA vì chỉ giảm quyền), hoặc gõ `/stop` trong Telegram.
- Bot gửi tin cuối "Disconnected from DeskLabs.", rồi xoá `chat_id`.

**Bị chặn:**
- Khi gửi bị lỗi 403 (user chặn bot hoặc xoá chat), đặt `status = blocked` và ngừng gửi.
- Tạo một thông báo in-app cho user. Card trong Settings hiện `Paused · bot blocked` kèm nút `Connect again`.

**Quy tắc:**
- 1 user ↔ 1 chat. Kết nối lại thì chat mới thay chat cũ.
- Một `chat_id` chỉ gắn với 1 user. Gắn sang user khác thì gỡ khỏi user cũ, kèm thông báo in-app cho user cũ.

## 4. Nhóm và mặc định

| Nhóm | In-app | Email | Telegram | Toast |
|---|---|---|---|---|
| `botErrors` | luôn bật | luôn bật | **luôn bật** khi đã kết nối | có |
| `risk` | bật | bật | bật | có |
| `keyFee` | bật | bật | bật | không |
| `daily` → **Morning brief** (Desk AI, 08:00 giờ địa phương, DEC-165) | tắt | tắt | **bật sẵn**, tắt được | không |
| `fills` | tắt | tắt | tắt | không |
| `copyTrading` | bật | — | tắt, user tự bật (DEC-170 thay DEC-163 §11 cho Telegram) | không |

Morning brief do Desk AI viết theo luật fact (DEC-164/165). Khi LLM tắt hoặc lỗi thì gửi câu mẫu cố định. Mọi con số trong brief phải khớp một fact (luật DEC-165), không thì dùng câu mẫu.

## 5. Nội dung tin Telegram

- Cấu trúc: tiêu đề một dòng (emoji theo nhóm), 1–2 câu, rồi **một URL button** mở đúng màn hình.
  - Màn hình đích: Trading Agent, Risk Center, Settings hoặc AI Desk.
  - Link không chứa token đăng nhập.
- Câu chữ lấy từ cùng nguồn với `emailText()`, chuyển sang file i18n (tiếng Anh).
- **Số tiền được phép (DEC-170):** PnL, số đã lỗ, giới hạn đã dùng, ngưỡng rủi ro. Lấy từ cùng fact backend như màn hình trong app (quy tắc 1.8): thiếu dữ liệu thì bỏ câu có số, không ghi `0`. Lãi/lỗ luôn có ▲/▼ và đơn vị (`−10.09 USDC ▼`). Bot tiền giả ghi rõ "fake money" cạnh số.
- **Không bao giờ gửi:**
  - địa chỉ ví;
  - key, secret, mã 2FA, link đăng nhập;
  - bất cứ thứ gì ngoài 4 ký tự cuối của key.
- Tên bot do user đặt luôn được escape (`parse_mode: HTML`, escape `& < >`), nên không thể trở thành link hay lệnh.
- Bot tiền giả (DEC-105): tiêu đề luôn ghi "fake-money test".
- **Gộp tin:** nhiều sự kiện cùng nhóm trong 60 s (ví dụ revoke fee hay halt all làm pause nhiều bot) thì gửi một tin gộp, dạng "3 bots paused: builder fee approval is 0." Cách đếm (PM chốt, PR4): tin đầu của một nhóm chờ 5 s để gom rồi gửi 1 tin (1 sự kiện → tin thường, ≥ 2 → tin gộp); tin cùng nhóm tới trong phần còn lại của cửa sổ 60 s sau lần gửi đó được giữ và gửi chung 1 tin gộp ở cuối cửa sổ. Bot problems vẫn đi hàng ưu tiên.

**Lệnh của bot (v1):**
- `/start [token]`: kết nối. Không có token thì bot chỉ cách kết nối từ app.
- `/status`: tên bot, trạng thái và **PnL tổng** của từng bot (cùng `netPnl` với Strategy Lab, có ▲/▼ và đơn vị; thiếu → "Not available"), ví dụ "🟢 ETH Grid · running · total +12.40 USDC ▲". PnL theo ngày để sau khi có fact (DEC-187). Giới hạn 10 lần/giờ/chat.
- `/stop`: ngắt kết nối.
- `/help`: danh sách lệnh.

Tin nhắn tự do thì bot trả lời bằng câu cố định. v1 không đưa tin nhắn tự do vào LLM và không lưu nội dung.

## 6. Gửi tin

- `jobs.notify` thêm nhánh `telegram`: ghi `notifications` với `channel = telegram`, rồi đẩy vào hàng đợi `notify.telegram`.
- Worker gửi qua Bot API `sendMessage` bằng `fetch`, **không thêm dependency**.
- Bot token lấy từ Vault (`DRIFT_TELEGRAM_BOT_TOKEN`); username từ `DRIFT_TELEGRAM_BOT_USERNAME`. Không bao giờ log token, vì nó nằm trong URL của Bot API, nên phải che URL khi log.
- **Giới hạn của Telegram:** khoảng 1 tin/giây mỗi chat, khoảng 30 tin/giây toàn bot. Có token bucket riêng; `botErrors` được ưu tiên.
- **Gửi lại:** đây không phải thao tác tài chính nên được phép gửi lại. Khoá idempotent theo `notification_id`.
  - 429: chờ `retry_after` rồi gửi lại.
  - 5xx: backoff, tối đa 5 lần.
  - 403: đặt `blocked`.
  - 400 "chat not found": đặt `blocked`.
- Feature flag `TELEGRAM_ENABLED` (mặc định `false`).

## 7. In-app

- **Chuông mở panel** (popover 420 px; trên điện thoại là sheet toàn màn hình), không chuyển sang Settings nữa.
  - Tab `All` và `Needs you`. "Needs you" gồm `botErrors` và `risk` chưa đọc là sự cố thật: không tính bot dừng đúng kế hoạch (`BUDGET_DONE`, `MAX_CYCLES`, `TAKE_PROFIT`) và bot tiền ảo; các tin đó chỉ ở `All`, icon trung tính (DEC-180).
  - Nhóm theo Today / Earlier. `Mark all read`.
  - Bấm một dòng thì đánh dấu đã đọc và mở màn hình liên quan.
  - Chân panel: `Notification settings` và `See all` (danh sách đầy đủ vẫn ở Settings › Notifications).
- **Toast:** chỉ cho `botErrors` và `risk`, cùng luật "sự cố thật" như `Needs you`.
  - `aria-live="assertive"`, tự ẩn sau 8 s, không ẩn khi đang hover hoặc focus.
  - Mỗi lúc chỉ có 1 toast; nhiều sự kiện thì gộp lại.
- **Cập nhật:** giữ cơ chế poll (`useNotifications`), nhưng đổi từ 60 s xuống 15 s khi tab đang hiện; tab ẩn thì ngừng poll. v1 không thêm SSE.
- **Rỗng:** "You're all caught up." **Lỗi tải:** giữ danh sách cũ, ghi giờ cập nhật.

## 8. Dữ liệu (migration Drizzle)

| Bảng | Cột chính |
|---|---|
| `telegram_link_tokens` | `id`, `user_id`, `token_hash` (unique), `expires_at`, `used_at`, `created_at` |
| `telegram_links` | `user_id` (PK), `chat_id` (unique, bigint), `username` (nullable), `status` (`active` / `blocked`), `connected_at`, `last_sent_at`, `blocked_at` |
| `notification_settings` | thêm giá trị `telegram` cho `channel` |
| `notifications` | `channel` nhận thêm `telegram`; thêm `delivery_status` (`queued` / `sent` / `failed`) cho bản Telegram |

Thêm `telegram` vào `NOTIFICATION_CHANNELS` và `NOTIFICATION_DEFAULTS` trong `packages/shared`. Xoá tài khoản thì xoá cả `telegram_links` và token.

## 9. API

| Method | Đường dẫn | Ghi chú |
|---|---|---|
| `POST` | `/api/v1/telegram/link` | tạo token, trả `{ deepLink, expiresAt }`; `Idempotency-Key`; rate limit 5/phút/user |
| `GET` | `/api/v1/telegram/link` | `{ status: not_connected / pending / active / blocked, username?, connectedAt? }` |
| `DELETE` | `/api/v1/telegram/link` | ngắt kết nối |
| `POST` | `/api/v1/telegram/test` | gửi tin thử; 3 lần/giờ |
| `POST` | `/api/v1/telegram/webhook` | công khai, chỉ nhận khi đúng secret header; luôn trả 200 nhanh, việc nặng đẩy vào hàng đợi |

Lỗi theo format C6. Thêm mã lỗi `TELEGRAM_NOT_CONNECTED`, `TELEGRAM_LINK_EXPIRED`.

## 10. Kiểm thử

- Unit:
  - token: hết hạn, dùng lại, sai, chat không phải `private`;
  - gắn `chat_id` cho user thứ hai;
  - escape tên bot;
  - gộp tin;
  - ánh xạ lỗi 403/429.
- Test quét output: tin Telegram không chứa key, secret, địa chỉ ví; mọi số tiền khớp fact nguồn.
- Test quy tắc: `botErrors` vẫn được gửi khi user cố tắt; không có endpoint hay lệnh Telegram nào đổi trạng thái bot.
- E2E: dùng một Bot API giả (mock HTTP), đi hết luồng kết nối → nhận thông báo → `/stop`.
- a11y cho panel chuông và toast, ở 1440 và 390.

## 11. Giai đoạn

1. **N0:** đã xong (DEC-170). Bot `@desklabsbot` đã tạo; token đã có trong `.env` local; production cần đưa token vào Vault.
2. **N1:** in-app (panel, toast, poll 15 s).
3. **N2:** schema, API kết nối, webhook, Settings card.
4. **N3:** worker gửi tin, gộp tin, xử lý trạng thái blocked.
5. **N4:** Morning brief qua Telegram. Cần AI Desk B+ M5; trước đó gửi câu mẫu.
6. **N5:** E2E, cập nhật `docs/SCREENS.md` 8.5, `docs/DOMAIN.md`, `docs/DEPLOY.md` (secret webhook, `setWebhook`).

## 12. Đã chốt (DEC-170)

1. Bot đã tạo: tên hiển thị **DeskLabs**, username **`@desklabsbot`** (`DRIFT_TELEGRAM_BOT_USERNAME=desklabsbot`). Token chỉ nằm trong `.env` local (git-ignored) và Vault ở production, không ghi vào tài liệu.
2. Copy Trading big move: **được gửi qua Telegram, mặc định tắt**.
3. Morning brief: **bật sẵn** khi vừa kết nối, tắt được.
4. Số tiền trong tin Telegram: **có**, theo luật ở mục 5.
5. Để sau: hỏi Desk AI ngay trong Telegram (tính vào 20 câu/ngày), giờ im lặng, push trình duyệt.

## 13. Báo team qua Telegram (DEC-184, người dùng chốt 2026-11-12)

Thành viên **role `team`** (DEC-64) đã kết nối Telegram nhận tin khi có hoạt động mới của người dùng, để theo dõi tăng trưởng và hỗ trợ kịp lúc.

**Sự kiện** (chỉ khi backend xác nhận, quy tắc 1.6):

| Sự kiện | Khi nào | Nguồn |
|---|---|---|
| `team_signup` | tài khoản mới được tạo xong (đã xác minh email) | `apps/api` auth |
| `team_sodex_connected` | kết nối SoDEX thành công (đủ hai chữ ký, DEC-25) | `apps/api` sodex connect |
| `team_bot_started` | bot **tiền thật** chuyển sang `running` lần đầu của mỗi lần Start (engine xác nhận) | engine / sự kiện `state` |

- Không báo bot tiền ảo (`mode = paper`, DEC-105), không báo kết nối lỗi.
- Không báo hoạt động của chính tài khoản role `team` (tránh báo khi team tự thử).

**Nội dung tin** (che bớt, Telegram là bên thứ ba):
- Email che: 2 ký tự đầu + `···@` + tên miền (`gi···@gmail.com`).
- Ví che: `0x` + 4 ký tự đầu + `…` + 4 ký tự cuối (`0x3e9a…11fd`). Không bao giờ gửi địa chỉ đầy đủ, key, chữ ký.
- `team_bot_started`: tên bot (escape HTML), chiến lược, market, vốn (USDC, từ cấu hình bot).
- Một nút URL mở trang **Users** của DeskLabs (role `team`) để xem đầy đủ; link không chứa token.
- Ví dụ: `🆕 New signup · gi···@gmail.com` · `🔗 SoDEX connected · gi···@gmail.com · 0x3e9a…11fd` · `▶️ Bot started · gi···@gmail.com · BTC Grid · Futures Grid · BTC-USD · 200 USDC`.

**Gửi:**
- Gửi ngay; nhiều sự kiện **cùng loại** trong 60 giây gộp thành một tin (`3 new signups`, kèm tối đa 5 dòng che bớt, còn lại "+N more").
- Fan-out: một sự kiện → một tin cho mỗi thành viên team có Telegram `active` và bật nhóm này. Đi qua worker gửi của mục 6 (giới hạn tốc độ, gửi lại, 403 → `blocked`).
- Không tạo bản in-app hay email cho nhóm này ở v1 (chỉ Telegram).

**Cài đặt:**
- Nhóm mới `teamOps`, chỉ hiện ở Settings › Notifications với role `team`; chỉ kênh Telegram; **mặc định bật** khi thành viên team đã kết nối Telegram; tắt được.
- API kiểm tra lại role `team` mỗi lần gửi (role bị gỡ thì ngừng nhận ngay).

**Làm:** sau PR4 (worker gửi, mục 11 N3). Test: không gửi cho user thường; không gửi sự kiện paper / của tài khoản team; che email/ví đúng; gộp 60 giây; quét output không có địa chỉ ví đầy đủ.
