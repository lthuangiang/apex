# DRIFT — Quy định code

> Đọc trước khi viết dòng code đầu tiên, và đọc lại mục 12, 14 trước mỗi PR. Các lựa chọn công cụ có ghi **[confirm]** cần người dùng chốt khi init.

## C1. Nguyên tắc chung
- Đúng trước, nhanh sau. Hệ thống gửi lệnh bằng tiền thật: ưu tiên tính đúng, idempotent, quan sát được.
- Một nguồn sự thật cho mỗi thứ: enum và schema ở `packages/shared`, logic chiến lược ở `packages/strategies`, token ở `packages/ui`.
- Code dễ đọc hơn code thông minh. Hàm ngắn, tên rõ, không viết abstraction "để sau dùng".
- Không thêm tính năng ngoài tài liệu. Thấy thiếu thì hỏi, không tự bổ sung.

## C2. TypeScript
- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- Cấm `any` và `as` để ép kiểu dữ liệu từ ngoài. Dữ liệu từ API, SoDEX, form, env đều đi qua `zod.parse`. Type suy ra bằng `z.infer`.
- Enum viết dạng `as const` object kèm type union, đặt trong `packages/shared`:
  ```ts
  export const BotState = { draft: "draft", starting: "starting", running: "running" /* … */ } as const;
  export type BotState = (typeof BotState)[keyof typeof BotState];
  ```
- Không throw chuỗi. Lỗi nghiệp vụ dùng class `AppError(code, message, details?)` với `code` thuộc enum `ErrorCode`.
- Mọi `switch` trên union phải exhaustive (`assertNever`).

## C3. Đặt tên
| Thứ | Quy ước | Ví dụ |
|---|---|---|
| File, thư mục | kebab-case | `bot-status-pill.tsx`, `create-bot/` |
| React component | PascalCase | `BotStatusPill` |
| Hook | `useX` | `useBotQuery` |
| Hàm, biến | camelCase | `computeGridLevels` |
| Hằng số cấu hình | UPPER_SNAKE | `ENGINE_SHARDS` |
| Bảng, cột DB | snake_case, bảng số nhiều | `bot_versions.param_source` |
| JSON API | camelCase | `paramSource` |
| Mã lỗi | UPPER_SNAKE | `BUILDER_FEE_REVOKED` |
| NATS subject | chấm, chữ thường | `user.<accountId>.bot`, `md.btc-perp.kline.1m` |
| Biến môi trường | UPPER_SNAKE, có tiền tố app khi chỉ app đó dùng | `ENGINE_SHARD_LEASE_TTL_MS` |

## C4. Cấu trúc thư mục
```
apps/web/src/
  app/                      route (Next.js App Router), chỉ ghép layout + feature
  features/<feature>/       create-bot, trading-agent, onboarding, settings, …
    components/  hooks/  api/  schemas/  index.ts
  components/               component dùng chung chỉ trong web (ít; ưu tiên packages/ui)
  lib/                      format, i18n, query client
  messages/en.json          toàn bộ câu chữ UI
apps/api/src/
  modules/<domain>/         bots, accounts, builder-fee, backtests, …
    routes.ts  service.ts  repo.ts  schemas.ts
  plugins/  lib/
apps/engine/src/
  shards/  runner/  sodex/  reconcile/
packages/strategies/src/<strategy>/   index.ts (pure step fn)  schema.ts  __tests__/
```
- Feature không import thẳng nội bộ của feature khác; chỉ qua `index.ts` của feature đó hoặc qua `packages/*`.
- App không import app khác. Chiều phụ thuộc: `shared` ← `sodex` ← `strategies` ← apps; `ui` ← `web`.

## C5. Phân lớp backend
- `routes` (parse input, gọi service, trả output) → `service` (nghiệp vụ, transaction) → `repo` (SQL). Không viết SQL trong route, không gọi SoDEX trong repo.
- Thay đổi trạng thái + event ghi trong **cùng một transaction** (outbox, `docs/ARCHITECTURE.md` mục 3.3).
- Mọi lời gọi ra ngoài (SoDEX, Vault, email) có timeout (REST mặc định 5 s) và trace span.

