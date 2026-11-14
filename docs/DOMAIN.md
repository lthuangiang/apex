# DRIFT — Domain model

> Một phần của bộ tài liệu DRIFT. Đọc `CLAUDE.md` ở gốc repo trước. Số mục giữ nguyên như bản gốc để các tham chiếu "mục X" vẫn đúng (xem bảng mục lục trong `CLAUDE.md`).

## 6. Tám chiến lược (đều phát hành trong v1)

| key | Tên hiển thị | Engine | Builder fee áp dụng |
|---|---|---|---|
| `spot_grid` | Spot Grid | Spot | chỉ lệnh bán |
| `futures_grid` | Futures Grid | Perps | cả hai chiều |
| `spot_dca` | Spot DCA | Spot | chỉ lệnh bán |
| `futures_dca` | Futures DCA | Perps | cả hai chiều |
| `recurring_buy` | Recurring Buy | Spot | không (chỉ mua) |
| `rebalancing` | Rebalancing | Spot | chỉ lệnh bán |
| `funding_arb` | Funding Arbitrage | Spot + Perps | chân perp cả hai chiều, chân spot khi bán |
| `twap` | TWAP | Spot hoặc Perps | theo engine |
| `volume_maker` | Volume Maker (bot sự kiện) | Perps | đề xuất 0.01% **[confirm]**; **chỉ phát hành sau khi SoDEX xác nhận bằng văn bản** (mục 17) |

Mọi field (label, default, khoảng giá trị, help text, error message) nằm trong artboard **Bot & settings spec** mục 4. Chép **nguyên văn** vào zod schema và file i18n. Những khoảng giá trị phụ thuộc quy tắc market của SoDEX thì đọc từ market info, không hard-code.

---

## 7. Domain model

### 7.1 Vòng đời bot
Các trạng thái: `draft → starting → running ⇄ (pausing → paused → resuming) → stopping → stopped → archived`.

| Từ | Hành động | Sang | Xác nhận |
|---|---|---|---|
| draft | Start on mainnet | starting → running | checkbox + 2FA nếu đã bật (DEC-115) |
| running | Pause | pausing → paused | không |
| paused | Resume | resuming → running | không; chỉ khi lý do pause đã hết |
| running / paused | Stop… | stopping → stopped | dialog liệt kê lệnh sẽ huỷ, không hỏi 2FA (DEC-115) |
| running | Apply edit vN | running (vN) | dialog diff |
| stopped | Archive | archived | không |
| draft | Delete | — | có (chỉ xoá được draft) |

### 7.2 Reason code (lưu trên bot, hiển thị trên UI)

| Mã | Kết quả | Phạm vi | Được resume khi |
|---|---|---|---|
| `BUILDER_FEE_REVOKED` | paused | mọi bot | approval đọc lại ≥ 10 trên Spot và Perps (DEC-46); người dùng resume từng bot |
| `API_KEY_EXPIRED` | paused | mọi bot | key mới đã tạo và xác minh |
| `API_KEY_UNUSABLE` | paused | mọi bot | key còn active và còn hạn nhưng signer không ký được (giải mã lỗi, SoDEX không nhận key); resume như `API_KEY_EXPIRED`: chỉ sau khi ký lại key, người dùng resume từng bot (DEC-56) |
| `API_KEY_DELETED` | paused | mọi bot | account đã kết nối lại |
| `RISK_DAILY_LOSS` | paused | mọi bot | tới lần reset ngày (00:00 theo múi giờ người dùng) |
| `RISK_DRAWDOWN` | paused | mọi bot | **[confirm]** |
| `BOT_MAX_LOSS` | paused | một bot | người dùng tăng max loss qua màn Edit |
| `ORDER_REJECTED` | paused | một bot | người dùng xem lý do và resume |
| `INSUFFICIENT_BALANCE` | paused | một bot | kiểm tra số dư đạt |
| `STOP_LOSS` / `TAKE_PROFIT` | stopped | một bot | — (dùng Duplicate) |
| `EMERGENCY_HALT` | stopped | mọi bot | — |
| `BUDGET_DONE` / `MAX_CYCLES` | stopped | một bot | — |

