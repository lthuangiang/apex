# DRIFT — Kiến trúc hệ thống và stack

> Một phần của bộ tài liệu DRIFT. Đọc `CLAUDE.md` ở gốc repo trước. Số mục giữ nguyên như bản gốc để các tham chiếu "mục X" vẫn đúng (xem bảng mục lục trong `CLAUDE.md`).

## 3. Kiến trúc hệ thống (docker compose, scale ngang)

Mục tiêu: chạy được cả hệ thống bằng `docker compose` (dev, staging, production 1 host). Muốn scale chỉ cần tăng số replica, không phải sửa code. Khi vượt quá 1 host thì chuyển nguyên các image này sang Kubernetes.

### 3.1 Sơ đồ

```
 Browser ──HTTPS──▶ traefik ──▶ web (Next.js)            [stateless, N bản]
                          ├──▶ api  (REST)               [stateless, N bản] ──┐
                          └──▶ realtime (WebSocket)       [stateless, N bản]   │
                                                                               │
 ┌──────────────────────────── core network ──────────────────────────────────┤
 │  engine ×N   (bot workers, mỗi worker giữ một số shard account)            │
 │  marketdata  (1 active + standby, lấy giá/kline/funding từ SoDEX WS)       │
 │  scheduler   (1 active + standby, phát job theo lịch)                      │
 │  jobs ×N     (import lịch sử, phân tích, đối soát, builder revenue, notify)│
 │  reco ×N     (engine đề xuất + AI parameters)                              │
 │  backtest ×N (worker mô phỏng, CPU nặng)                                   │
 │                                                                            │
 │  NATS JetStream (event + job queue) · Redis (lease, cache, rate limit)     │
 │  PostgreSQL + TimescaleDB (qua PgBouncer)                                  │
 └────────────────────────────────────────────────────────────────────────────┘
 ┌──── secure network (internal, không ra Internet) ────┐
 │  signer ×2 (giải mã DRIFT API key, chỉ ký) · Vault/KMS │  ◀── chỉ api và engine gọi được
 └───────────────────────────────────────────────────────┘
 engine / marketdata / jobs ──HTTPS/WSS──▶ SoDEX
```

### 3.2 Các service

| Service | Việc làm | Trạng thái | Cách scale |
|---|---|---|---|
| `web` | Next.js, giao diện desktop + mobile | stateless | tăng replica |
| `api` | REST cho web: auth, bot CRUD, settings, gửi job | stateless | tăng replica |
| `realtime` | Đẩy sự kiện tới trình duyệt qua WebSocket (nghe NATS `user.<accountId>.*`) | stateless | tăng replica |
| `engine` | Chạy logic bot (kể cả lịch Recurring Buy / TWAP qua `timer` mỗi vòng, DEC-61), giữ WS user stream của SoDEX cho các account mình sở hữu, gửi lệnh | sở hữu shard qua lease | tăng replica; shard tự chia lại |
| `signer` | Giải mã API key của DRIFT (Vault transit / KMS), ký payload, ghi audit | stateless (key chỉ nằm trong RAM, có TTL) | 2+ replica |
| `marketdata` | Kết nối WS thị trường SoDEX, publish `md.<market>.*`, lưu `candles_1m` | leader lease | 1 active; khi nhiều market thì chia nhóm market |
| `scheduler` | Cron: reset daily loss, nhắc key sắp hết hạn, tính market stats mỗi ngày | leader lease | 1 active |
| `jobs` | Import lịch sử, account analysis, đối soát lệnh `unknown`, builder revenue, thông báo | consumer group | tăng replica |
| `reco` | Engine đề xuất + AI parameters (mục 10) | stateless + cache | tăng replica |
| `backtest` | Mô phỏng (mục 11) | consumer group | tăng replica |
| `postgres` | Dữ liệu chính + Timescale hypertable cho candles | stateful | primary + read replica (sau) |
| `pgbouncer` | Connection pool (transaction mode) | stateless | 1–2 |
| `redis` | Shard lease, leader lease, rate limit, cache | stateful | 1 (Sentinel/Cluster khi lớn) |
| `nats` | JetStream: event bus + work queue | stateful | 1 (dev) → cluster 3 node (prod) |

### 3.3 Mô hình scale và tính đúng đắn

