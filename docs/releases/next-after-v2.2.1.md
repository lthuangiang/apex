# Bản kế tiếp sau v2.2.1 (chưa gắn tag)

PM đổi tên file theo tag khi người dùng gõ "release" (có `feat` nên dự kiến tăng minor, xem `docs/RELEASE.md` mục 2). Danh sách tính tới `main` ngày 2026-11-13, gồm tới #90.

> **Lần pull này lớn hơn bình thường:** release này build lại **cả 11 image**. Phần đầu chung của mọi Dockerfile đổi (thêm manifest `apps/mcp`, #74) và có thêm app `mcp`, nên VPS phải tải lại các layer chung một lần. Từ release sau, kích thước pull trở lại như DEC-214.

## Cho người dùng (English, dùng được cho GitHub Release)

**Ask DeskLabs from Claude**
- Connect DeskLabs to Claude (claude.ai, Claude Desktop, Claude Code) and ask about your account in your own words: balances, risk, bots, recent decisions, AI Desk and Copy Trading.
- Claude reads your data. It can’t place trades, change bots or move funds.
- Claude can draft a new bot or a change to a bot for you. You open the link in DeskLabs, review it and decide; drafts last 24 hours.
- See and revoke connected apps any time in Settings › Connected apps.
- Ready-made prompts: morning brief, explain my bot, find a trader to copy (#85).
- Guide page "Connect DeskLabs to Claude" at desklabs.xyz/claude, linked from the landing page, the FAQ, the footer, Settings › Connected apps and Desk AI (#90).

**AI Desk**
- Desk AI now answers questions about coins, markets and strategies more accurately (#73).
- Desk AI says what it can help with, and suggests example questions when a question is out of scope (#87).

**Bots**
- AI Adaptive DCA is available to every account, labelled Beta (#71).
- Rebalancing: when the initial buy is spread over hours, Trading Agent shows how many parts are done (#82).

**Copy Trading**
- Following: Recent changes with Load more, filter by trader, and a preview of each alert level (#76).
- Trader cards link to the trader; chips filter Recent changes; alerts menu as a compact bell pill (#80).

Not financial advice. Past results are not a forecast.

## Kỹ thuật

**Service và hạ tầng**
- Service mới `apps/mcp` (cổng 8097, host `mcp.desklabs.xyz`): MCP Streamable HTTP, Protected Resource Metadata, introspect mỗi request, rate limit trong Redis (#74, DEC-217).
- OAuth 2.1 trong `api`: metadata, CIMD + DCR, PKCE, resource bắt buộc, token xoay, consent, Connected apps (#72, DEC-215).
- Tool team `/team/mcp` + route nội bộ `/api/v1/mcp/team/*`; Traefik chặn `/api/v1/oauth/introspect` và `/api/v1/mcp/` từ ngoài (#75, DEC-219).
- Tool người dùng (#78, DEC-220), AI Desk (#79, DEC-221), bản nháp + step-up scope `draft` (#84, DEC-223).
- Prompts (#85, DEC-224). Theo dõi MCP: báo team qua Telegram, mục MCP ở Stats (#88, DEC-225).
- Trang công khai `/claude` (#90): địa chỉ server đọc từ `MCP_PUBLIC_URL` của service `web` lúc chạy (mặc định `https://mcp.desklabs.xyz/mcp`).
- Mọi Dockerfile có thêm dòng manifest `apps/mcp` (DEC-214); `release.yml`, `changed-apps.sh`, `build-push.sh` tính 11 app.

**Migration (chạy khi deploy, tương thích ngược)**
- `0029_mcp_oauth`: bảng `oauth_clients`, `oauth_codes`, `mcp_tokens`, `mcp_calls`.
- `0030_adaptive_dca_for_all`: `users.adaptive_dca` mặc định `true` và bật cho mọi tài khoản hiện có (DEC-218). Rollback image không tắt lại; team tắt từng tài khoản ở Users.
- `0031_mcp_bot_drafts`: bảng `bot_drafts`.

**Biến môi trường mới** (`.env` trên VPS): `MCP_PUBLIC_URL` (api, mcp và web), `MCP_INTROSPECT_SECRET`, `MCP_HOST`. Bật MCP theo checklist `docs/DEPLOY.md` mục 2.11. Không bật thì mọi thứ khác chạy như cũ (`/mcp` trả 503).

**Compose trên VPS (sửa tay)**: router `api` thêm `/.well-known/oauth-authorization-server`, router `api-internal`, service `mcp` (dev + prod). Chi tiết ở DEPLOY 2.9–2.11.

**PR khác**: #70 (E2E theo câu chữ mới), #81 (đánh số DEC), #83 / #86 (mockup trang hướng dẫn).