## C6. Format lỗi API
```json
{ "error": { "code": "BOT_NOT_FOUND", "message": "Bot not found.", "details": {}, "traceId": "…" } }
```
| HTTP | Khi nào |
|---|---|
| 400 | input sai (kèm `details.fieldErrors` theo tên field) |
| 401 / 403 | chưa đăng nhập / không có quyền / thiếu 2FA (`TWO_FACTOR_REQUIRED`) |
| 404 | không tìm thấy |
| 409 | xung đột trạng thái (`BOT_STATE_CONFLICT`) hoặc trùng `Idempotency-Key` khác payload |
| 422 | đúng format nhưng vi phạm quy tắc (`ORDER_BELOW_MIN_SIZE`, `BUILDER_FEE_NOT_APPROVED`) |
| 429 | rate limit |
| 502 / 504 | SoDEX lỗi / timeout (`SODEX_UNAVAILABLE`, `SODEX_TIMEOUT`) |

UI không hiển thị `message` thô của server cho người dùng; UI map `code` sang câu chữ trong `messages/en.json`.

## C7. Quy ước REST
- Prefix `/api/v1`. Danh từ số nhiều: `/bots`, `/bots/:id/versions`, `/bots/:id/actions/pause`.
- Hành động trạng thái dùng `POST /bots/:id/actions/<action>`; trả `202 Accepted` kèm trạng thái chuyển tiếp, không trả trạng thái cuối.
- `Idempotency-Key` (UUID) **bắt buộc** với mọi `POST/PATCH/DELETE` thay đổi trạng thái; server lưu kết quả 24 h.
- Thời gian: ISO 8601 UTC (`2026-10-26T14:02:09Z`). Tiền, giá, khối lượng: **chuỗi số thập phân** (`"129948.11"`), không dùng number.
- Phân trang bằng cursor: `?cursor=…&limit=50` → `{ items, nextCursor }`.
- Schema request/response định nghĩa bằng zod trong `packages/shared`, sinh OpenAPI từ đó.

## C8. Database
- ORM / migration: **Drizzle ORM + drizzle-kit** (DEC-17). Mỗi thay đổi schema là một migration có tên rõ.
- Khoá chính `uuid` v7. Mọi bảng có `created_at`, `updated_at` (`timestamptz`).
- Tiền, giá, khối lượng: `numeric(38,18)`. Tỷ lệ phí: `integer` theo đơn vị của SoDEX (phần mười bp). Không dùng `float`/`double`.
- Mọi foreign key có index. Truy vấn danh sách có index phù hợp với sort/filter.
- Migration tương thích ngược theo kiểu expand → migrate → contract. Không đổi tên hay xoá cột trong cùng một lần deploy với code mới.
- Không xoá cứng dữ liệu tài chính (lệnh, fill, version, audit). Chỉ bot `draft` được xoá.
- Schema chi tiết: `docs/DOMAIN.md` mục 7.5.

## C9. Số học tiền
- Dùng `decimal.js` (cấu hình precision 40) hoặc integer unit. Viết helper trong `packages/shared/money`.
- Làm tròn chỉ ở hai chỗ: theo `tick`/`lot` khi tạo lệnh, và khi format hiển thị.
- Không so sánh bằng `===` giữa hai số thập phân; dùng helper `eq`, `gt`, `lt`.

## C10. Đồng thời và độ tin cậy
- Chỉ engine sở hữu shard mới được gửi lệnh cho account đó; luôn kiểm tra lease + `epoch` trước khi ký.
- Không retry lệnh ghi (đặt/huỷ/thay lệnh). Chỉ retry thao tác đọc idempotent, theo exponential backoff có jitter, tối đa 3 lần.
- Consumer NATS phải idempotent: xử lý trùng message không gây tác dụng phụ lần hai (dùng id message / unique constraint).
- Mọi worker xử lý SIGTERM: ngừng nhận việc, hoàn tất hoặc trả việc đang dở, trả lease.

