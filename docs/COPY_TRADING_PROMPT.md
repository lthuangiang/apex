# Prompt cho agent code: Copy Trading v1

Bạn đang làm trong monorepo DeskLabs (tên code cũ: DRIFT; pnpm, turbo, Next, Fastify, Drizzle, NATS). Nhiệm vụ: xây **Copy Trading v1** theo **DEC-161, DEC-162, DEC-163** và design trong `docs/mockups/copy-trading/`. Người dùng là **người mới**: tìm trader trên Hyperliquid, copy trong 3 bước, lệnh khớp trên SoDEX.

Trả lời và viết tài liệu bằng tiếng Việt. Câu chữ trên giao diện, tên field, API, enum, code, commit message bằng tiếng Anh, **chép đúng như design**, không tự dịch hay viết lại.

---

## 1. Đọc trước khi code (theo thứ tự)

1. `CLAUDE.md`: quy tắc sản phẩm 1.1–1.10, thuật ngữ, quy định code. **Bắt buộc.**
2. `docs/DECISIONS.md`: **DEC-161** (bot copy hiện có, tín hiệu leader, khớp lệnh), **DEC-162** (nguồn leader Hyperliquid, đã chấp nhận điều khoản dữ liệu), **DEC-163** (toàn bộ logic v1, đây là spec chính), DEC-105 (paper chỉ từ AI Desk), DEC-108 (thứ tự sidebar), DEC-115 (2FA không bắt buộc).
3. `docs/STRATEGIES.md` mục **S12** và **S12.1**: field spec và bảng mức an toàn.
4. `docs/SCREENS.md` mục **8.x Copy Trading**: route đề xuất ↔ artboard.
5. `docs/OPEN_QUESTIONS.md` câu **20** và **21**: những điểm chưa chốt (xem mục 6 dưới đây).
6. `docs/CODING_STANDARDS.md`, `docs/DESIGN.md`, `docs/ARCHITECTURE.md` mục 3–4, `docs/DOMAIN.md`.
7. Design: `docs/mockups/copy-trading/`
   - `CopyTrade-Roadmap.dc.html`: luồng, phạm vi, ngân sách dữ liệu 1 IP.
   - `Leaders.dc.html` (Find traders), `WalletStats.dc.html` (Trader profile), `CopyBot.dc.html` (Budget and safety), `CopyReview.dc.html` (Review and start), `WhaleWatch.dc.html` (Following), `Sidebar.dc.html` (nhóm "Copy Trading").
   - Lấy **bố cục và câu chữ** từ đây. Số trong mockup là mẫu, không đưa vào code. Giao diện thật dùng `@drift/ui` và design token, không chép style inline của mockup (quy định code 8).
   - Bản gốc trên canvas "AI Desk redesign", hàng "Copy Trading v1" (link trong `CLAUDE.md` nếu bạn đọc được canvas).
8. Code hiện có:
   - `packages/strategies/src/copy-trade/{index,schema}.ts`, `packages/strategies/src/__tests__/copy-trade.test.ts`, `packages/strategies/src/{registry,requirements,index}.ts`
   - `packages/shared/src/{leader,enums}.ts`, `packages/shared/src/api/bots.ts`
   - `apps/marketdata/src/{leaders,main}.ts` (LeaderWatcher, 8 WS leader SoDEX)
   - `apps/engine/src/engine.ts`, `apps/engine/test/engine.test.ts`
   - `apps/api/src/modules/bots/service.ts`
   - `apps/web/src/features/bots/*`, `apps/web/src/app/bots/new/[strategy]/page.tsx`, `apps/web/src/components/workspace-shell.tsx`, `apps/web/messages/en.json`

Không tự bịa quy tắc nghiệp vụ, field API của Hyperliquid / SoDEX, công thức phí hay logic rủi ro. Tài liệu không nói thì chọn cách **an toàn nhất**, ghi vào báo cáo cuối, rồi làm tiếp. **Dừng lại hỏi** khi việc đó đụng tới tiền thật hoặc đổi một DEC đã có.

---

## 2. Tóm tắt những gì phải xây (từ DEC-163)

