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

## Đợt 2 (2026-10-29, DEC-79)

Người dùng giao Claude Code tự chốt 116 chuỗi thêm vào `_pendingReview` từ DEC-48 tới DEC-78. Cùng tiêu chí như đợt 1.

| Key | Trước | Sau | Lý do |
|---|---|---|---|
| `createBot.marketPicker.watchFailed`, `overview.watchlistCard.saveFailed`, `settings.sodexAccess.keyUnusableBody`, `adminUsers.subtitle`, `notFound.title` | `'` thẳng | `’` cong | Thống nhất dấu nháy |
| `createBot.advanced.optionalUnset` | {n} optional not set | {n, plural, one {# optional field} other {# optional fields}} not set | Đọc thành câu, cùng dạng với `needValue` |
| `adminUsers.forbidden` | Users is for the DRIFT team only. | This page is for the DRIFT team only. | "Users is" đọc như lỗi ngữ pháp |

Mọi chuỗi còn lại giữ nguyên. `_pendingReview` để trống.

## Đợt 3 (2026-11-04, DEC-104)

Người dùng giao Claude Code tự chốt 180 key (238 chuỗi) trong `_pendingReview`, gồm phần thêm từ DEC-80 tới DEC-103
(Volume bots, Market Making, Scalp Farming, Fills, backtest 1 phút, chart, entry / next cycle, TWAP start, Initial
buy, Users). Cùng tiêu chí như đợt 1, thêm: câu chữ phải khớp hành vi thật của code, không ngụ ý chiến lược có lãi.

| Key | Trước | Sau | Lý do |
|---|---|---|---|
| `createBot.fields.vmContract.hint` | … Other perps coming soon. | BTC-USD and ETH-USD only, the most liquid perps on SoDEX. | Hứa tính năng chưa có quyết định |
| `createBot.fields.orderSize.hint` | How much the bot posts on each side … every refresh. | … While the bot holds a position, the side that would add to it can be smaller. | Sai sau DEC-100 |
| `createBot.fields.refreshSeconds.hint` | … 2–60 s. Faster means more API calls. | … It also requotes about 2 s after each fill. … | Thiếu hành vi DEC-100 |
| `createBot.fields.costBudget.hint` | … trading fees plus losses … | … fees plus realized and unrealized losses … You get a warning at 80%. | Thiếu lỗ chưa chốt và mốc 80% |
| `createBot.fields.maxInventory.hint` | Empty = 4 × … Past 50% … | Empty = 2 × order size … reduce-only close … | DEC-100 |
| `createBot.fields.inventoryLossStop.hint` | … the bot stops. | … stops and handles the position as set in When the bot stops. | Nói rõ điều gì xảy ra với vị thế |
| `createBot.fields.distanceBp.hint` | Wider = safer, less likely to fill. | Wider means fewer fills and less exposure to fast moves. | "safer" là khẳng định mơ hồ |
| `createBot.strategies.volume_farm.fee` | both sides | every fill | Builder fee thu cả lúc vào và ra |
| `createBot.fields.vfTp*`, `vfEarly*` | TP USDC / early exit | Bỏ, thay bằng `vfTpAtr`, `vfSlAtr`, `vfMinConfidence`, `vfLossStreak`, `vfLossPause` | DEC-102 |
| `createBot.fields.vfMinConfidence.hint` | Higher means fewer, more selective trades. | Scores rarely go above 50%, so high values can stop the bot from trading. | Tránh đặt mức làm bot không bao giờ vào lệnh |
| `createBot.strategies.volume_farm.name` và các chỗ nhắc tên | Volume Farming | Scalp Farming | DEC-102 |
| `bots.long.volume_farm`, `createBot.strategies.volume_farm.what` | … in the trend’s direction … | … doesn’t go against the 5-minute trend … | Bot vẫn vào lệnh khi đi ngang |
| `bots.fits.volume_farm` | … keep each trade’s risk and reward in proportion. | … a defined exit on every trade, when you accept paying fees on each fill. | Không ngụ ý có lãi (backtest DEC-102 lỗ) |
| `bots.risks.volume_farm` | Fees add up on every trade … | Fees are paid on every fill and can outweigh trading gains … | Nói thẳng rủi ro chính |
| `createBot.backtest.stats.winRate` | Winning trades | Win rate after fees | Giá trị là %, tính sau phí |
| `createBot.backtest.intro`, `a3` | … the 0.01% builder fee … | … the {rate} builder fee … | Sai cho Market Making / Scalp Farming (DEC-94) |
| `agent.quotes.stopped` | … Start it again to resume quoting. | … The prices below are the live SoDEX order book. | Giải thích phần sổ lệnh vẫn hiện |
| `adminUser.viewNote` | Each time you open this page is recorded … | Every visit to this page is recorded … | Ngữ pháp |
| `adminUser.profitNote` | … Equity comes from the latest snapshot. | … Equity is the latest value DRIFT recorded. | Từ nội bộ |
| `createBot.fields.entryLow.hint` | favour | favor | App dùng chính tả Mỹ |
| `agent.fills.error`, `createBot.chart.error` | `'` thẳng | `’` cong | Thống nhất dấu nháy |
| `bots.catalog.volumeSection`, `volumeSectionBody` | Tiêu đề nhóm | Bỏ | Người dùng bỏ tiêu đề nhóm ở catalog |

Mọi chuỗi còn lại giữ nguyên. Giữ "SoPoints snapshot" (`agent.vf.volumeWeek`) vì là thuật ngữ của SoDEX. `_pendingReview` để trống.

## Đợt 4 (2026-11-04, DEC-109)

Người dùng giao Claude Code tự chốt 25 key (287 chuỗi) thêm từ DEC-105 tới DEC-108: AI Desk (Recommended, Why this one, Your
bots, Fake-money test, Test results, Use real money), Users › AI Desk, thông báo bài thử tiền giả, AI Adaptive DCA, Live quotes.
Cùng tiêu chí các đợt trước; thêm: thuật ngữ kỹ thuật (ATR, RSI) phải kèm giải thích ngắn ở chỗ người dùng nhập.

| Key | Trước | Sau | Lý do |
|---|---|---|---|
| `desk.bots.fees.saw` | … The bot made {net} {quote} in total. | … Net result so far: {net} {quote}. | "made −4.10" đọc sai khi lỗ |
| `bots.long.adaptive_dca` | … places each extra buy by ATR, … exposure cap … | … spaces extra buys by recent volatility (ATR), … position cap … | Giải thích ATR, dùng đúng tên field "Max position" |
| `createBot.fields.adcaAtr.hint` | … multiple of the 5-minute ATR … | … multiple of ATR, the average 5-minute price range … | Giải thích ATR |
| `createBot.fields.adcaRsi.hint` | … 5-minute RSI is at or below this … | … 5-minute RSI (0–100, low after a fall) … | Giải thích RSI |
| `createBot.fields.adcaHardStop.hint` | … against the average | … against the average price | Rõ nghĩa |
| `createBot.fields.adcaMaxExposure.hint` | The bot never holds more than this, whatever happens | Largest position value the bot may hold, leverage included. At the cap it stops adding and waits | Đúng định nghĩa trần (DEC-107) và hành vi khi chạm |

Mọi chuỗi còn lại giữ nguyên. `_pendingReview` để trống.

