# Prompt cho agent code: DeskLabs MCP

Bạn đang làm trong monorepo DeskLabs (tên code cũ: DRIFT; pnpm, turbo, Next, Fastify, Drizzle, NATS, Vault, Traefik). Nhiệm vụ: xây **MCP** theo **`docs/MCP.md`** và **DEC-167**: nền OAuth, MCP nội bộ cho team, DeskLabs MCP cho người dùng (tool đọc + bản nháp).

Trả lời và viết tài liệu bằng tiếng Việt. Tên tool, field, API, enum, code, commit message và mọi câu chữ hiển thị trong app bằng tiếng Anh.

---

## 1. Đọc trước khi code (theo thứ tự)

1. `CLAUDE.md`: quy tắc sản phẩm 1.1–1.10, quy định code. **Bắt buộc.**
2. `docs/MCP.md`: **spec chính** (kiến trúc, đăng nhập, danh mục tool, giới hạn, giai đoạn, bảng dữ liệu, kiểm thử).
3. `docs/DECISIONS.md`: **DEC-167** (các lựa chọn đã chốt), DEC-64 (role `team`), DEC-35 (app không import app khác), DEC-114 (`connect_events`), DEC-115 (2FA không bắt buộc), DEC-161/162/163 (Copy Trading), DEC-164/165/166 (AI Desk).
4. `docs/ARCHITECTURE.md` mục 3–4, `docs/CODING_STANDARDS.md` (C6 lỗi, mục 14 Definition of done), `docs/DOMAIN.md` (bảng, reason code mục 7.2), `docs/DESIGN.md`, `docs/STRATEGIES.md` (zod S1–S12 cho bản nháp), `docs/DEPLOY.md`.
5. Code hiện có:
   - Auth / session: `apps/api/src/app.ts`, `apps/api/src/plugins/{session,rate-limit}.ts`, `apps/api/src/modules/{auth,security,account}/*`
   - Dữ liệu cần trả: `apps/api/src/modules/{bots,desk,profile,data}/*`, `packages/db`, `packages/shared`
   - Web: `apps/web/src/app/settings/page.tsx`, `apps/web/src/components/workspace-shell.tsx`, `apps/web/messages/en.json`, màn Edit / Create bot trong `apps/web/src/features/bots/*`
   - Hạ tầng: `docker-compose.yml`, `docker-compose.prod.yml`, `infra/` (Traefik, Vault, cert), `scripts/dev-up.sh`

Không tự bịa quy tắc nghiệp vụ. Tài liệu không nói thì chọn cách **an toàn nhất**, ghi vào báo cáo cuối, rồi làm tiếp. **Dừng lại hỏi** khi việc đó mở rộng quyền (thêm scope, thêm tool ghi), đụng tới tiền thật, hoặc đổi một DEC đã có.

---

## 2. Những gì đã chốt (DEC-167, tóm tắt)

| Điểm | Giá trị |
|---|---|
| Service | `apps/mcp` mới, stateless, MCP Streamable HTTP; gọi `apps/api` để kiểm tra quyền; không import app khác |
| SDK | `@modelcontextprotocol/sdk` (đã duyệt). Không thêm dependency khác ngoài ARCHITECTURE mục 4; cần thêm thì dừng hỏi |
| Địa chỉ | `mcp.desklabs.xyz` (Traefik); local theo cách `APP_HOST` hiện có |
| Đăng nhập | OAuth 2.1 theo đặc tả MCP (authorization code + PKCE, metadata, đăng ký client động); authorization server trong `apps/api`, dùng lại session |
| Scope | `read`, `draft` cho mọi user đã kết nối SoDEX; `team:read` chỉ cho role `team` (chỉ hiện ở consent khi user là team; `api` kiểm tra lại role mỗi request) |
| Token | access 1 giờ, refresh 30 ngày, chỉ lưu hash; revoke có hiệu lực ngay; quản lý ở Settings › Connected apps |
| Bản nháp | hết hạn 24 giờ, tối đa 20 bản đang mở / user; chỉ áp dụng qua màn Edit / Create hiện có |
| Rate limit | 60 lần/phút/token, 2.000 lần/ngày/user; team 120 lần/phút |
| Client hỗ trợ | claude.ai, Claude Desktop, Claude Code |
| Nhật ký | bảng `mcp_calls`, giữ 90 ngày, không lưu nội dung trả về |

