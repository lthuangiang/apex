# DRIFT — Hướng dẫn cho Claude Code

DRIFT là nền tảng **Profit Bot** cho trader trên **SoDEX**. Người dùng kết nối tài khoản SoDEX bằng **hai chữ ký ví** (DEC-25). DRIFT phân tích lịch sử giao dịch của họ, đề xuất chiến lược phù hợp, rồi chạy bot giao dịch thay họ trên **SoDEX mainnet**. DRIFT có doanh thu từ **builder fee** trên các lệnh nó gửi.

File này là **cửa vào**: quy tắc cốt lõi, thuật ngữ, link thiết kế, mục lục tài liệu và cách làm việc. Chi tiết nằm trong `docs/`.

- Nếu tài liệu mâu thuẫn với giả định của bạn, **tài liệu thắng**.
- Nếu một điểm chưa được nói tới, hoặc bị đánh dấu **[confirm]**, thì **dừng lại và hỏi**. Không tự bịa quy tắc nghiệp vụ, field API, công thức phí hay logic rủi ro.
- Nếu hai file trong `docs/` mâu thuẫn nhau, file có ngày mới hơn trong `docs/DECISIONS.md` thắng. Vẫn còn nghi ngờ thì hỏi.

**Quy ước ngôn ngữ:** phần giải thích viết bằng tiếng Việt. Tên field, API, enum, mã lỗi, tên biến, code, commit message và **mọi câu chữ hiển thị trong app** giữ nguyên **tiếng Anh**, chép đúng như thiết kế. Không tự dịch câu chữ UI.

---

## Thiết kế

- **Canvas thiết kế:** https://claude.ai/artifact/CqbALjUJ4r7gcGk8XUua6v (tên: "DRIFT Redesign").
- Canvas là **private**. Chủ sở hữu phải chia sẻ qua menu Share thì người khác mới mở được. Claude Code **đọc được** canvas bằng công cụ Artifact (`action: "read"`, `scope: "files"` để liệt kê; mỗi artboard là `project/<Tên>.dc.html`). Khi code UI, đọc đúng artboard đó để chép câu chữ và bố cục. Nếu artboard mâu thuẫn với `docs/DECISIONS.md` thì quyết định thắng, và phải hỏi khi chưa rõ (DEC-31). Phần tóm tắt đã chép vào repo:
  - `docs/DESIGN.md`: cách dùng canvas, design token, component, accessibility, responsive.
  - `docs/SCREENS.md`: route ↔ artboard, quy tắc từng màn hình.
  - `docs/STRATEGIES.md`: field spec đầy đủ của từng chiến lược.
- Thiếu chi tiết giao diện (khoảng cách, thứ tự phần tử, câu chữ) thì **hỏi người dùng** gửi ảnh chụp hoặc bản export của artboard đó (Share › Export). Không đoán.

---

## Mục lục tài liệu

Số mục được giữ ổn định, nên khi tài liệu ghi "mục X" thì tra cột thứ hai.

| File | Mục | Đọc khi |
|---|---|---|
| `CLAUDE.md` | 1, 2, 16 | luôn luôn |
| `docs/CODING_STANDARDS.md` | 12, 14 + quy định code | trước khi viết dòng code đầu tiên; trước mỗi PR |
| `docs/DESIGN.md` | 13 + cách dùng canvas | làm bất kỳ UI nào |
| `docs/ARCHITECTURE.md` | 3, 4 | dựng repo, service, docker compose, queue, scale |
| `docs/SODEX.md` | 5 | ký, gửi lệnh, phí, builder revenue |
| `docs/DOMAIN.md` | 6, 7 + schema DB | model, state machine, migration |
| `docs/STRATEGIES.md` | field spec | form tạo/sửa bot, zod schema, engine |
| `docs/SCREENS.md` | 8, 9 | mọi màn hình |
| `docs/RECO_ENGINE.md` | 10 | onboarding bước 6, AI parameters |
| `docs/BACKTEST.md` | 11 | tab Backtest, service backtest |
| `docs/VOLUME_MAKER.md` | 17 | bot Volume Maker (đang khoá bằng feature flag) |
| `docs/ROADMAP.md` | thứ tự build | lên kế hoạch, chọn việc tiếp theo |
| `docs/DECISIONS.md` | nhật ký quyết định | khi thấy mâu thuẫn hoặc định đổi một quyết định |
| `docs/OPEN_QUESTIONS.md` | 15 | trước khi code phần có **[confirm]** |
| `docs/DEPLOY.md` | deploy | đưa lên VPS production, backup, rollback (DEC-70) |
| `docker-compose.yml` | — | chạy toàn hệ thống |

