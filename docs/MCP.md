# DeskLabs — MCP (kế hoạch, 2026-11-11)

> Trạng thái: **đã duyệt (DEC-167, 2026-11-11)**, chưa code. Các điểm từng ghi **[confirm]** đã chốt ở DEC-167 (mục 11).
> Liên quan: `docs/AI_DESK.md` (DEC-164/165/166), `docs/DECISIONS.md` DEC-161/162/163 (Copy Trading), `CLAUDE.md` mục 1.

MCP (Model Context Protocol) cho phép một ứng dụng AI như Claude gọi "tool" của hệ thống khác. Kế hoạch gồm hai MCP:

| | **A. MCP nội bộ** | **B. DeskLabs MCP cho người dùng** |
|---|---|---|
| Ai dùng | Team (support, dev, Claude Code của team) | Người dùng DeskLabs, nối từ claude.ai / Claude Desktop / Claude Code của chính họ |
| Làm gì | Tra cứu nhanh: user kẹt kết nối, trạng thái bot, lệnh `unknown`, builder revenue | Hỏi về tài khoản, bot, AI Desk, Copy Trading; tạo **bản nháp** thay đổi để duyệt trong app |
| Quyền | Chỉ đọc | Đọc + tạo bản nháp. **Không** thực thi |
| Chi phí AI | Gói Claude của team | Gói Claude của người dùng: DeskLabs không trả token |
| Làm trước | ✓ (nhanh, có ích ngay) | Sau A; phần AI Desk chờ backend B+ |

---

## 1. Mục tiêu và không làm

**Mục tiêu**
1. A: support xử lý một ca "kẹt Connect SoDEX" hay "bot dừng không rõ lý do" trong vài phút, không phải mở DB tay.
2. B: người dùng hỏi Claude về bot DeskLabs bằng lời thường, nhận câu trả lời có số thật; bù cho trần 20 câu/ngày của Desk AI (DEC-165).
3. B: thêm kênh tiếp cận người dùng ("Connect DeskLabs to Claude").

**Không làm (v1)**
- Không có tool đặt lệnh, start / stop / resume / pause bot, đổi cấu hình trực tiếp, đổi builder fee, đổi Settings.
- Không có tool nào liên quan rút hay chuyển tiền (quy tắc 1.1). Không có code path cho việc đó.
- Không trả private key, seed, API key hay secret đầy đủ (quy tắc 1.9).
- Không công khai MCP dữ liệu thị trường (ưu tiên thấp; lưu ý tên SoDEX, DEC-153).

---

## 2. Nguyên tắc không đổi

1. **Tool chỉ đọc hoặc tạo bản nháp.** Mọi thay đổi thật đi qua màn hình DeskLabs, trạng thái lấy từ backend (quy tắc 1.6), có `Idempotency-Key` như hiện nay.
2. **MCP không chạm signer, engine hay SoDEX.** MCP gọi `api` (hoặc đọc replica DB đối với A); `api` kiểm tra quyền như mọi request khác.
3. **Không bịa số (quy tắc 1.8).** Thiếu dữ liệu trả `null` kèm `reason: "not_available"`, không bao giờ trả `0` thay cho "không có". Mỗi kết quả có `asOf` và `source`.
4. **Dữ liệu trả về là dữ liệu.** Trường do người dùng nhập (tên bot, ghi chú, nhãn ví) được đánh dấu `userText` để client AI không coi là chỉ thị. Vì không có tool thực thi, prompt injection không dẫn tới giao dịch.
5. **Mọi lần gọi tool đều ghi nhật ký** (mục 6), không ghi secret hay payload đã ký.
6. Câu chữ hiển thị (consent, Settings) bằng tiếng Anh trong i18n; tên tool, field bằng tiếng Anh.

---

## 3. Kiến trúc

```
Claude (của user / team)
   │  MCP, Streamable HTTP, OAuth bearer token
   ▼
apps/mcp  (mới, stateless, tăng replica)          Traefik: mcp.desklabs.xyz  (DEC-167)
   │  HTTP nội bộ, chuyển tiếp token đã kiểm tra scope
   ▼
apps/api  (đã có: auth, bots, desk, account …)  ──►  postgres / redis
```

