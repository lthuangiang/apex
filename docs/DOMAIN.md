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
| draft | Start on mainnet | starting → running | checkbox + 2FA |
| running | Pause | pausing → paused | không |
| paused | Resume | resuming → running | không; chỉ khi lý do pause đã hết |
| running / paused | Stop… | stopping → stopped | dialog liệt kê lệnh sẽ huỷ + 2FA |
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
| `market_stats_daily` | `market`, `engine`, `date`, `sigma30`, `p5`, `p50`, `p95`, `last_price`, `trend`, `range_score`, `funding_avg7d`, `funding_pos21` | `scheduler` tính mỗi ngày (DEC-34) |
| `shard_epochs` | `shard` (int, khoá chính), `epoch` (bigint), `owner`, `acquired_at` | fencing token; lease thật nằm ở Redis |
| `outbox` | `topic`, `payload jsonb`, `published_at` | relay sang NATS |
| `idempotency_keys` | `key`, `user_id`, `request_hash`, `response jsonb`, `expires_at` | giữ 24 h |
| `notifications` | `user_id`, `type`, `payload`, `read_at`, `channel` | |
| `notification_settings` | `user_id`, `type`, `enabled` | loại "bot errors" luôn bật |
| `audit_log` | `user_id`, `action`, `target`, `metadata jsonb`, `ip`, `occurred_at` | mọi thao tác nhạy cảm (ký, revoke, disconnect, start/stop, 2FA) |
| `builder_revenue_daily` | `date`, `engine`, `from_fills`, `balance_delta`, `difference`, `status` (`matched`/`pending`) | chỉ role `team` xem |