| Phần | Nội dung |
|---|---|
| **Nguồn leader** | Leaderboard công khai Hyperliquid, tính lại **mỗi ngày** từ fill thật. Endpoint leaderboard không có trong tài liệu chính thức: lấy lỗi thì **giữ danh sách gần nhất** và hiện ngày cập nhật thật. |
| **Thống kê (episode)** | Episode = một vị thế của một market đi từ 0 về 0; đảo chiều = đóng + mở. Profit 30D = Σ realized − phí + funding (**chỉ USD**); unrealized riêng; Worst dip = sụt lớn nhất của đường profit cộng dồn theo giờ (USD); Typical hold = trung vị thời lượng episode đã đóng (< 10 → "Not enough trades"); Win rate = episode PnL ròng > 0 / episode đã đóng (cần ≥ 20); top-trade share; SoDEX coverage; số lần bị thanh lý 30D. Chạm trần 10.000 fill → chỉ ở tab All, gắn "History incomplete". |
| **Lọc và tab** | Ẩn: hold < 15 phút (30D), < 20 episode, vault / HLP, SoDEX coverage < 50%; hiện số đã ẩn và lý do. **Steady** (mặc định) = qua bộ lọc + profit 30D > 0 + top-trade share ≤ 60%, xếp theo profit ÷ worst dip. Các tab khác: Top earners · 30D, Long holders, All. |
| **Bot copy** | **Một bot = một trader × nhiều market**: mặc định mọi market của trader mà SoDEX Perps có. Market trùng bot thật khác cùng account → **bỏ market đó và báo ở Review** (thay phần chặn start của DEC-161). Market mới sau khi start → không tự thêm, báo ở Following. |
| **Mức an toàn** | Careful / Balanced (mặc định) / Bold, map sang field S12 theo bảng S12.1 (`sizing = fixed`). |
| **Khớp lệnh** | Max price move đo từ **giá SoDEX lúc nhận tín hiệu**. Mở = cùng một khoản; tăng / giảm theo tỷ lệ (DEC-161). |
| **Thanh khoản** | Mỗi tín hiệu mở / tăng: tổng notional mọi bot copy cùng trader × market ≤ **50%** độ sâu sổ SoDEX phía đối diện trong khoảng Max price move; vượt thì chia theo tỷ lệ, phần dưới min size → "Skipped" (thanh khoản). Giảm / đóng không bị giới hạn. |
| **minHoldFilter** | Typical hold 30D ≥ 15 phút; không đạt lúc start → chặn; mất điều kiện sau này (kiểm tra mỗi ngày) → ngừng mở mới, vẫn giảm / đóng, báo user. |
| **Hạ tầng 1 IP** | T0 (đang được copy): WS Hyperliquid, tối đa **8 trader** toàn hệ thống; đầy → "Follow · copy later". T1 (có người follow): poll REST **2 phút / lần**, tối đa **~40 ví** toàn hệ thống, **5 ví / user**. T2 (leaderboard): mỗi ngày, rải ban đêm. Ngân sách REST 1.200 weight/phút: T1 ~400, T0 + dự phòng ~300. Mỗi ví theo dõi một lần cho cả hệ thống. |
| **Following** | Gộp fill cùng (ví, market) trong 60 giây thành một thay đổi (open / add / reduce / close / flip / liquidated). Cảnh báo big move trong app (xem mục 6). Hiện độ trễ thật ("checked every 2 min"). |
| **Không có** | "Try with fake money" cho copy (DEC-105); % lợi nhuận; cỡ lệnh theo độ chắc tay; ví SoDEX do team chọn; backtest phát lại; subaccount. |

Quyền truy cập giữ như DEC-161: chỉ tài khoản được bật cờ AI Desk.

---

## 3. Luật an toàn, không được vi phạm