- **Service mới `apps/mcp`.** Không đặt trong `apps/api` để tách quyền và rate limit; không import app khác (quy tắc của DEC-35). Logic chung (schema output của tool) đặt trong `packages/shared`.
- **Transport:** Streamable HTTP theo đặc tả MCP hiện hành. Không dùng stdio cho bản production (stdio chỉ để dev local).
- **A (nội bộ)** dùng chung service `apps/mcp` nhưng endpoint riêng (`/team/mcp`), chỉ nhận token OAuth scope `team:read` (chỉ cấp cho role `team`, DEC-167). Tool A có thể đọc **read replica** khi có; trước khi có replica thì gọi endpoint `api` dành cho role `team` (DEC-64).
- **Dependency:** SDK MCP chính thức cho TypeScript (`@modelcontextprotocol/sdk`), đã duyệt ở DEC-167 và thêm vào ARCHITECTURE mục 4.

---

## 4. Đăng nhập và quyền

### B · người dùng
- **OAuth 2.1** theo phần authorization của đặc tả MCP: authorization code + PKCE, metadata server, đăng ký client động. Authorization server nằm trong `apps/api` (dùng lại session hiện có).
- **Màn consent** trong web: tên client (ví dụ "Claude"), danh sách scope bằng lời thường, nút Allow / Deny. Đăng nhập theo luồng hiện có; 2FA theo DEC-115 (không bắt buộc).
- **Scope:**
  - `read`: tài khoản, bot, quyết định, AI Desk, Copy Trading.
  - `draft`: tạo bản nháp thay đổi / bot mới. User có thể chỉ cấp `read`.
- **Xin `draft` khi cần (step-up, DEC-223):** lần kết nối đầu chỉ xin `read` (401 trả `scope="read"`). Token `read` vẫn thấy `draft_new_bot` / `draft_bot_change`; khi client gọi một trong hai tool (kể cả trong batch JSON-RPC), apps/mcp trả HTTP 403 `insufficient_scope`, `scope="read draft"`, trước khi chạy tool, và ghi `mcp_calls` trạng thái `denied`. api cho refresh token của family cũ hết hạn ngay (access token vẫn dùng tới khi hết 1 giờ), để client chạy lại OAuth với màn consent hiện cả hai quyền thay vì refresh ra token cũ. Allow cấp một family token mới có `read` + `draft`; Connected apps vẫn gộp theo client.
- **Token:** access token ngắn hạn (1 giờ), refresh token 30 ngày; chỉ lưu hash. Thu hồi ở **Settings › Connected apps** (danh sách client, lần dùng cuối, nút Revoke).
- **Cổng truy cập:** mọi user đã kết nối SoDEX (DEC-167). Vẫn hỏi luật sư trước khi đăng ký danh mục connector công khai.

### A · nội bộ
- Chỉ user role `team`, dùng **chung luồng OAuth** với B (DEC-167): scope `team:read` chỉ hiện trên màn consent khi user có role `team`; `api` kiểm tra lại role ở mọi request.

---

## 5. Danh mục tool

Quy ước chung: input parse bằng zod; tiền, giá, khối lượng là chuỗi thập phân kèm đơn vị; thời gian ISO 8601 UTC; phân trang `cursor` + `limit` (tối đa 50); mỗi kết quả có `asOf`, `source`. Mô tả tool viết ngắn, nói rõ "read-only" hoặc "creates a draft only".

### A · MCP nội bộ (v1)

| Tool | Input | Trả về | Nguồn |
|---|---|---|---|
| `team_find_user` | email hoặc user id hoặc 4 ký tự cuối ví | user id, role, cờ (AI Desk, Volume), trạng thái kết nối SoDEX | `users`, kết nối |
| `team_connect_attempts` | user id hoặc `attemptId`, khoảng thời gian | các bước `connect_events` (view → connected), lỗi, thiết bị | DEC-114 |
| `team_user_bots` | user id | bot, trạng thái, reason code, version, lần lỗi gần nhất | `bots`, `bot_versions` |
| `team_bot_timeline` | bot id, khoảng thời gian | quyết định, lệnh, lỗi theo thời gian | decisions, orders |
| `team_unknown_orders` | tuỳ chọn user id | lệnh `unknown` chưa đối soát, tuổi, trạng thái đối soát | jobs đối soát |
| `team_builder_revenue` | khoảng ngày | `builder_revenue_daily`, chênh lệch, trạng thái | DEC-64 |
| `team_reason_code` | mã | ý nghĩa, cách xử lý (từ DOMAIN 7.2) | tài liệu |

Email trả nguyên vẹn chỉ cho team; không bao giờ trả secret, key, chữ ký. Tool tra log theo `traceId` để sau, khi có kho log tập trung.

