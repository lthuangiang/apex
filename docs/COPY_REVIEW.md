# Rà câu chữ UI chờ duyệt (2026-10-29, DEC-60)

Người dùng giao cho Claude Code đề xuất và chốt các câu chữ trong `_pendingReview` của `apps/web/messages/en.json`
(342 chuỗi sau khi bung wildcard). Tiêu chí rà: đúng quyết định trong `docs/DECISIONS.md`, nói rõ người dùng phải
làm gì tiếp, đơn vị tiền nhất quán, dấu nháy cong `’` / `“”` như phần còn lại của app, không dùng từ nội bộ
("backend", "snapshot"), không hứa điều chưa kiểm chứng.

## Đã đổi

| Key | Trước | Sau | Lý do |
|---|---|---|---|
| `onboarding.connect.errors.noWallet` | No browser wallet found. Install or unlock a wallet, then try again. | No browser wallet found. Install or unlock one, or use WalletConnect to sign from your phone. | Chỉ lối thoát khi máy không có ví (WalletConnect, DEC-44) |
| `onboarding.connect.errors.accountInUse` | This SoDEX account is already connected to another DRIFT account. | … Sign in to that account and disconnect SoDEX there first. | Người dùng không biết phải làm gì (DEC-45: Disconnect thì account được chuyển) |
| `onboarding.connect.wallets.wcNote` | Scan with a mobile wallet (Binance, OKX, Bitget…) | Scan the QR code with a mobile wallet | Chưa kiểm tra ví nào ký được EIP-712 trên chain 286623 (DEC-44), không nêu tên ví |
| `createBot.beforeStart.failDetail.leverage_bot` | Your bot "{name}" runs {market} at {current}. | Your bot “{name}” runs {market} at {current}. Use {current} for this bot, or stop that bot first. | Thêm việc cần làm, như `leverage_position` (DEC-58) |
| `createBot.beforeStart.failDetail.balanceNumbers` | Available {available} · needs {needed} | Available {available} USDC · needs {needed} USDC | Thiếu đơn vị |
| `createBot.beforeStart.failDetail.balancePerps` | Needs {needed} USDC; usable as margin {usable} (isolated: {isolated}) | Needs {needed} USDC · usable as margin {usable} · isolated {isolated} | Cùng dấu phân cách với các check khác |
| `createBot.beforeStart.failDetail.risk_limits` | Outside account limits | Outside your account risk limits | Rõ đây là giới hạn ở Risk Center |
| `reasons.API_KEY_UNUSABLE` | Paused: DRIFT can't sign with your API key. Renew it in Settings › SoDEX access. | Paused: DRIFT can’t sign with your API key | Cùng dạng ngắn với các reason khác; hướng dẫn Renew đã có ở check và chip header |
| `risk.alert.daily_loss.body` | Trading was blocked at {loss}% loss. Resets at 00:00 in your time zone. | Running agents were paused at {loss}% loss. The limit resets at 00:00 in your time zone. | DEC-41: daily loss **pause** bot, không chỉ chặn lệnh |
| `risk.halt.done` | … once the backend confirms. | … once DRIFT confirms. | Bỏ từ nội bộ |
| `overview.periodWord.all` | since first snapshot | since DRIFT started tracking | Bỏ từ nội bộ; snapshot bắt đầu khi account được kết nối (DEC-41) |
| `createBot.beforeStart.failDetail.api_keyUnusable`, `…leverage_conflict`, `portfolio.accounts.perpsUnavailable` | `'` thẳng | `’` cong | Thống nhất dấu nháy |

## Đã xoá

- `createBot.beforeStart.saveFirst`: không còn dùng từ khi checks chạy dry run trên form chưa lưu (UI_REVIEW H2).
- Hai mục trỏ sai key trong danh sách cũ (`risk.items.*.body`, `risk.breached*`): key thật là
  `risk.items.<id>.body`, `risk.breachedTitle`, `risk.breachedBody`; nội dung đã đúng DEC-41, giữ nguyên.

## Giữ nguyên

Mọi chuỗi còn lại trong danh sách cũ (onboarding, connect, import, analysis, create bot, backtest, preview,
portfolio/accounts, risk, analyst, revenue, notifications, settings, agent, Volume Maker, renew key) đọc rõ,
đúng quyết định và đúng quy tắc 1.8 ("Not available" thay cho 0), nên giữ nguyên.

Từ nay câu chữ mới vẫn được thêm vào `_pendingReview` như trước.
