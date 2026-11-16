# Ảnh share (Open Graph / X card) cho landing và /claude (người dùng chọn bản tối, 2026-11-16)

Nguồn: canvas "DeskLabs share images" (https://claude.ai/artifact/TzjkLE7Kdm3EcMPTHzheoN, bản 1794822707-b0e2).

| File | Xuất ra | Phạm vi |
|---|---|---|
| `Main.dc.html` (theme dark) | `apps/web/public/og/desklabs.jpg` (thay ảnh cũ) | **Ship** |
| `OgClaude.dc.html` (theme dark) | `apps/web/public/og/claude.jpg` (mới) | **Ship** |
| `Previews.dc.html` | Card X / Facebook / Telegram (gần đúng) + meta tag | Tham khảo |
| `canvas.json` | Spec và ghi chú | Tham khảo |

Quy tắc:
- 1200×630 JPG, dưới 300 KB; lề an toàn 64 px.
- Không có số live (volume, CPM, PnL, mức phí): nền tảng cache ảnh rất lâu.
- Meta copy (DevOps duyệt):
  - Landing: og:title "DeskLabs · Volume on SoDEX, built mostly with maker orders"; og:description "Market Making and Volume Builder on your own SoDEX account. Every decision logged; it can never withdraw your funds."; alt "DeskLabs: Market Making and Volume Builder bots on SoDEX. Powered by SoDEX Builder Code."
  - /claude: og:title "Ask Claude about your DeskLabs bots"; og:description "Connect DeskLabs to Claude and ask about your bots, portfolio and risk. Claude reads; you decide."; alt "DeskLabs for Claude: ask about your bots in plain words."
- /claude có share image riêng (`lib/share-image.ts`).
- Sau deploy: làm mới cache (Facebook Sharing Debugger, Telegram @WebpageBot).