### B · DeskLabs MCP (theo giai đoạn ở mục 7)

| Nhóm | Tool | Scope | Trả về |
|---|---|---|---|
| Tài khoản | `get_portfolio_summary` | read | equity, tách tiền thật / paper (paper không cộng vào tiền thật, quy tắc 1.2), lãi lỗ theo kỳ |
| | `get_risk_status` | read | lỗ đã dùng / lỗ cho phép, daily loss, cảnh báo |
| Bot | `list_bots` | read | id, tên (`userText`), chiến lược, market, trạng thái, mode |
| | `get_bot` | read | cấu hình version hiện tại, lãi lỗ, volume, phí |
| | `get_bot_decisions` | read | quyết định gần đây, reason code, lệnh |
| | `explain_reason_code` | read | giải thích bằng lời thường |
| Copy Trading | `find_traders` | read | danh sách theo tab (Steady…), số đã ẩn và lý do (DEC-163) |
| | `get_trader` | read | thống kê episode, checklist good fit, thay đổi vị thế |
| AI Desk (sau B+) | `list_needs_you` | read | tối đa 3 việc, mức độ, nguồn |
| | `get_whatif` | read | các phương án, kết quả 7 ngày, "not a forecast" |
| | `get_track_record` | read | Helped / Made it worse / Still measuring |
| Bản nháp | `draft_bot_change` | draft | tạo bản nháp thay đổi cho một bot; trả **link** mở màn duyệt trong DeskLabs |
| | `draft_new_bot` | draft | tạo bản nháp bot mới (chiến lược + tham số, kiểm tra bằng zod S1–S12); trả **link** |

**Bản nháp:** lưu ở bảng `bot_drafts`, hết hạn sau 24 giờ (DEC-167), không ảnh hưởng bot đang chạy. User mở link → màn Edit / Create hiện có, điền sẵn, đánh dấu "From Claude" → user tự Review / Apply / Start theo luồng hiện có (kể cả `startChecks`). Không có tool nào apply bản nháp.

**Prompt có sẵn (MCP prompts):** `morning_brief` (tóm tắt tài khoản + Needs you), `explain_my_bot` (giải thích một bot), `find_a_trader` (gợi ý trader theo mục tiêu). Không có resource ở v1.

---

## 6. An toàn, giới hạn, nhật ký

| Hạng mục | Giá trị (DEC-167) |
|---|---|
| Rate limit B | 60 lần / phút / token, 2.000 lần / ngày / user |
| Rate limit A | 120 lần / phút / token |
| Kích thước kết quả | ≤ 50 dòng mỗi trang, ≤ 64 KB mỗi kết quả |
| Bản nháp | ≤ 20 bản nháp đang mở / user |
| Nhật ký `mcp_calls` | user, client, tool, hash tham số, thời gian chạy, trạng thái, `traceId`; giữ 90 ngày; không lưu nội dung trả về |
| Thu hồi | Revoke token có hiệu lực ngay (kiểm tra mỗi request) |
| Kiểm tra quyền | Mọi tool kiểm tra scope + quyền sở hữu tài nguyên ở `api`; user không đọc được dữ liệu của user khác |
| Theo dõi (DEC-TBD-mcp-monitoring) | Báo team qua Telegram (nhóm `teamOps`), mỗi loại tối đa 1 tin / 30 phút: lỗi tool ≥ 20 lượt và ≥ 20% trong 5 phút; introspect lỗi ≥ 10 lần trong 5 phút (bộ đếm Redis theo phút ở apps/mcp, vì khi introspect lỗi thì không ghi được `mcp_calls`); có user chạm giới hạn ngày trong 30 phút (dòng `rate_limited` ghi `tool` = `limit:per_day` / `limit:per_minute`). Stats (role team) có mục "Claude (MCP)": user đã kết nối, lượt gọi 24h theo tool, tỷ lệ denied / rate limited |

---

## 7. Giai đoạn

