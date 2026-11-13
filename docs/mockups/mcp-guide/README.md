# Mockup: trang hướng dẫn "Connect DeskLabs to Claude" (MCP M6)

Bản chép từ canvas "DeskLabs · Connect Claude guide" (https://claude.ai/artifact/X665sL7rjaHK8qH3FUwtpm, private). Người dùng duyệt thiết kế ngày 2026-11-13. Câu chữ PM duyệt, chép đúng như artboard (DEC-31: quyết định thắng artboard nếu lệch).

| File | Là gì |
|---|---|
| `Main.dc.html` | Trang hướng dẫn, desktop 1440 (trang fluid, cùng file dùng cho mobile) |
| `Mobile.dc.html` | Cùng trang ở 390 (import `Main`) |
| `LandingCard.dc.html` | Lối vào từ landing: thẻ thứ 4 "Ask from Claude" trong mục "More than bots" (`#desk`), câu FAQ mới, link ở footer |
| `ConnectedApps.dc.html` | Lối vào trong app: Settings › Connected apps, trạng thái trống và khi đã có app |

## Route và lối vào

- Route công khai `/claude` (không cần đăng nhập; thêm vào `OPEN_PATHS` của `apps/web/src/proxy.ts`). Có `metadata` title/description riêng.
- Lối vào:
  1. Landing › More than bots: thẻ "Ask from Claude", link "Connect Claude →".
  2. Landing › FAQ: "Can I use DeskLabs with Claude?", link "See how to connect".
  3. Footer: link "Connect Claude".
  4. Settings › Connected apps: trống thì nút "How to connect Claude"; có app thì link "How to connect Claude →" dưới danh sách.
  5. Desk AI, popover "What can Desk AI do?" (W6): dòng cuối "Prefer Claude? Connect DeskLabs to Claude." → `/claude`.
- Không thêm vào menu trên cùng của landing.

## Các phần của trang

Hero (địa chỉ server + nút Copy, câu an toàn, chat mẫu) → What Claude can do (4 thẻ + hộp "What Claude can't do") → Connect in 2 minutes (tab claude.ai / Claude Desktop / Claude Code, 4 bước mỗi tab; tab Code có lệnh terminal; bản xem trước màn consent) → Permissions (read / drafts) → Try asking (6 câu) → How drafts work (3 bước + banner "From Claude") → Disconnect + Limits → FAQ (6 câu, accordion) → khối Launch app + dòng "Not financial advice".

## Lưu ý khi code

- Câu chữ vào `apps/web/messages/en.json` (namespace mới `claudeGuide.*`, landing `landing.desk.items.claude.*`, `landing.faq.items.claude.*`); không cần `_pendingReview`.
- Chữ trong ngoặc vuông (`[App name]`, `[Bot name]`, `[N]`, `[time]`) là chỗ trống minh hoạ: trên trang thật giữ dạng minh hoạ trung tính, **không** điền số giả.
- Số giới hạn lấy từ hằng số thật (`MCP_RATE_LIMITS`, hạn bản nháp 24 giờ, tối đa 20 bản nháp), không viết cứng.
- Địa chỉ server lấy từ cấu hình (`MCP_PUBLIC_URL` + `/mcp`), mặc định `https://mcp.desklabs.xyz/mcp`.
- **Trước khi ra mắt:** đối chiếu các bước kết nối claude.ai / Claude Desktop / Claude Code với trang trợ giúp hiện tại của Anthropic; menu có thể đã đổi.
- Tab là `role="tablist"` có phím mũi tên; FAQ là nút có `aria-expanded`; nút Copy báo "Copied" qua `aria-live`. Axe 0 lỗi ở 1440 và 390.