1. **Chỉ giao dịch.** Không code rút tiền hay chuyển tiền. Phần Hyperliquid **chỉ đọc**: không ký, không gửi lệnh, không có key Hyperliquid.
2. Lệnh copy chỉ đi qua engine + gateway hiện có, có `clOrdID` tất định và `Idempotency-Key` cho mọi thao tác đổi trạng thái.
3. **Không retry mù.** Lệnh mở có kết quả không rõ → `unknown`, đối soát trước khi gửi lại. Giảm / đóng giữ đúng logic DEC-161 (reduce-only, thử lại, 3 lần thì pause `ORDER_REJECTED`).
4. **Tín hiệu cũ hơn 5 giây không dùng để mở** (DEC-161). Không copy vị thế leader đã mở trước khi bot start.
5. **Không bịa số** (quy tắc 1.8): thiếu dữ liệu → "Not enough trades" / "History incomplete" / "Not available", **không bao giờ hiện `0`**. Mọi số trên thẻ trader là lịch sử: "Past results, not a forecast."
6. Không vượt ngân sách weight Hyperliquid; có rate limiter dùng chung với DEC-92 nếu cờ đó bật. Không mở quá 8 subscription user trên WS Hyperliquid.
7. Không log secret, payload đã ký hay full key. Địa chỉ ví công khai được log.
8. Test dùng `@drift/sodex-mock` và fixture Hyperliquid ghi sẵn. **Không chạy bot trên mainnet** để kiểm thử.
9. Không thêm dependency ngoài `docs/ARCHITECTURE.md` mục 4 (gọi Hyperliquid bằng `fetch` / WS sẵn có). Cần thêm thì dừng hỏi.
10. Không sửa file trong `.claude/`, không đổi DEC đã có.

---

## 4. Thứ tự làm (mỗi mốc xong thì chạy `pnpm lint`, `pnpm typecheck`, `pnpm test` của phần liên quan)

**Mốc 0 · Kiểm tra dữ liệu, không sửa code.** Xác minh (OPEN_QUESTIONS 21c): giới hạn 10 user / IP của WS Hyperliquid, weight của `userFills` / `userFillsByTime` / `clearinghouseState`, trần ~10.000 fill, cách lấy leaderboard và các trường có trong đó, cách nhận diện vault / HLP. Ghi bảng thông số vào `docs/COPY_TRADING_DATA.md` (ghi nguồn và ngày đo). Không có mạng thì ghi rõ chưa đo, dùng số trong DEC-163 và đi tiếp.

**Mốc 1 · Engine thống kê (thuần, không I/O).** Module trong `packages/shared` (ví dụ `src/leader-stats/`): fill → episode → các chỉ số ở mục 2, bộ lọc, Steady, top-trade share, SoDEX coverage (nhận danh sách market SoDEX làm tham số), `historyIncomplete`. Dùng `decimal.js`. **Unit test đầy đủ**: đảo chiều, tăng / giảm từng phần, vị thế còn mở, funding, phí, < 10 / < 20 episode, chạm trần.

**Mốc 2 · Nguồn leader Hyperliquid (T2).** Job hằng ngày (trong `apps/jobs` hoặc `scheduler`, theo ARCHITECTURE): lấy leaderboard, đọc fill 30 ngày từng ví, tính thống kê, lưu snapshot. Migration Drizzle cho bảng mới (đề xuất: ứng viên leader, snapshot thống kê theo ngày, sự kiện vị thế, follow của user). Lỗi leaderboard → giữ snapshot cũ. Có test với fixture.

**Mốc 3 · Theo dõi realtime (T0) và poll (T1).** Mở rộng `apps/marketdata/src/leaders.ts` cho nguồn `hyperliquid`: T0 WS tối đa 8 ví (chỉ ví có bot copy đang chạy), giữ vị thế như LeaderBook, publish `leader.hyperliquid.<addr>.fill|position`. T1 poll 2 phút cho ví được follow (≤ 40 toàn hệ thống). Gộp fill 60 giây thành sự kiện, lưu lại cho Trader profile và Following. Đổi trader không rớt tín hiệu: mở subscription mới trước, đóng cái cũ sau. API trả trạng thái chỗ copy (còn chỗ / hết chỗ / trader đã có người copy).

**Mốc 4 · Bot copy nhiều market (việc lớn nhất).** Engine hiện chạy theo mô hình bot một market:
- Đổi schema S12: `market` → `markets[]`, kèm migration cho config cũ (một market → mảng một phần tử). Mỗi market có vị thế, trần exposure và trạng thái riêng; `maxExposure` là trần tổng.
- Market trùng bot khác cùng account: bỏ market đó (API trả danh sách market bị bỏ + lý do), không chặn start.
- Max price move tính từ giá SoDEX lúc nhận tín hiệu.
- **Giới hạn thanh khoản 50%**: phải phân bổ ở **một chỗ duy nhất** cho mỗi tín hiệu (engine chạy nhiều shard, nên không để mỗi bot tự tính). Đề xuất phân bổ ở nơi fan-out tín hiệu, gửi kèm hạn mức cho từng bot. Ghi rõ cách đã chọn vào DEC mới.
- minHoldFilter: kiểm tra lúc start và mỗi ngày.
- Unit test cho strategy thuần và test engine cho: nhiều market, bỏ market trùng, chia thanh khoản, tín hiệu muộn, minHold.