---

## 1. Quy tắc sản phẩm (không được vi phạm)

1. **Chỉ giao dịch.** DRIFT không bao giờ rút hay chuyển tiền của người dùng. Không có UI, endpoint hay code path nào cho việc đó. UI ghi rõ: "Withdraw or transfer: never".
2. **Chỉ LIVE (v1).** Mọi bot chạy trên SoDEX **mainnet** bằng tiền thật. Paper trading **không xây**: chỉ hiện dạng chip/thẻ disabled "Paper · Coming soon". Không tạo `mode` switch, paper engine hay luồng dữ liệu paper.
3. **Hai chữ ký để kết nối (DEC-25).** **Master wallet** SoDEX của người dùng ký (1) `UserSignedAddPermissionedAPIKeyAction` để tạo API key cho DRIFT với quyền WITHDRAW và TRANSFER bị tắt, rồi (2) `ApproveBuilderFeeAction` để approve builder fee. Key của DRIFT không có quyền rút hay chuyển tiền ở phía SoDEX. Không dùng `AddAPIKeyWithBuilder`, vì key tạo bằng action này có mọi quyền. Người dùng không bao giờ phải dán key hay secret.
4. **Builder fee cố định 0.01% (`maxFeeRate = 10`, DEC-46).** Người dùng chỉ có thể approve hoặc revoke (đặt về 0). Không có mức phí tuỳ chỉnh. Approval ≥ 10 được tính là đủ (SoDEX thu mức thấp hơn). Account của chính builder không thu phí, không cần approve (DEC-47).
5. **Revoke builder fee thì tạm dừng toàn bộ bot của người dùng đó** (`BUILDER_FEE_REVOKED`). Lệnh đang mở được giữ nguyên. Bot chỉ chạy lại khi người dùng approve lại **và** tự resume từng bot.
6. **Trạng thái lấy từ backend, không lấy từ việc bấm nút.** Mọi thao tác đều có trạng thái chuyển tiếp (`Starting…`, `Pausing…`, `Stopping…`, `Applying v4…`), giữ nguyên cho tới khi backend xác nhận.
7. **Không retry mù các thao tác tài chính.** Lệnh có kết quả không rõ (timeout, lỗi mạng) được đánh dấu `unknown`, và phải đối soát với SoDEX trước khi gửi lại bất cứ thứ gì.
8. **Không bịa số.** Không hiển thị giá trị mà backend không trả về, hoặc không tính được từ dữ liệu có thật bằng một công thức đã ghi rõ. Không dự báo lợi nhuận. Thiếu dữ liệu thì hiện "Not provided" / "Not available" hoặc empty state, **không bao giờ hiện `0`**.
9. **Không để lộ secret.** Private key, seed phrase, API key hay secret đầy đủ không được xuất hiện trong UI, log, thông báo lỗi, analytics hay test. Key chỉ hiện 4 ký tự cuối, dạng `••4f2a`.
10. **DRIFT không bao giờ hỏi seed phrase hay private key.**

---

## 2. Thuật ngữ

| Thuật ngữ | Nghĩa trong DRIFT |
|---|---|
| **Bot** | Một cấu hình chiến lược (strategy + market + tham số + giới hạn rủi ro) chạy liên tục trên SoDEX. Mỗi bot có nhiều version cấu hình. |
| **Trading Agent** | **Trang vận hành của một bot đang chạy** (`/agent/:botId`): xem trạng thái, quyết định, lệnh, lỗi; Pause / Resume / Stop; mở màn sửa. "Agent" và "bot" là **cùng một đối tượng**: Trading Agent là góc nhìn *vận hành*. |
| **Strategy Lab** | Nơi *quản lý cấu hình*: danh sách bot, danh mục chiến lược, **tạo** bot (`/bots/new/:strategy`) và **sửa** bot (`/bots/:botId/edit`). |
| **Builder fee** | Phí DRIFT thu trên mỗi lần khớp lệnh do DRIFT gửi, theo cơ chế Builder Codes của SoDEX. |
| **AI parameters** | Tham số do engine đề xuất (`docs/RECO_ENGINE.md`) tự điền vào form tạo/sửa bot. Đây là engine quy tắc tất định, không phải mô hình đoán mò. |
| **Backtest** | Chạy thử bộ tham số hiện tại trên giá quá khứ của SoDEX (`docs/BACKTEST.md`). Là mô phỏng, **không phải dự báo**. |
| **Reason code** | Mã lý do bot bị pause hoặc stop (`docs/DOMAIN.md` mục 7.2). |