1. **Mỗi account SoDEX chỉ có một writer.** Account chia vào `ENGINE_SHARDS = 64` shard ảo theo `shard = hash(accountId) % 64`.
   - Mỗi engine worker xin lease Redis `lease:shard:{n}` (`SET NX PX 15000`, gia hạn mỗi 5 s) cho khoảng `ceil(64 / số worker)` shard.
   - Khi worker chết, lease hết hạn và worker khác nhận shard.
   - Vì chỉ có một writer cho mỗi account nên nonce SoDEX tăng đều và không có lệnh trùng.
2. **Fencing token.** Mỗi lần nhận shard, `epoch` của shard trong Postgres tăng lên 1. Mọi yêu cầu ký và mọi lệnh đều mang theo `epoch`. Signer và DB từ chối `epoch` cũ, nên một worker "zombie" cũng không gửi lệnh được.
3. **Idempotency.**
   - Mỗi lệnh có `clientOrderId` tất định = hash(`botId`, `configVersion`, `level/cycle`, `attempt`).
   - Mọi thao tác API làm thay đổi trạng thái đều nhận header `Idempotency-Key`.
   - Gửi lại chỉ được phép sau khi đã đối soát (quy tắc 1.7).
4. **Outbox pattern.** Thay đổi trạng thái (bot, lệnh, cấu hình) được ghi kèm event vào bảng `outbox` trong cùng một transaction. Một relay đọc outbox rồi publish sang NATS. Không publish trực tiếp từ trong transaction.
5. **Work queue.**
   - `jobs.*` và `backtest.run` là JetStream work-queue stream, có consumer group.
   - Chỉ ack sau khi việc xong. Retry theo exponential backoff, tối đa 5 lần, rồi chuyển sang DLQ `*.dlq` và gửi cảnh báo.
6. **Rate limit SoDEX.** Dùng token bucket trong Redis theo account và theo IP egress. Số công khai:
   - REST: 1200 weight/phút trên mỗi IP.
   - Lệnh: 20 lệnh/giây và 600 lệnh/phút trên mỗi API key.
   - Theo địa chỉ ví: 1 request trên mỗi 1 USDC đã giao dịch luỹ kế, cộng sẵn 10.000 request ban đầu.
   - **WebSocket: tối đa 10 user khác nhau, 10 kết nối và 1000 subscription trên mỗi IP.**

   Hệ quả: mỗi engine worker chỉ giữ được user stream của khoảng 10 account trên một IP. Muốn scale thì phải gán shard theo **nhóm IP egress** (mỗi worker có IP egress riêng, hoặc đi qua proxy pool), và dùng REST polling làm phương án dự phòng. Cần hỏi SoDEX về hạn mức cho partner **[confirm]**.
7. **Market data.**
   - `marketdata` là nơi duy nhất mở WS thị trường. Engine và `reco` nghe qua NATS, không tự mở WS thị trường.
   - Candle 1 phút lưu vào hypertable `candles_1m` để phục vụ backtest và market stats.
8. **Bảo mật key.**
   - Private key của DRIFT API key được mã hoá envelope bằng Vault transit (dev) hoặc cloud KMS (prod).
   - Key chỉ được giải mã bên trong `signer`. Engine gửi `{accountId, payloadHash, epoch}` và nhận lại chữ ký.
   - `signer` nằm trong network `secure` (internal), chỉ `api` và `engine` gọi được. Kết nối dùng mTLS.
9. **Graceful shutdown.** Khi nhận SIGTERM, engine ngừng nhận việc mới, trả lease, chờ các request đang dở trong tối đa 25 s (`stop_grace_period: 30s`).
10. **Observability.**
    - OpenTelemetry trace xuyên suốt `api → engine → signer → SoDEX`.
    - Metrics Prometheus: độ trễ gửi lệnh, số lệnh `unknown`, chênh lệch đối soát builder, lease churn, độ sâu queue, độ trễ backtest.
    - Log JSON tập trung về Loki. Bật bằng `--profile observability`.

### 3.4 Các luồng chính

- **Start bot:**
  1. `api` validate bằng zod, ghi bot `starting` và event vào outbox.
  2. Engine sở hữu shard nhận event, ghi `epoch`, nhờ `signer` ký rồi gửi lệnh.
  3. Khi SoDEX ack lệnh đầu tiên thì bot chuyển `running` và publish `user.<id>.bot`.
  4. `realtime` đẩy cập nhật tới UI.
- **Fill:**
  1. WS user stream trả về fill. Engine cập nhật lệnh và bot.
  2. Ghi `builderFee`.
  3. Publish sự kiện để UI cập nhật.
- **Lệnh `unknown`:**
  1. Engine đánh dấu lệnh `unknown`.
  2. `jobs` đối soát với SoDEX (open orders + fills) và chuyển sang `filled` / `open` / `not_placed`.
  3. Chỉ sau bước này bot mới được đặt lại.