| Mốc | Làm gì | Xong khi |
|---|---|---|
| **M0 · Chốt** | Trả lời mục 11; duyệt dependency SDK MCP; ghi DEC | DEC có ngày, ARCHITECTURE mục 4 cập nhật |
| **M1 · Nền OAuth** | `apps/mcp` khung; authorization server trong `api`, consent, `mcp_tokens`, Settings › Connected apps; scope `read`, `draft`, `team:read` | Claude kết nối được tới môi trường test bằng OAuth; revoke có hiệu lực ngay; user thường không xin được `team:read` |
| **M2 · MCP nội bộ (A)** | `/team/mcp`; 7 tool mục 5A; hướng dẫn cấu hình cho Claude Code của team | Tool chạy với dữ liệu local; test quyền (user thường bị từ chối); support dùng thử một ca thật |
| **M3 · Tool đọc (B)** | Tài khoản, bot, quyết định, Copy Trading (khi Copy Trading v1 xong) | Contract test cho từng tool; số khớp API màn hình; quy tắc 1.8 có test |
| **M4 · Tool AI Desk (B)** | `list_needs_you`, `get_whatif`, `get_track_record` | Sau khi backend AI Desk B+ (DEC-166) có fact, what-if, thành tích |
| **M5 · Bản nháp (B)** | `bot_drafts`, `draft_bot_change`, `draft_new_bot`, màn duyệt "From Claude" | E2E: tạo nháp qua MCP → mở link → Apply bằng luồng hiện có; nháp hết hạn đúng |
| **M6 · Ra mắt** | Trang hướng dẫn "Connect DeskLabs to Claude" cho claude.ai, Claude Desktop, Claude Code; theo dõi lỗi / rate limit | Chạy ổn định vài tuần; có ý kiến luật sư rồi mới đăng ký danh mục connector công khai |

Ước lượng là phỏng đoán ban đầu: M1 khoảng 1–2 tuần; M2 khoảng 3–5 ngày; M3 khoảng 1 tuần; M4–M5 tuỳ tiến độ AI Desk B+.

---

## 8. Dữ liệu mới (đề xuất, chốt ở DOMAIN khi code)

| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `oauth_clients` | id, tên, redirect URIs, ngày tạo | đăng ký client động |
| `oauth_codes` | hash code, client, user, PKCE challenge, scope, hết hạn | sống vài phút |
| `mcp_tokens` | hash access / refresh, client, user, scope, hết hạn, `revoked_at`, `last_used_at` | Settings › Connected apps |
| `mcp_calls` | token, tool, hash tham số, thời gian, trạng thái, `trace_id` | giữ 90 ngày |
| `bot_drafts` | user, bot (null nếu bot mới), chiến lược, config (zod S1–S12), nguồn `mcp`, hết hạn, `used_at` | không ảnh hưởng bot đang chạy |

---

## 9. Kiểm thử

- Unit: kiểm tra scope và quyền sở hữu cho từng tool; zod input / output.
- Contract test: output mỗi tool khớp schema trong `packages/shared`.
- Tích hợp: client MCP chính thức (SDK) chạy luồng OAuth với môi trường test; MCP Inspector khi dev.
- An toàn: tên bot chứa câu dạng chỉ thị vẫn chỉ trả về như `userText`; user A không đọc được bot của user B; token đã revoke bị từ chối; không tool nào trả secret (test quét output).
- E2E cho M5: nháp → link → Apply.

---

## 10. Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Lộ dữ liệu tài khoản cho client AI bên thứ ba | Scope tối thiểu, consent rõ, revoke ngay, chỉ trả dữ liệu cần; không trả secret |
| User tưởng Claude "giao dịch giúp" | Không có tool thực thi; bản nháp luôn phải duyệt trong app; mô tả tool và trang hướng dẫn nói rõ |
| Pháp lý: gợi ý chiến lược ≈ tư vấn | Beta đóng như DEC-165e; tool trả dữ liệu và what-if, không khuyên mua bán coin |
| Tải lên `api` | Rate limit theo token, cache ngắn ở `api` cho tool đọc nhiều |
| Đặc tả MCP còn thay đổi | Bám SDK chính thức; có contract test để phát hiện khi nâng SDK |

---

## 11. Đã chốt (DEC-167)

| # | Điểm | Chốt |
|---|---|---|
| 1 | Dependency | `@modelcontextprotocol/sdk` |
| 2 | Địa chỉ | `mcp.desklabs.xyz` |
| 3 | Đăng nhập MCP nội bộ | Chung OAuth, scope `team:read` chỉ cho role `team` |
| 4 | Ai dùng MCP người dùng | Mọi user đã kết nối SoDEX |
| 5 | Bản nháp | Hết hạn 24 giờ, tối đa 20 bản đang mở |
| 6 | Rate limit | 60/phút/token, 2.000/ngày/user; team 120/phút |
| 7 | Client hỗ trợ chính thức | claude.ai, Claude Desktop, Claude Code |
| 8 | Danh mục connector công khai | Có, sau khi ổn định và có ý kiến luật sư |