- `paused` giữ lệnh đang mở. `stopped` huỷ lệnh của bot rồi thực hiện hành động kết thúc (giữ / bán / đóng vị thế).
- Giá ra khỏi range của grid **không** phải pause: bot vẫn `running`, chỉ bật cờ `needs_attention`.

### 7.3 Lệnh
Trạng thái: `open, partially_filled, filled, cancelled, rejected, unknown, not_placed`. `unknown` → đối soát với SoDEX → `filled` / `open` / `not_placed`. Khi còn `unknown`, nút Retry bị disable kèm dòng "available after check".

### 7.4 Version cấu hình
Mỗi lần áp dụng chỉnh sửa tạo version `v(n+1)`. Version cũ vẫn chạy cho tới khi backend xác nhận version mới. Mỗi version lưu `paramSource: "ai" | "ai_edited" | "manual"` và id của suggestion AI.

### 7.5 Schema dữ liệu (PostgreSQL)

Quy ước theo `docs/CODING_STANDARDS.md` C8: khoá chính `id uuid` (v7), mọi bảng có `created_at` và `updated_at`, tiền dùng `numeric(38,18)`, phí dùng `integer` theo phần mười bp. Đây là bản tối thiểu; thêm cột thì ghi lại ở đây.

| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `users` | `email`, `wallet_address`, `display_name`, `timezone` (IANA), `number_format`, `twofa_enabled`, `twofa_secret` (mã hoá), `twofa_pending_secret`, `twofa_last_step`, `role` (`user`/`team`) | `wallet_address` không dùng để đăng nhập (DEC-28) |
| `sessions` | `user_id`, `token_hash`, `expires_at` (trượt 7 ngày), `absolute_expires_at` (30 ngày), `last_seen_at`, `revoked_at`, `ip`, `user_agent` | cookie phiên (DEC-28, DEC-29) |
| `email_otps` | `email`, `code_hash`, `expires_at`, `attempts`, `consumed_at` | đăng nhập bằng OTP (DEC-28) |
| `twofa_backup_codes` | `user_id`, `code_hash`, `used_at` | backup code 2FA, chỉ lưu hash |
| `sodex_accounts` | `user_id`, `address`, `sodex_account_id` (bigint), `network`, `status` | một user có thể có nhiều account **[confirm]** |
| `api_keys` | `sodex_account_id`, `name`, `public_key`, `ciphertext`, `kms_key_ref`, `last4`, `permissions_mask`, `expires_at`, `last_used_at`, `status` (`pending`/`active`/`expired`/`deleted`) | private key chỉ ở dạng mã hoá; chỉ `signer` đọc được `ciphertext` |
| `user_builder_fees` | `user_id`, `strategy` (khoá chính kép), `rate` (phần mười bp, 0–10, CHECK), `updated_by` | builder fee riêng do team đặt (DEC-159); không có dòng = mặc định của chiến lược |
| `leader_wallets` | `source`, `address` (khoá chính kép), `display_name`, `is_vault` (null = chưa hỏi `userRole`), `account_value`, `leaderboard_pnl_30d`, `last_on_leaderboard_at`, `fill_cursor` | ví trader ứng viên (Copy Trading, DEC-163); con trỏ fill cho T0 / T1 |
| `leaderboard_runs` | `date` (khoá chính), `status` (`running`/`ok`/`failed`), `candidates`, `computed`, `error`, `finished_at` | một lượt tính leaderboard hằng đêm; danh sách dùng lượt `ok` gần nhất |
| `leader_stats_daily` | `source`, `address`, `date` (khoá chính ba cột), `stats` (jsonb `LeaderStats`), `hidden[]`, `tabs[]`, `steady_score`, `profit`, `typical_hold_ms`, `computed_at` | thống kê 30 ngày theo episode của từng trader mỗi ngày |
| `leader_events` | `id`, `source`, `address`, `coin`, `market` (null = SoDEX không có), `kind` (`open`/`add`/`reduce`/`close`/`flip`/`liquidated`), `position_before/after`, `notional`, `price`, `realized`, `at`, `seen_at`, `last_tid` (unique theo ví) | thay đổi vị thế gộp 60 giây (Trader profile, Following) |
| `leader_follows` | `user_id`, `source`, `address` (khoá chính ba cột) | Following, tối đa 5 / người, ~40 ví toàn hệ thống; xoá khi xoá tài khoản |
| `leader_alert_state` | `source`, `address`, `coin` (khoá chính ba cột), `last_alert_at` | cooldown 10 phút của cảnh báo big move |
| `builder_approvals` | `sodex_account_id`, `builder_id`, `max_fee_rate_spot`, `max_fee_rate_perps` (null = SoDEX không trả approval), `read_back_at` | lần đọc lại gần nhất từ SoDEX |
| `sodex_signature_requests` | `user_id`, `sodex_account_id`, `action` (`add_api_key`/`approve_builder_fee`/`revoke_builder_fee`), `api_key_id`, `message jsonb`, `status` (`pending`/`succeeded`/`failed`/`unknown`), `sodex_error`, `expires_at`, `submitted_at`, `resolved_at` | mỗi chữ ký master wallet (DEC-30) |
| `goals` | `user_id`, `goal`, `capital`, `max_drop_pct`, `markets text[]` | onboarding bước 5 |
| `risk_limits` | `sodex_account_id`, `daily_loss_pct`, `max_drawdown_pct`, `per_trade_pct`, `max_leverage`, `max_positions`, `enforced jsonb` | `enforced` ghi rõ giới hạn nào server chặn, giới hạn nào chỉ cảnh báo |
| `bots` | `user_id`, `sodex_account_id`, `strategy`, `market`, `engine`, `name`, `state`, `reason_code`, `needs_attention`, `active_version_id`, `archived_at` | `state` và `reason_code` lấy từ enum trong `packages/shared` |
| `bot_versions` | `bot_id`, `version` (int), `config jsonb`, `param_source`, `ai_suggestion_id`, `status` (`pending`/`active`/`superseded`/`rejected`), `applied_at` | `config` phải qua zod schema của chiến lược; unique (`bot_id`, `version`) |
| `orders` | `bot_id`, `sodex_account_id`, `cl_ord_id`, `sodex_order_id`, `market`, `side`, `type`, `time_in_force`, `price`, `size`, `filled_size`, `avg_price`, `status`, `reduce_only`, `builder_fee`, `epoch`, `submitted_at`, `acked_at`, `reconciled_at`, `reject_code`, `reject_message` | unique (`sodex_account_id`, `cl_ord_id`) |
| `fills` | `order_id`, `sodex_trade_id`, `price`, `size`, `fee`, `builder_fee`, `fee_coin`, `is_maker`, `filled_at` | unique `sodex_trade_id`; `fee` đã gồm `builder_fee` |
| `funding_payments` | `sodex_account_id`, `bot_id` (null với dữ liệu import), `position_id`, `market`, `amount` (dương = trả), `paid_at` | |
| `bot_events` | `bot_id`, `type`, `decision`, `why`, `result`, `payload jsonb`, `occurred_at` | nguồn cho bảng "Decisions & actions" |
| `imports` | `sodex_account_id`, `status` (`queued`/`running`/`done`/`failed`), `progress jsonb`, `coverage jsonb`, `error`, `started_at`, `finished_at` | onboarding bước 3 (DEC-34) |
| `history_trades` | `sodex_account_id`, `engine`, `trade_id`, `order_id`, `cl_ord_id`, `market`, `side`, `price`, `quantity`, `fee` (quy ra quote), `builder_fee`, `fee_coin`, `is_maker`, `traded_at` | fill lịch sử đã import; unique (`sodex_account_id`, `engine`, `trade_id`) |
| `history_positions` | `sodex_account_id`, `position_id`, `market`, `side`, `avg_entry_price`, `avg_close_price`, `closed_size`, `trading_fee`, `realized_pnl`, `leverage`, `opened_at`, `closed_at` | position Perps đã đóng |
| `funding_rates` | `market`, `funding_time`, `rate` | funding theo kỳ do `marketdata` ghi |
| `account_analyses` | `sodex_account_id`, `period_start`, `period_end`, `metrics jsonb`, `computed_at` | onboarding bước 4 |
| `ai_suggestions` | `user_id`, `context` (`onboarding`/`create`/`retune`), `strategy`, `market`, `values jsonb`, `reasons jsonb`, `basis`, `inputs_version`, `computed_at` | kết quả engine đề xuất |
| `backtest_runs` | `user_id`, `strategy`, `market`, `params_hash`, `period_days`, `data_version`, `status`, `result jsonb`, `error`, `finished_at` | cache theo (`strategy`, `market`, `params_hash`, `period_days`, `data_version`) |
| `candles_1m` | `market`, `ts`, `open`, `high`, `low`, `close`, `volume` | Timescale hypertable, khoá (`market`, `ts`) |
| `mm_market_hourly` | `market`, `hour`, `notional`, `markout_notional`, `trades`, `spread_ticks jsonb`, `updated_at` | markout 30 s phía maker của giao dịch công khai + histogram spread theo tick, theo giờ; `marketdata` ghi, giữ 48 giờ (DEC-227) |
| `mid_1s` | `market`, `ts`, `mid` | giá giữa mỗi giây, chỉ market có bot MM, giữ 48 giờ (DEC-227) |
| `mm_model_coefs` | `version` (identity), `a`, `k`, `points`, `day`, `created_at` | hệ số mô hình chi phí Market Making, scheduler fit mỗi ngày; API dùng dòng mới nhất (DEC-228) |
| `market_stats_daily` | `market`, `engine`, `date`, `sigma30`, `p5`, `p50`, `p95`, `last_price`, `trend`, `range_score`, `funding_avg7d`, `funding_pos21` | `scheduler` tính mỗi ngày (DEC-34) |
| `shard_epochs` | `shard` (int, khoá chính), `epoch` (bigint), `owner`, `acquired_at` | fencing token; lease thật nằm ở Redis |
| `outbox` | `topic`, `payload jsonb`, `published_at` | relay sang NATS |
| `idempotency_keys` | `key`, `user_id`, `request_hash`, `response jsonb`, `expires_at` | giữ 24 h |
| `notifications` | `user_id`, `type`, `payload`, `read_at`, `channel` (`in_app`/`email`/`telegram`), `delivery_status` (`queued`/`sent`/`failed`, chỉ bản `telegram`) | danh sách chuông chỉ đọc `channel = in_app`; bản `telegram` ghi cùng outbox `jobs.telegram` / `jobs.telegram_alert`, worker jobs gửi (docs/NOTIFICATIONS.md mục 6) |
| `notification_settings` | `user_id`, `type` (= nhóm: `botErrors`, `risk`, `keyFee`, `daily`, `fills`, `copyTrading`, `teamOps`), `channel`, `enabled`; khoá (`user_id`, `type`, `channel`) | chỉ lưu khi user đổi khỏi mặc định (`NOTIFICATION_DEFAULTS`); `botErrors` luôn bật; `teamOps` chỉ role `team`, chỉ Telegram (DEC-191) |
| `telegram_links` | `user_id` (khoá chính), `chat_id` (unique), `username`, `status` (`active`/`blocked`), `connected_at`, `last_sent_at`, `blocked_at` | mỗi user một chat, mỗi chat một user; Telegram trả 403 → `blocked`; `/stop` hoặc Disconnect thì xoá dòng (DEC-170) |
| `telegram_link_tokens` | `user_id`, `token_hash` (SHA-256, unique), `expires_at`, `used_at` | token deep link `/start`: sống 10 phút, dùng một lần, mỗi user tối đa một token còn hiệu lực; không lưu token gốc |
| `audit_log` | `user_id`, `action`, `target`, `metadata jsonb`, `ip`, `occurred_at` | mọi thao tác nhạy cảm (ký, revoke, disconnect, start/stop, 2FA) |
| `builder_revenue_daily` | `date`, `engine`, `from_fills`, `balance_delta`, `difference`, `status` (`matched`/`pending`) | chỉ role `team` xem |