---

## 3. Luật an toàn, không được vi phạm

1. **Không có tool thực thi.** Không tool nào đặt / huỷ lệnh, start / stop / pause / resume bot, áp dụng bản nháp, đổi cấu hình, đổi Settings hay builder fee. **Không có code path rút hay chuyển tiền** (quy tắc 1.1).
2. `apps/mcp` **không gọi signer, engine, marketdata hay SoDEX**; chỉ gọi `apps/api`.
3. Mọi tool kiểm tra **scope + quyền sở hữu tài nguyên ở `api`**. User A không bao giờ đọc được dữ liệu của user B. Tool nội bộ chỉ chạy với `team:read` **và** role `team`.
4. **Không trả secret** (private key, seed, API key, chữ ký, secret OAuth). Key chỉ hiện 4 ký tự cuối (quy tắc 1.9). Có test quét output.
5. **Không bịa số** (quy tắc 1.8): thiếu dữ liệu trả `null` + `reason: "not_available"`, không trả `0`. Mỗi kết quả có `asOf`, `source`. Tiền / giá / khối lượng là chuỗi thập phân kèm đơn vị (`decimal.js`, không float).
6. **Dữ liệu do user nhập** (tên bot, ghi chú, nhãn) trả trong trường `userText`, không ghép vào câu mô tả tool hay câu hướng dẫn.
7. Paper và tiền thật luôn tách (quy tắc 1.2): mọi số tài khoản ghi rõ `mode`.
8. Log JSON có `traceId`; không log token, secret, payload đã ký hay nội dung trả về.
9. Không sửa file trong `.claude/`, không đổi DEC đã có. Test dùng mock (`@drift/sodex-mock`), không chạy trên mainnet.

---

## 4. Thứ tự làm

Mỗi mốc xong thì chạy `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` của phần liên quan. **Mốc nào phụ thuộc phần chưa có thì bỏ qua, ghi vào báo cáo.**

**M0 · Chuẩn bị (không viết tính năng).** Đọc phần authorization của đặc tả MCP hiện hành và tài liệu SDK để xác định đúng endpoint metadata, đăng ký client động, PKCE, cách SDK xử lý bearer token. Ghi những gì khác với `docs/MCP.md` vào báo cáo; khác ở điểm quan trọng thì dừng hỏi.

**M1 · Nền OAuth.**
- Migration Drizzle: `oauth_clients`, `oauth_codes`, `mcp_tokens`, `mcp_calls` (cột theo MCP.md mục 8; chốt chi tiết vào `docs/DOMAIN.md`).
- `apps/api`: authorization server (metadata, đăng ký client, authorize, token, refresh, revoke), kiểm tra scope và role, rate limit theo token / user (dùng `plugins/rate-limit.ts`).
- `apps/web`: màn consent (client, scope bằng lời thường, Allow / Deny) và **Settings › Connected apps** (client, scope, lần dùng cuối, Revoke). Câu chữ mới trong `en.json` (`_pendingReview`), đủ 4 trạng thái, responsive 1440 / 390, a11y.
- `apps/mcp`: khung service, Streamable HTTP, xác thực bearer qua `api`, ghi `mcp_calls`, health check; thêm vào docker compose và Traefik (`mcp.desklabs.xyz`), `scripts/dev-up.sh`.
- **Xong khi:** client MCP chính thức (SDK) chạy hết luồng OAuth với môi trường local; revoke có hiệu lực ngay; user thường không xin được `team:read`; token hết hạn bị từ chối.

**M2 · MCP nội bộ.** Endpoint `/team/mcp`, 7 tool ở MCP.md mục 5A (`team_find_user`, `team_connect_attempts`, `team_user_bots`, `team_bot_timeline`, `team_unknown_orders`, `team_builder_revenue`, `team_reason_code`). Viết hướng dẫn cấu hình cho Claude Code của team trong `docs/MCP.md` (phụ lục). **Xong khi:** test quyền (user thường bị từ chối ở mọi tool), output không có secret.