## C11. Log, metric, trace
- Logger `pino`, JSON. Trường bắt buộc: `level, time, service, traceId, spanId`, khi có thì `accountId, botId, orderId, clOrdID`.
- Danh sách redact cố định: `privateKey, secret, signature, apiKey, authorization, cookie, seed, mnemonic`. Có test đảm bảo redact.
- Metric Prometheus đặt tên `drift_<service>_<thing>_<unit>`, ví dụ `drift_engine_order_submit_seconds`, `drift_engine_orders_unknown_total`.
- OpenTelemetry trace xuyên `web → api → engine → signer → SoDEX`.

## C12. Bảo mật
- Secret lấy từ env hoặc Vault, không commit `.env` (chỉ commit `.env.example` không có giá trị thật).
- Phiên đăng nhập bằng cookie `httpOnly`, `Secure`, `SameSite=Lax`; có chống CSRF cho request thay đổi trạng thái.
- 2FA được kiểm tra ở **server** cho: start bot, stop bot, revoke fee, disconnect, xoá tài khoản.
- Rate limit API theo user và theo IP. CSP chặt, không `unsafe-inline` cho script.
- Kiểm tra quyền sở hữu ở mọi endpoint: người dùng chỉ thấy và thao tác bot, account của chính mình. Trang Builder Revenue chỉ cho role `team`.

## C13. Frontend
- Mặc định Server Component; chỉ dùng Client Component khi cần tương tác.
- TanStack Query: query key dạng mảng `["bots", botId]`, `["bots", botId, "orders", filters]`. Mutation xong thì invalidate đúng key, **không** tự sửa cache sang trạng thái cuối (quy tắc 1.6).
- Form: react-hook-form + zodResolver, schema lấy từ `packages/strategies/<strategy>/schema.ts`.
- Không dùng global store cho dữ liệu server. Zustand chỉ cho trạng thái UI thuần (sidebar, dialog).
- i18n: `next-intl`, key dạng `screen.section.item` (ví dụ `createBot.beforeStart.startButton`). Chỉ có `en.json` trong v1.
- Format số và thời gian qua helper trong `lib/format`, dựa trên Settings của người dùng.
- Accessibility theo `docs/DESIGN.md`. Chạy `axe` trong test component.

## C14. Test
| Loại | Công cụ | Nằm ở | Bắt buộc cho |
|---|---|---|---|
| Unit | Vitest | `__tests__/` cạnh code | tính toán, state machine, reco engine, ký EIP-712, format tiền |
| Component | Vitest + Testing Library + axe | `features/*/__tests__` | mọi component có trạng thái loading/empty/error/stale |
| Integration | Vitest + Testcontainers (Postgres, Redis, NATS) | `apps/*/test/` | route API, repo, consumer |
| Contract | Vitest | `packages/sodex/__tests__` | payload hash và chữ ký khớp với ví dụ trong tài liệu SoDEX |
| E2E | Playwright chạy trên `docker compose --profile dev` + **SoDEX mock server** | `e2e/` | các luồng ở mục 14 |

- Unit test không gọi mạng. Mock SoDEX chỉ nằm trong `e2e/` và `test/`, không bao giờ trong code production.
- Test đặt tên theo hành vi: `it("pauses all bots when builder fee approval becomes 0")`.
- Fixture tài chính viết bằng chuỗi thập phân, không dùng number.

## C15. Git và PR
- Nhánh: `feat/<scope>-<mô-tả>`, `fix/…`, `chore/…`. Không push thẳng lên `main`.
- Commit theo **Conventional Commits** bằng tiếng Anh: `feat(engine): add shard lease renewal`.
- Mỗi PR một mục đích, càng nhỏ càng tốt (ưu tiên < 400 dòng thay đổi không tính file sinh tự động).
- Mô tả PR gồm: làm gì, vì sao, cách test, ảnh chụp (nếu có UI), checklist mục 14.
- CI chạy theo thứ tự: install → lint → typecheck → unit → integration → build → e2e (trên nhánh `main` và PR có nhãn `e2e`).