- **Revoke fee:**
  1. `api` ghi nhận chữ ký, `jobs` đọc lại approval từ SoDEX.
  2. Engine pause mọi bot của account với lý do `BUILDER_FEE_REVOKED`.
- **Backtest:**
  1. `api` tạo job, `backtest` worker xử lý.
  2. Kết quả lưu vào DB và cache theo `(strategy, market, paramsHash, period, dataVersion)`.
  3. UI theo dõi tiến trình qua `realtime`.

### 3.5 Môi trường và vận hành

| Môi trường | Cách chạy |
|---|---|
| dev | `docker compose --profile dev up` (Vault server mode lưu file trên volume, `vault-init` tự unseal, DEC-55), dùng SoDEX **mainnet** (DEC-23); test tự động chỉ đọc, luồng ký/gửi lệnh dùng mock server. Vault dev **không** dùng cho production |
| staging | compose, SoDEX mainnet (DEC-23), dữ liệu ẩn danh |
| production 1 host | compose, cloud KMS hoặc Vault cluster riêng (không bao giờ Vault dev / dev-init), backup Postgres (WAL + snapshot hằng ngày), NATS có volume |
| production lớn | cùng image trên Kubernetes; Postgres managed; NATS cluster 3 node; Redis Sentinel |

- Lệnh migrate: `docker compose run --rm migrate`. Chạy trước mỗi lần deploy; migration phải tương thích ngược (expand → migrate → contract).
- Scale ví dụ: `docker compose up -d --scale engine=6 --scale backtest=4 --scale api=3`.
- Mục tiêu năng lực ban đầu **[confirm]**: 5.000 account, 20.000 bot đang chạy, gửi lệnh p95 < 300 ms (tính từ quyết định đến khi SoDEX ack), backtest 90 ngày p95 < 20 s.

---

## 4. Stack và cấu trúc repo (đã chốt: DEC-17)

| Phần | Chọn | Lý do |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Dùng chung type giữa các service |
| Web | Next.js (App Router) + React + TypeScript `strict` | Routing, SSR |
| Styling | Tailwind CSS + CSS variables ở mục 13 | Token khớp 1:1 với thiết kế |
| UI primitives | Radix UI (qua shadcn/ui) | Dialog, tabs, switch, select có sẵn accessibility |
| Server state | TanStack Query | Cache, refetch, báo dữ liệu cũ |
| Form | react-hook-form + zod | Cùng một schema validate cả client và server |
| Ví / ký | wagmi + viem (`signTypedData`) | Chữ ký EIP-712 cho SoDEX |
| Chart | Recharts (hoặc lightweight-charts cho biểu đồ giá) | Chỉ dùng một thư viện |
| Backend | Node + TypeScript (Fastify) | Cùng ngôn ngữ với web |
| Số học tiền | `decimal.js` hoặc integer units | Không dùng float cho tiền |
| Queue / event | NATS JetStream | Nhẹ, có work-queue và replay |
| Dữ liệu | PostgreSQL + TimescaleDB, Redis | Bot, lệnh, audit, candles |
| Secret | Vault transit (dev) / cloud KMS (prod) | Mã hoá key của DRIFT |
| Test | Vitest + Testing Library, Playwright, MSW (chỉ trong test) | |

```
drift/
  apps/
    web/ api/ realtime/ engine/ signer/ marketdata/ scheduler/ jobs/ reco/ backtest/
  packages/
    shared/    zod schema, type, enum (bot state, reason code, strategy, order status), reco config
    sodex/     client REST/WS SoDEX, helper ký EIP-712, tính payload hash
    strategies/logic thuần của 8 chiến lược (dùng chung cho engine và backtest)
    ui/        design token + component dùng chung
  docker-compose.yml
  docs/
```

Quy tắc:
- **`packages/strategies` là logic thuần**: nhận `(config, marketEvent, state)` và trả về `(actions, newState)`. Không I/O. Engine (chạy thật) và backtest (mô phỏng) dùng chung code này, để backtest phản ánh đúng hành vi bot thật.
- Mọi enum đặt trong `packages/shared`, không hard-code chuỗi trong component.
- Mỗi chiến lược có một zod schema, dùng chung cho form tạo bot, API, engine và backtest.
- Không có mock data trong code production. Mock chỉ nằm trong test và Storybook.

Lệnh (điền sau khi init và cập nhật thường xuyên):

```
pnpm i
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
docker compose --profile dev up
```