---

## Quy định code (tóm tắt; bản đầy đủ ở `docs/CODING_STANDARDS.md`)

1. TypeScript `strict` ở mọi package. Không dùng `any`; dữ liệu từ ngoài vào (API, SoDEX, form) luôn được parse bằng zod.
2. Enum, schema, type chung nằm trong `packages/shared`. Logic chiến lược chỉ nằm trong `packages/strategies` (thuần, không I/O).
3. Tiền, giá, khối lượng dùng số thập phân (`decimal.js`) hoặc integer unit. Không cộng tiền bằng float.
4. Mọi thao tác thay đổi trạng thái có `Idempotency-Key`. Mọi lệnh có `clOrdID` tất định.
5. Lỗi trả về theo một format chung (`docs/CODING_STANDARDS.md` mục C6). Không nuốt lỗi.
6. Log JSON có `traceId`, không bao giờ log secret hay payload đã ký.
7. Câu chữ UI nằm trong file i18n (tiếng Anh), không viết thẳng trong component.
8. Component chỉ dùng design token, không viết mã hex trực tiếp.
9. Mỗi feature có test. Phần tính toán và state machine bắt buộc có unit test.
10. Conventional Commits; mỗi PR nhỏ, một mục đích, đạt Definition of done (mục 14).

---

## Lệnh

Điền sau khi init và cập nhật thường xuyên:

```
npm i -g corepack@latest && corepack enable   # một lần; pnpm được pin trong package.json
cp .env.example .env                           # rồi điền mật khẩu dev
pnpm i
pnpm dev
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm --filter @drift/ui storybook       # Storybook ở cổng 6006
pnpm --filter @drift/ui test:a11y       # axe trên mọi story, 1440 + 390
pnpm --filter @drift/sodex test:smoke   # chỉ đọc trên mainnet; SODEX_SMOKE_ADDRESS để đọc account
REDIS_URL=redis://127.0.0.1:16379 pnpm --filter @drift/sodex test   # thêm test tích hợp Redis (cần forward cổng redis của compose)
pnpm e2e                                # cần Docker + openssl; dựng Postgres/Vault/Mailpit/Redis bằng Testcontainers, SoDEX là mock
scripts/dev-up.sh                       # build lại + chạy toàn bộ local (cert, hạ tầng, migration, app); thêm tên service để chỉ build lại service đó
infra/certs/gen-dev-certs.sh infra/certs/dev   # một lần: cert mTLS dev cho api/engine ↔ signer (DEC-42; dev-up.sh tự gọi)
docker compose --profile dev up         # hạ tầng; app service ở profile `app`
docker compose run --rm migrate
```

---

## 16. Cách làm việc trong repo

- Làm theo thứ tự trong `docs/ROADMAP.md`. Mỗi lần chỉ làm một phase; đạt tiêu chí "xong" của phase đó rồi mới sang phase tiếp theo.
- Bắt đầu mỗi feature bằng cách đọc lại file liên quan trong `docs/` (xem bảng mục lục). Nếu tài liệu lệch với thiết kế hoặc lệch nhau, hỏi.
- Khi một mục **[confirm]** có câu trả lời: sửa tài liệu liên quan, ghi quyết định kèm ngày vào `docs/DECISIONS.md`, và xoá câu hỏi khỏi `docs/OPEN_QUESTIONS.md`.
- Không tự đổi một quyết định đã ghi trong `docs/DECISIONS.md`. Muốn đổi thì đề xuất và chờ người dùng đồng ý.
- Hỏi trước khi thêm dependency không có trong `docs/ARCHITECTURE.md` mục 4.
- Báo kết quả trung thực: test nào fail thì nói fail kèm output; bước nào bỏ qua thì nói rõ.