## C16. Lint và format
- ESLint với `typescript-eslint` (strict + stylistic), `eslint-plugin-import` (sắp xếp import, cấm import vòng), `eslint-plugin-jsx-a11y`.
- Prettier: `printWidth 100`, `singleQuote false`, `trailingComma all`.
- `lint-staged` + `husky` chạy lint và format cho file đã stage. Tạm bỏ cho tới khi repo dùng git (DEC-18).
- Không tắt rule bằng comment khi không có lý do; nếu bắt buộc thì ghi lý do ngay trên dòng đó.

---

## 12. Bẫy cần tránh (đọc lại trước mỗi feature)

**Logic**
- Không đổi trạng thái bot hay lệnh sang trạng thái cuối theo kiểu "lạc quan". Giữ trạng thái chuyển tiếp cho tới khi có event từ backend. Timeout thì là `unknown`, không phải `failed`.
- Mọi thao tác tài chính phải chống double submit: disable nút + `Idempotency-Key` cho mỗi request.
- Không gửi lại lệnh sau timeout. Phải đối soát trước.
- Không tính builder revenue bằng volume × rate. Không cộng `builderFee` vào `fee`.
- Spot không thu builder fee ở chiều mua, nên Recurring Buy không có builder fee.
- Phần trăm và phí: lưu dạng số thập phân thô hoặc integer unit (ví dụ `maxFeeRate` là phần mười bp). Chỉ format ở tầng hiển thị. Không bao giờ lưu chuỗi đã format.
- Dùng số học thập phân cho giá, khối lượng, PnL. Không cộng tiền bằng float.
- Grid: tính giá từng level theo spacing, làm tròn theo tick, rồi kiểm tra từng lệnh vẫn ≥ min size *sau khi làm tròn*.
- Múi giờ: reset daily loss, lịch Recurring Buy và báo cáo đều dùng múi giờ của người dùng (tên IANA).
- Revoke fee hoặc mất key thì pause **mọi** bot của account. Xử lý ở engine, không chỉ ở UI.
- Không hard-code giới hạn của SoDEX. Lấy từ market info và cache có hạn.
- Không mở WS thị trường ở engine. Chỉ `marketdata` mở và publish qua NATS.
- Không để một account có hai writer. Luôn kiểm tra lease và `epoch` trước khi ký và gửi lệnh.
- Logic chiến lược chỉ nằm ở `packages/strategies`. Không viết lại ở backtest hay ở web.

**UI**
- Mọi vùng bất đồng bộ cần đủ 4 trạng thái: loading, empty, error, stale.
- Số dài không được tràn ở màn hình 390px. Dùng định dạng rút gọn khi thiết kế dùng, và cho tile được xuống dòng.
- Định nghĩa field của chiến lược chỉ có một nguồn. Form tạo, form sửa, phần tóm tắt và spec đều render từ nguồn đó.
- Control bị disable ("Paper · Coming soon", field bị khoá) phải có lý do hiển thị, không chỉ làm mờ.
- Badge LIVE là nền đỏ đặc; lỗi dùng nền đỏ nhạt. Đừng để mọi màn nhìn như đang báo lỗi.
- Focus phải luôn nhìn thấy được. Test bằng bàn phím.

---

## 14. Definition of done (mỗi PR)

- Khớp artboard ở desktop (1440) và mobile (390), không có thanh cuộn ngang toàn trang.
- Có đủ loading, empty, error, stale và có test.
- Payload mới có zod schema dùng chung cho web, API, engine.
- Unit test cho phần tính toán (giá level của grid, thang DCA, lãi ròng, đơn vị phí, công thức của engine đề xuất) và cho chuyển trạng thái.
- Playwright e2e cho các luồng:
  - kết nối ở onboarding (ký → đọc lại);
  - tạo bot với AI parameters → Clear parameters → nhập tay → Backtest → Start;
  - pause / resume;
  - revoke fee → mọi bot bị pause;
  - lệnh unknown → đối soát.
- `pnpm lint && pnpm typecheck && pnpm test` đều pass. Báo kết quả trung thực; cái gì không chạy được thì nói rõ lý do.
- `docker compose up` chạy được toàn hệ thống với cấu hình dev.
- Không có secret, không có mock data trong code production, không có TODO nào làm thay đổi hành vi nghiệp vụ.