**Mốc 5 · API.** Theo route đề xuất ở SCREENS 8.x (OPEN_QUESTIONS 21b chưa chốt: dùng tạm, ghi vào báo cáo). Endpoint cho: danh sách trader theo tab + lý do ẩn, hồ sơ trader (chỉ số, checklist good fit, sự kiện gần đây), follow / unfollow (≤ 5 / user), Following feed, trạng thái chỗ copy, tạo bot copy từ budget + mức an toàn (server tính field S12 theo bảng S12.1, không tin client). Parse mọi dữ liệu vào bằng zod; lỗi theo format C6.

**Mốc 6 · Giao diện web.** 5 màn theo mockup + nhóm "Copy Trading" ("Find traders", "Following") ngay sau Strategy Lab trong sidebar (giữ DEC-108). Câu chữ đưa vào `apps/web/messages/en.json` (chuỗi mới vào `_pendingReview`). Mỗi màn đủ 4 trạng thái: loading (skeleton), empty, error, có dữ liệu. Responsive 1440 và 390. Kiểm tra a11y (`pnpm --filter @drift/ui test:a11y` cho component mới).

**Mốc 7 · Cảnh báo big move.** Chỉ trong app. Điều kiện ở DEC-163 mục 11. **Ngưỡng USD tối thiểu chưa chốt** (OPEN_QUESTIONS 21a): đọc từ config, không có giá trị thì **tắt cảnh báo**, không tự chọn số.

**Mốc 8 · E2E và tài liệu.** E2E cho luồng: Find traders → Trader profile → Budget and safety → Review → bot chạy (SoDEX mock, fixture Hyperliquid); hết chỗ copy → "Follow · copy later"; market trùng bị bỏ. Cập nhật `docs/STRATEGIES.md` S12, `docs/SCREENS.md`, `docs/DOMAIN.md` (bảng mới) nếu code khác tài liệu. Ghi **một DEC mới** cho những lựa chọn lúc code (ghi "chọn theo khuyến nghị, chờ duyệt").

---

## 5. Definition of done

- Đạt mục 14 của `docs/CODING_STANDARDS.md`.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` pass; E2E Copy Trading pass.
- Không còn chuỗi UI viết thẳng trong component; không có mã hex trong component.
- Mọi luật ở mục 3 có test hoặc có lý do rõ ràng trong báo cáo vì sao chưa test được.

---

## 6. Điểm chưa chốt: cách xử lý

| Điểm | Xử lý trong đợt này |
|---|---|
| Ngưỡng USD của big move (21a) | Config, mặc định tắt |
| Route (21b) | Dùng route đề xuất ở SCREENS 8.x, ghi vào báo cáo |
| Giới hạn Hyperliquid (21c) | Đo ở Mốc 0; số khác DEC-163 thì **dừng hỏi** trước Mốc 3 |
| Câu 20 (SoDEX leaderboard, WS partner, subaccount) | Không thuộc v1, không làm |

---

## 7. Báo cáo cuối

Viết bằng tiếng Việt, gồm:
1. Đã làm gì theo từng mốc, file chính đã đổi.
2. Lệnh test đã chạy và kết quả **thật** (fail thì dán output).
3. Lựa chọn tự đưa ra khi tài liệu không nói, và DEC đã ghi.
4. Việc còn lại, rủi ro, câu hỏi cần người dùng chốt.

**Git:** làm theo `docs/AGENT_WORKFLOW.md`: tạo branch từ `origin/main`, commit theo Conventional Commits, push branch, mở PR vào `main` rồi dừng chờ review. Không push thẳng lên `main`, không tự merge. DEC mới ghi dạng `DEC-TBD-<slug>`.