**M3 · Tool đọc cho người dùng.** `get_portfolio_summary`, `get_risk_status`, `list_bots`, `get_bot`, `get_bot_decisions`, `explain_reason_code`. Thêm `find_traders`, `get_trader` **chỉ khi** API Copy Trading v1 đã có trong code (một agent khác đang làm theo `docs/COPY_TRADING_PROMPT.md`); chưa có thì bỏ qua. Số liệu lấy đúng service mà màn hình đang dùng để khớp nhau. **Xong khi:** contract test cho từng tool (schema output trong `packages/shared`), test quy tắc 1.8, test user A / user B.

**M4 · Tool AI Desk.** `list_needs_you`, `get_whatif`, `get_track_record`. **Chỉ làm khi** backend AI Desk B+ (DEC-166) đã có fact, what-if, thành tích; nếu chưa thì bỏ qua và ghi vào báo cáo.

**M5 · Bản nháp.**
- Bảng `bot_drafts` (hết hạn 24 giờ, tối đa 20 bản mở / user), config kiểm tra bằng zod của chiến lược (S1–S12).
- Tool `draft_bot_change`, `draft_new_bot` (scope `draft`): chỉ tạo bản nháp, trả link `https://<APP_HOST>/bots/new/:strategy?draft=<id>` hoặc `/bots/:botId/edit?draft=<id>` (theo route hiện có).
- Web: màn Edit / Create đọc `draft`, điền sẵn, hiện nhãn "From Claude", hết hạn thì báo rõ. User vẫn phải Review / Apply / Start theo luồng hiện có, kể cả `startChecks`.
- **Xong khi:** E2E: tạo nháp qua MCP → mở link → Apply bằng luồng hiện có; nháp hết hạn và vượt 20 bản bị từ chối đúng; bản nháp không làm đổi bot đang chạy.

**M6 · Hướng dẫn và ra mắt.** Trang công khai "Connect DeskLabs to Claude" (claude.ai, Claude Desktop, Claude Code). Prompt MCP có sẵn: `morning_brief`, `explain_my_bot`, `find_a_trader` (chỉ những tool đã có). Theo dõi lỗi và rate limit. **Không** tự đăng ký danh mục connector công khai (DEC-167: chờ chạy ổn định và có ý kiến luật sư).

---

## 5. Kiểm thử bắt buộc

- Scope và quyền sở hữu cho **mọi** tool; `team:read` + role `team` cho tool nội bộ.
- Contract test output; zod input.
- Tên bot chứa câu dạng chỉ thị vẫn chỉ nằm trong `userText`.
- Quét output: không có chuỗi giống key, seed, chữ ký, token.
- Token đã revoke / hết hạn bị từ chối; rate limit trả lỗi đúng format C6.
- E2E OAuth + E2E bản nháp (Playwright, theo cách `pnpm e2e` đang dựng môi trường).

---

## 6. Definition of done

- Đạt mục 14 của `docs/CODING_STANDARDS.md`.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` (phần MCP) pass.
- Không có chuỗi UI viết thẳng trong component, không có mã hex trong component.
- `docs/MCP.md`, `docs/DOMAIN.md`, `docs/SCREENS.md` (consent, Connected apps, nhãn "From Claude"), `docs/DEPLOY.md` (service `mcp`, DNS, Traefik) khớp với code.
- Một **DEC mới** ghi các lựa chọn lúc code (ghi "chọn theo khuyến nghị, chờ duyệt").

---

## 7. Báo cáo cuối

Viết bằng tiếng Việt, gồm:
1. Đã làm gì theo từng mốc, file chính đã đổi; mốc nào bỏ qua và vì sao.
2. Lệnh test đã chạy và kết quả **thật** (fail thì dán output).
3. Lựa chọn tự đưa ra khi tài liệu không nói, và DEC đã ghi.
4. Việc còn lại, rủi ro, câu hỏi cần người dùng chốt.

Không commit hay push trừ khi người dùng yêu cầu.