### 7.6 AI Desk B+ (DEC-166 và các DEC đi kèm)

| Bảng | Một dòng là | Ghi chú |
|---|---|---|
| `desk_items` | Một việc "Needs you" của một bot theo một quy tắc (unique bot × quy tắc) | `facts` jsonb là nguồn số liệu cho thẻ và Desk AI; `fingerprint` đổi → việc mới; `snoozed_at` cho "Later" 7 ngày; `resolved_at` khi quy tắc không còn đúng (DEC-173) |
| `desk_whatifs` | Một lần so sánh phương án của một việc, cho đúng version bot | `options` jsonb (patch + kết quả 7 ngày), `status` queued → running → done / failed / unavailable; job ở hàng đợi `backtest.run {whatifId}`; job kẹt được scheduler dọn (DEC-176, #28) |
| `desk_applies` | Một lần Apply phương án (version "AI suggested") | Giữ chỗ trước khi tạo version (mỗi so sánh Apply một lần); `baseline_config` để Switch back; cột đo Thành tích `record_status`, `record`, `verdict`, `checked_at`, `switched_back_version` (DEC-177) |
| `desk_ai_conversations` | Một cuộc trò chuyện Desk AI (`chat`) hoặc báo cáo sáng (`brief`, mỗi user mỗi ngày địa phương một) | Xoá sau 90 ngày (scheduler) hoặc khi user bấm "Delete history" |
| `desk_ai_turns` | Một lượt hỏi / trả lời, kèm nhật ký LLM | Câu trả lời (lời LLM hoặc câu mẫu), `fallback`, model, phiên bản prompt, id fact, token, chi phí ước tính, traceId; không lưu key |
| `desk_ai_usage` | Số câu hỏi đã dùng của user trong một ngày địa phương | Trần 20 câu (DEC-165b); không bị "Delete history" xoá; giữ lượt bằng một câu upsert có điều kiện (DEC-189) |

### 7.7 OAuth và MCP (DEC-167, DEC-215)

| Bảng | Nghĩa | Ghi chú |
|---|---|---|
| `oauth_clients` | Client OAuth của MCP; `id` là `client_id` | `kind = cimd` (client_id là URL https của Client ID Metadata Document, metadata cache 1 giờ) hoặc `dcr` (đăng ký động, `dlc_…`). `name` do client tự khai, không tin cậy. Client `dcr` không dùng 30 ngày thì xoá (scheduler) |
| `oauth_codes` | Authorization code, dùng một lần | Chỉ lưu hash; sống 5 phút; PKCE S256 (`code_challenge`); gắn `resource` (RFC 8707) và scope đã cấp |
| `mcp_tokens` | Access token (1 giờ) + refresh token (30 ngày) | Chỉ lưu hash. Refresh xoay mỗi lần dùng (`rotated_at`, cùng `family_id`); dùng lại refresh đã xoay → thu hồi cả họ. `revoked_at` có hiệu lực ngay (introspect mỗi request) |
| `mcp_calls` | Nhật ký mỗi lần gọi tool MCP | user, client, endpoint (`user` / `team`), tool, hash tham số, thời gian, trạng thái, `trace_id`; không lưu nội dung trả về; xoá sau 90 ngày |
| `bot_drafts` | Bản nháp từ Claude (scope `draft`, DEC-223) | user, `bot_id` (null = bot mới), chiến lược, tên, config đã kiểm tra như màn Create / Edit, `client_id`, `expires_at` (24 giờ), `opened_at` (lần đầu người dùng mở). Không ảnh hưởng bot nào; tối đa 20 bản chưa mở còn hạn mỗi user; xoá 7 ngày sau khi hết hạn |
