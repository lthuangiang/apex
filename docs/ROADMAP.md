# DRIFT — Thứ tự build (A → Z)

> Làm lần lượt từng phase. Chỉ chuyển sang phase sau khi đạt hết các tiêu chí "Xong khi" của phase hiện tại **và** Definition of done (mục 14). Phase nào phụ thuộc một câu hỏi trong `docs/OPEN_QUESTIONS.md` thì hỏi trước khi bắt đầu phase đó.

| Phase | Làm gì | Xong khi |
|---|---|---|
| **P0 · Khởi tạo repo** | Monorepo pnpm + Turborepo; tsconfig strict; ESLint, Prettier, husky; CI; `docker-compose.yml` với postgres, pgbouncer, redis, nats, vault (profile dev); `.env.example` | `pnpm lint && pnpm typecheck && pnpm test` pass; `docker compose --profile dev up` mọi service healthy |
| **P1 · Nền tảng chung** | `packages/shared`: enum, error code, zod schema dùng chung, helper tiền (`decimal.js`), format; `packages/ui`: token + component ở mục 13 (có Storybook); `messages/en.json` | Unit test cho helper tiền; mọi component có story đủ 4 trạng thái; kiểm tra axe không lỗi |
| **P2 · SoDEX client** | `packages/sodex`: REST/WS, ký EIP-712, payload hash, field `builder`, cache market info, token bucket theo key/IP/địa chỉ | Contract test khớp ví dụ trong tài liệu SoDEX; smoke test **chỉ đọc** trên mainnet đọc được account và market info (DEC-23) |
| **P3 · Tài khoản và kết nối** | Đăng ký bằng email + OTP (DEC-28), 2FA, phiên; `signer` + Vault; onboarding bước 1–2 (key có giới hạn quyền + `ApproveBuilderFeeAction`, DEC-25; đọc lại key và approval); Settings › SoDEX access + Security | E2E với SoDEX mock server: đăng ký → kết nối → thấy key ••last4 và approval 0.05%; revoke rồi approve lại được. Kết nối thật trên mainnet do người dùng chạy tay (DEC-23) |
| **P4 · Dữ liệu** | `marketdata` (WS → NATS, `candles_1m`); `scheduler` tính `market_stats_daily`; `jobs` import lịch sử + account analysis; onboarding bước 3–4 | Import một account mainnet (chỉ đọc) xong có `coverage`; analysis khớp tính tay trên fixture |
| **P5 · Logic chiến lược** | `packages/strategies`: hàm `step` thuần cho 8 chiến lược + exchange giả lập | Mỗi chiến lược có unit test cho start, fill, stop, take profit, max loss, lỗi lệnh |
| **P6 · Engine** | Shard lease + `epoch`, user stream, vòng đời lệnh, đối soát `unknown`, reason code, pause khi revoke phí / key hết hạn, outbox → NATS, `realtime` | Integration test: kill một worker → shard chuyển chủ không trùng lệnh; revoke phí → mọi bot pause; timeout → `unknown` → đối soát |
| **P7 · Giao diện bot** | Strategy Lab, Create (Preview, field, checks, Start), Trading Agent, Edit bot, Orders; desktop + mobile | E2E: tạo bot → start → thấy Running khi SoDEX ack → pause/resume → sửa v2 → stop |
| **P8 · Đề xuất và AI parameters** | Service `reco`; onboarding bước 5–6; nút AI parameters / Clear parameters; Retune with AI | Golden test của engine đề xuất pass; E2E AI parameters → Clear → nhập tay |
| **P9 · Backtest** | Service `backtest` dùng `packages/strategies`; tab Backtest | Cùng fixture candle, backtest và engine ra cùng chuỗi hành động; 90 ngày p95 < 20 s |
| **P10 · Các màn còn lại** | Overview, Portfolio, Risk Center, AI Analyst, notifications, Builder Revenue (role `team`) | Mỗi màn đủ 4 trạng thái; số liệu khớp API; Builder Revenue đối soát đúng trên fixture |
| **P11 · Hoàn thiện** | Rà soát mobile, accessibility, hiệu năng; mTLS api↔signer và test component/a11y cho màn P3 (DEC-33); observability (profile); load test theo mục tiêu ở mục 3.5; rà soát bảo mật | Đạt mục tiêu năng lực đã chốt; không còn lỗi a11y nghiêm trọng; checklist bảo mật C12 đạt |
| **P12 · Volume Maker** | Chỉ bắt đầu khi `docs/VOLUME_MAKER.md` mục 17.5 có xác nhận của SoDEX | Self-trade guard có test; trần chi phí dừng đúng; flag `VOLUME_MAKER_ENABLED` bật được |