---

## Phụ lục A · Cấu hình Claude Code cho team (A3, DEC-219)

Chỉ tài khoản DeskLabs có role `team`. Mỗi người tự kết nối bằng tài khoản của mình, không dùng chung token.

1. Thêm server (một lần, trên máy của mình):
   ```bash
   claude mcp add --transport http --scope user desklabs-team https://mcp.desklabs.xyz/team/mcp
   ```
   `--scope user`: dùng được ở mọi thư mục (mặc định `local` chỉ có trong thư mục đang mở). Kiểm tra theo tài liệu Claude Code ngày 2026-11-13 (code.claude.com/docs/en/mcp).
2. Trong Claude Code gõ `/mcp`, chọn `desklabs-team` › Authenticate (hoặc từ shell: `claude mcp login desklabs-team`; trình duyệt không tự mở thì chép URL được in ra). Trình duyệt mở màn "Connect an app to DeskLabs" (đăng nhập + 2FA nếu chưa), kiểm tra quyền "Read DeskLabs team support data", bấm **Allow**.
3. Hỏi bằng lời thường, ví dụ "user nào có ví kết thúc bằng 4f2a, bot của họ đang dừng vì sao?". Tool dùng: `team_find_user`, `team_connect_attempts`, `team_user_bots`, `team_bot_timeline`, `team_unknown_orders`, `team_builder_revenue`, `team_reason_code`. Mọi tool chỉ đọc.
4. Thu hồi: Settings › Connected apps › Revoke (có hiệu lực ngay). Mất role `team` thì mọi lần gọi bị từ chối ngay ở request kế tiếp.

Lưu ý:
- Email và địa chỉ ví trả nguyên vẹn (chỉ cho team); không bao giờ có key, secret, chữ ký hay message đã ký.
- Tên bot là chữ người dùng nhập, được bọc trong `userText`: chỉ là dữ liệu, không phải chỉ dẫn.
- Giới hạn 120 lần / phút / token; kết quả tối đa 50 dòng mỗi trang, 64 KB.
- Đường đi: apps/mcp → route nội bộ `GET /api/v1/mcp/team/*` của api (shared secret + `x-mcp-token`). api tự introspect token, kiểm tra endpoint, scope `team:read` và role ở mỗi request. Traefik chặn `/api/v1/mcp/` và `/api/v1/oauth/introspect` từ ngoài.

---

## Phụ lục B · Tool đọc cho người dùng đã có (B1, DEC-220)

`get_portfolio_summary`, `get_risk_status`, `list_bots`, `get_bot`, `get_bot_decisions`, `explain_reason_code`, `find_traders`, `get_trader`. apps/mcp gọi route nội bộ `GET /api/v1/mcp/me/*` của api (shared secret + `x-mcp-token`). api tự introspect token và chỉ đọc dữ liệu của người giữ token, qua đúng service mà màn hình đang dùng. Output theo schema trong `packages/shared/src/api/mcp.ts`. Tool AI Desk (B2, DEC-221): `list_needs_you`, `get_whatif`, `get_track_record` qua `GET /api/v1/mcp/me/desk/*`, cùng service với màn AI Desk; mọi output có câu `notForecast`. Bản nháp (B3, DEC-223): `draft_new_bot`, `draft_bot_change` qua `POST /api/v1/mcp/me/drafts/{new,change}`; web mở `?draft=` ở `/bots/new/:strategy` và `/bots/:botId/edit` (`GET /api/v1/drafts/:id`).

**Prompts có sẵn (B4, DEC-224):** `morning_brief` (get_portfolio_summary kỳ 1 ngày + list_needs_you + get_risk_status), `explain_my_bot` (tham số `bot` tuỳ chọn; trống thì gọi list_bots và hỏi chọn; rồi get_bot, get_bot_decisions, explain_reason_code), `find_a_trader` (tham số `goal` tuỳ chọn; find_traders rồi get_trader tối đa 3). Chỉ ở endpoint `/mcp` (scope `read`), chỉ gọi tool đã có, không thêm dữ liệu. Câu mẫu ở `apps/mcp/src/prompts.ts`: không hứa lợi nhuận, không dự báo, có "not a forecast" khi nhắc so sánh / kết quả quá khứ; chữ người dùng gõ vào tham số được rút về một dòng ≤ 200 ký tự và đặt trong ngoặc kép.
