# DRIFT — Danh sách sửa UI theo thiết kế (review 2026-10-28)

> So app chạy ở `http://localhost` với canvas "DRIFT Redesign" (render từng artboard `.dc.html`), cùng khổ 1440×900 và 375×812. Tài khoản test chưa kết nối SoDEX nên chỉ xem được trạng thái trống.
>
> Làm theo thứ tự dưới đây. Mỗi mục có: artboard đối chiếu, chỗ sửa dự kiến, tiêu chí xong. Không đổi câu chữ UI ngoài những gì thiết kế có. Thiếu chi tiết khoảng cách/kích thước thì đọc lại artboard qua công cụ Artifact (DEC-31) hoặc hỏi người dùng, không đoán.
>
> Khi sửa xong một mục: đánh dấu `[x]`, ghi file đã đổi. Nếu một mục mâu thuẫn với `docs/DECISIONS.md` thì quyết định thắng; ghi lại ở mục "Không sửa".

## A. Lỗi chung (ảnh hưởng mọi màn — làm trước)

- [x] **A1. Nạp font Plus Jakarta Sans.**
  - Đã sửa (2026-10-28): `apps/web/src/app/layout.tsx` (`next/font/google`, biến `--font-jakarta` gắn trên `<html>`), `packages/ui/src/styles/tokens.css` (`--font-sans: var(--font-jakarta, "Plus Jakarta Sans"), …`). Storybook vẫn nạp font qua `.storybook/preview-head.html` và dùng tên dự phòng trong token. Kiểm tra bằng Playwright trên `next start`: Plus Jakarta Sans 400/600/700/800 `loaded`, không lỗi CSP.
  - Hiện trạng: `packages/ui/src/styles/tokens.css:43` khai báo `--font-sans: "Plus Jakarta Sans"…` nhưng không có `next/font` hay `@font-face`; `document.fonts` rỗng, trình duyệt dùng font hệ thống.
  - Sửa: dùng `next/font/google` (weight 400, 500, 600, 700, 800; `display: swap`) trong `apps/web/src/app/layout.tsx`, gắn biến CSS và trỏ `--font-sans` vào biến đó. `next/font` tự host file nên không cần mở CSP `font-src`.
  - Xong khi: `document.fonts` có Plus Jakarta Sans trạng thái `loaded`; Storybook của `packages/ui` cũng dùng đúng font.

- [x] **A2. Khung app (sidebar + hàng tiêu đề) theo artboard `Main.dc.html`.**
  - Sidebar là **thẻ trắng nổi**, không phải cột phẳng cao hết màn: cách mép 12–16 px, bo góc lớn (radius thẻ như các card khác), viền `#E3E7F5`.
  - Logo: ô vuông bo góc nền xanh primary có icon biểu đồ, cạnh chữ "DRIFT" + "Profit Bot workspace".
  - Mục đang chọn: **nền xanh primary đặc, chữ và icon trắng**, có bóng nhẹ (hiện tại là nền xanh nhạt).
  - "Builder Revenue" (chỉ role `team`) và "Settings" nằm sau một đường kẻ, tách khỏi nhóm điều hướng chính.
  - Thẻ **Emergency** (nền đỏ nhạt, viền đỏ, nút "Halt all agents…") nằm ở **cuối sidebar**, không nằm trong nội dung Overview.
  - **Bỏ thanh trắng trên cùng.** Hàng tiêu đề nằm trong vùng nội dung: tiêu đề trang + mô tả bên trái; bên phải là chọn account ("Main account" ▾), chip `LIVE · MAINNET`, chip trạng thái SoDEX ("SoDEX connected" / chưa kết nối), "Updated Xs ago", nút chuông, avatar (menu avatar chứa email và Sign out).
  - Chỗ sửa: `AppShell` trong `packages/ui`, `apps/web/src/components/workspace-shell.tsx`.
  - Xong khi: chụp Overview cạnh `Main.dc.html` ở 1440 px thấy cùng cấu trúc khung.
  - Đã sửa (2026-10-28, DEC-48): `packages/ui/src/components/app-shell.tsx` (sidebar thẻ nổi, `NavItem.group`, `sidebarFooter`, `headerExtras` + `ShellHeaderExtras`, bỏ `topBar`), `page-header.tsx`, `styles/tokens.css` + `theme.css` (token `--neg-soft/-border/-deep/-text`, `--shadow-accent`, `--shadow-float`), story + test AppShell; `apps/web/src/components/workspace-shell.tsx` (logo, cụm trạng thái, menu account/avatar, thẻ Emergency), `workspace.tsx` (`PageHead`), header của Overview/Portfolio/Risk/Analyst/Revenue/Agent/Bots/Orders/Edit/Settings (bỏ LIVE trùng, bỏ thẻ Emergency khỏi Overview), Settings đọc `?tab=`, `messages/en.json` (`common.shell.*`), E2E `p11-auth-gate` (Sign out trong menu avatar), `docs/DESIGN.md` (token mới). Đã chụp 1440 px: cùng cấu trúc khung với Main.

- [x] **A3. Thanh điều hướng mobile theo `Mobile-Home.dc.html`.**
  - Hiện trạng: 8 tab, nhãn bị cắt ("Ove…", "Port…").
  - Sửa: 5 mục — Home, Portfolio, **Agent** (nút tròn nổi ở giữa, nền primary), Strategy, More. "More" mở danh sách các trang còn lại (Execution & Orders, Risk Center, AI Analyst, Builder Revenue nếu `team`, Settings).
  - Xong khi: ở 375 px không nhãn nào bị cắt; mọi trang vẫn tới được trong ≤ 2 lần chạm.
  - Đã sửa (2026-10-28): `packages/ui/src/components/app-shell.tsx` (`MobileNav`, `MobileBottomNav`: mục nổi giữa, "More" mở `BottomSheet`), test trong `special.test.tsx`; `apps/web/src/components/workspace-shell.tsx` (Home · Portfolio · Agent · Strategy · More), `messages/en.json` (`common.nav.mobile.*`). Kiểm tra 375 px: 5 nhãn không bị cắt, More › Risk Center tới `/risk` sau 2 lần chạm, "More" được tô khi đang ở trang trong danh sách.

## B. Từng màn

- [x] **B1. Create bot — bố cục theo `Create.dc.html`** (`apps/web/src/features/bots/components/create-bot.tsx`, `visual-panel.tsx`, `bot-form.tsx`).
  - Hai cột: **trái (flex 3) = phần trực quan**, **phải (flex 2) = Settings**. Hiện app đang đảo: form + tab ở trái, "Before it starts" tách thành cột phải.
  - Cột trái: tiêu đề `{visTitle}` + dòng market/last price; tab Preview / Backtest; ở Preview là biểu đồ của chiến lược (grid: dải range, các mức, đường Stop đỏ nét đứt, nhãn Upper / Lower / Last / Stop; DCA: thang lệnh; …) và hàng ô chỉ số (Per level, Step, Orders at start, Round-trip fees…).
  - Chưa chọn market: vẫn giữ khung biểu đồ, hiện trạng thái trống (không vẽ số giả).
  - Cột phải, từ trên xuống: banner AI ("✦ Filled by AI" + "Clear parameters", hoặc thanh "✦ AI parameters"), nhóm Market, Parameters, Risk & exits, rồi checks "Before it starts", checkbox xác nhận, 2FA, "Save draft" / "Start on mainnet" ở cuối cột.
  - Field: có đơn vị bên trong ô (`USDT`, `%`), chip "AI" cạnh label khi giá trị do AI điền, dòng gợi ý dưới ô ("9.3% below last price", "2–200 · step …"). Segmented control (Arithmetic / Geometric…) rộng hết cột.
  - **Không hiện giá trị enum thô**: Preview đang hiện `arithmetic`, `keep_base` — phải dùng label i18n ("Arithmetic", "Keep base asset").
  - Header: chip engine (`Spot` / `Perps`) đứng trước chip LIVE, cạnh "Paper · Coming soon".
  - Xong khi: cả 8 chiến lược (và Volume Maker khi bật cờ) dùng đúng bố cục; chụp cạnh artboard thấy cùng thứ tự phần tử; ở mobile hai cột xếp chồng như `M-Create-*.dc.html`.
  - Đã sửa (2026-10-28, DEC-49): `create-bot.tsx` (cột trái flex 3 / phải flex 2, header chip engine → LIVE → Paper, gợi ý động), `visual-panel.tsx` (tiêu đề `{visTitle}` + dòng giá, tab Preview/Backtest), mới `preview-visual.tsx` (grid: dải, mức, Stop đỏ nét đứt, nhãn Upper/Lower/Last/Stop; DCA: thang lệnh; Recurring Buy: lịch mua; Rebalancing: tỷ trọng; Funding Arb: hai chân; TWAP: lát; hàng ô chỉ số; chưa đủ dữ liệu thì giữ khung + trạng thái trống), mới `features/bots/preview.ts` + test (công thức giống engine), `bot-form.tsx` (một cột, tiêu đề nhóm, "Market & leverage", segmented rộng hết cột, gợi ý dưới ô), `ai-params.tsx` (banner AI), `packages/ui` `Field` (đơn vị trong ô) + `SegmentedControl` (`fullWidth`); API mới `GET /api/v1/markets/:market/last` (+ test). Preview không còn hiện enum thô. Đã chụp Spot Grid, Spot DCA ở 1440 và 375.
  - Khác với mô tả ở trên: "Before it starts" (checks, xác nhận, 2FA, Save draft / Start) đặt **dưới hai cột, rộng hết trang** như artboard Create, không nằm trong cột phải. Ô "Liquidation · From SoDEX", "Funding", đường giá 7 ngày chưa hiện vì chưa có API trả dữ liệu này (không vẽ số giả). Volume Maker (cờ tắt) hiện trạng thái trống ở Preview.

- [x] **B2. Overview — hero theo `Main.dc.html`.**
  - Thẻ hero gradient (`#E3E8FE → #CBD5FB`, có vòng tròn trang trí): "Welcome back", "Account value (equity)", số lớn + `USDC`, dòng thay đổi trong kỳ; nút chọn kỳ **24H / 7D / 30D / All** ở góc phải hero; 4 ô chỉ số (Unrealized PnL, Realized PnL, Available balance, Margin in use) nằm **trong** hero.
  - Khi chưa có dữ liệu vẫn giữ hero, các số hiện "Not available".
  - Thẻ "Trading Agent" (bot đang chạy nổi bật) cạnh Performance như thiết kế.
  - "Connect SoDEX" phải là **nút primary**, không phải chữ thường.
  - Đã sửa (2026-10-28, DEC-50): `overview-page.tsx` (hero gradient + vòng tròn trang trí, Welcome back, equity + USDC, dòng thay đổi trong kỳ = điểm cuối − điểm đầu chuỗi snapshot, nút kỳ 24H/7D/30D/All trong hero, 4 ô chỉ số trong hero, "Not available" khi thiếu; thẻ Trading Agent cạnh Performance; Risk + Watchlist một hàng; "New bot" primary có `+`), mới `components/not-connected.tsx` (nút primary **Connect SoDEX**), `Card` có viền; API `GET /api/v1/overview?period=all` (+ test; realized trả null khi chạm giới hạn 1000 dòng).
  - Chưa làm: nút Pause trong thẻ Trading Agent (Pause vẫn ở `/agent/:id`, nơi có trạng thái chuyển tiếp); dòng "Up 3d 4h" (backend chưa trả thời gian chạy) — thẻ hiện "Updated {time}" và Last action từ sự kiện thật.

- [x] **B3. Strategy Lab theo `Bots.dc.html`.**
  - Số đếm trên tab dạng badge ("My bots [6]", "Strategy catalog [9]").
  - Nút "New bot" có icon `+`.
  - Có cả filter **Status** và **Engine**, nằm trong thẻ chứa bảng.
  - Danh sách bot là bảng: Bot, Strategy, Mode, Status, Profit, Capital, hành động (Open/Resume/View/Continue, Edit/Duplicate/Delete, menu ⋯).
  - Đã sửa (2026-10-28, DEC-50): `bots-page.tsx` (badge số đếm trên tab, "New bot" có `+`, filter Status + Engine trong thẻ chứa bảng, cột Capital, nút Open/Resume/View/Continue + Edit dạng nút, thẻ catalog theo artboard), API `BotSummary.capital` (`requirementOf`, + test).
  - **Chưa làm: menu ⋯ (Duplicate · Rename · Archive · Delete)** — API chưa có các thao tác này; cần thêm endpoint và quy tắc trạng thái (Archive chỉ bot đã stop, Delete chỉ draft) → chờ duyệt.

- [x] **B3b. Strategy Lab › tab Strategy catalog theo `Bots.dc.html`** (bổ sung 2026-10-28, từ ảnh chụp của người dùng ở khổ ~2000 px).
  - **Tràn ngang:** hàng tiêu đề và lưới thẻ rộng hơn màn hình: avatar bị cắt ở mép phải, cột thẻ thứ ba bị cắt. Trang không được cuộn ngang ở bất kỳ khổ nào (≥ 375 px). Kiểm tra `min-width: 0` cho vùng nội dung (`flex: 999 1 560px; min-width: 0` như artboard) và cho từng ô lưới.
  - **Hàng tiêu đề:** các phần tử bên phải phải xuống dòng (`flex-wrap`) khi thiếu chỗ, không đẩy ra ngoài. Ở artboard Strategy Lab, nút **"+ New bot" nằm cuối cùng bên phải**, sau chip `LIVE · MAINNET`; hiện app đặt "New bot" đứng đầu, trước "Main account".
  - **Lưới:** `grid-template-columns: repeat(auto-fit, minmax(300px, 1fr))`, `gap: 16px`. Thẻ cao bằng nhau trong một hàng.
  - **Thẻ** (`article`): nền trắng, viền `1px #E3E7F5`, radius 22 px, padding 18×20 px, `gap: 10px`, chia ba phần:
    - Hàng đầu: **chip nhóm** bên trái (GRID, DCA, ACCUMULATE, PORTFOLIO, ARBITRAGE, EXECUTION, EVENT; 11 px, đậm 800, giãn chữ 0.06em, bo tròn, mỗi nhóm một màu) và **chip engine** bên phải (`Spot` xanh `#E6ECFE`/`#1D47B8`, `Perps` tím `#F0E6FF`/`#5A2CA0`, `Spot + Perps` nền `#141A33` chữ trắng). Hiện app chỉ có chữ xám, không chip, không có engine.
    - Màu chip nhóm: GRID `#FFE3C7`/`#5C2E00`; DCA `#CDF1EC`/`#003D37`; ACCUMULATE và PORTFOLIO `#E6ECFE`/`#1D47B8`; ARBITRAGE `#F0E6FF`/`#5A2CA0`; EXECUTION `#EDEFF5`/`#3B4262`; EVENT `#141A33`/trắng. Đưa các màu này thành token, không viết mã hex trong component.
    - Tên 18 px đậm 800; mô tả 14 px, line-height 1.5, màu `#1F2645`.
    - **Fits / Risk là lưới hai cột** (`auto 1fr`, 13 px): nhãn "Fits" xanh lá `#0B6A39`, "Risk" nâu `#7A3E00`, nội dung màu `#3B4262`. Hiện app viết liền một dòng, nhãn đen.
    - **"Set up …" là nút** rộng hết thẻ, cao 44 px, radius 12, nền `#E6ECFE`, chữ `#1D47B8` đậm 700, căn giữa, luôn nằm đáy thẻ (`margin-top: auto`). Hiện app là chữ đen to, không phải nút.
  - **Cỡ chữ:** ảnh chụp cho thấy chữ thẻ to hơn artboard (mô tả và "Set up" đang ~18–20 px). Dùng đúng thang chữ ở trên.
  - **Tab:** số đếm dạng badge (xem B3). Thẻ thứ 9 Volume Maker hiện dạng "Coming soon" khi cờ tắt (DEC-38), không ẩn hẳn, để số trên tab khớp số thẻ.
  - Lưu ý: artboard render thành "Set upSpot Grid" (mất dấu cách) là lỗi của artboard; app giữ "Set up Spot Grid".
  - Xong khi: chụp ở 1440 px và 2000 px cạnh artboard thấy cùng cấu trúc thẻ; không có thanh cuộn ngang; ở 375 px thẻ xếp một cột.
  - Đã sửa (2026-10-28): `bots-page.tsx` (chip nhóm theo màu artboard, chip engine Spot / Perps / Spot + Perps, mô tả `--ink-body`, nhãn Fits `--fits`, "+ New bot" đứng cuối cụm bên phải, badge số đếm trên tab theo artboard, `min-w-0` cho header và thẻ), `components/workspace.tsx` (`PageHead`: nút riêng của trang đứng sau cụm trạng thái), token mới `--cat-grid-ink`, `--cat-dca-ink`, `--cat-exec-bg`, `--fits`, `--ink-body` (`tokens.css`, `theme.css`, `DESIGN.md`). Lưới, Fits/Risk hai cột và nút "Set up …" đã có từ B3.
  - Không làm: thẻ Volume Maker "Coming soon" khi cờ tắt — DEC-43 (mới hơn DEC-38) bỏ hẳn Volume Maker khỏi catalog khi cờ tắt; số trên tab đã khớp số thẻ (8).

- [x] **B4. Trạng thái chưa kết nối SoDEX (Risk Center, Trading Agent, Execution & Orders, Portfolio, Overview).**
  - Hiện trạng: Risk Center và Trading Agent còn mỗi một dòng chữ; Orders mất filter/tab.
  - Sửa: giữ khung trang (tiêu đề section, filter, tab, header bảng) theo artboard tương ứng; khối thông báo dùng chung một component có nút primary **Connect SoDEX** dẫn tới `/onboarding/connect`.
  - Xong khi: mọi trang trên có cùng một khối "chưa kết nối" và vẫn nhận ra được bố cục của trang.
  - Đã sửa (2026-10-28): `components/not-connected.tsx` (`NotConnected` + `useSodexMissing`) dùng ở Overview, Portfolio, Risk Center, Trading Agent, Execution & Orders; Risk giữ Limits/Alerts/Emergency halt với "Not available"; Agent giữ Decisions & actions (header bảng) + Configuration; Orders viết lại theo artboard (ô đếm, tab History/Open/Fills/Failed & unknown, filter Symbol/Side/Time, cột Source; ô đếm "Not available" khi chưa kết nối hoặc danh sách bị cắt 200 dòng); `DataTable` giữ header khi rỗng.

## C. Không sửa (khác thiết kế nhưng đúng quyết định)

- Signup chỉ email, không "Continue with wallet", không mật khẩu (DEC-28, DEC-31).
- Kết nối SoDEX hai chữ ký (DEC-25); không có nút chọn Testnet (DEC-23).
- Field số để trống cho tới khi bấm AI parameters (DEC-38).
- Volume Maker ẩn / Coming soon (DEC-43).

## D. Chưa review

Account dùng để review (vòng 2) **chưa có bot nào**, nên chưa xem được: danh sách bot có dữ liệu, chi tiết Trading Agent (`/agent/:botId`), Edit bot, kết quả Backtest, Recent activity có dữ liệu. Account này là account builder (DEC-47) nên chưa xem được trạng thái approve / revoke builder fee. Builder Revenue cần role `team`. Review lại khi có account có bot đang chạy.

## E. Review vòng 2 — account có dữ liệu (2026-10-28)

> Đăng nhập account đã kết nối SoDEX (#1645, equity ~45 USDC, 0 vị thế, 0 bot). Xem ở 1440, 1920, 1024 và 375 px, so với `Main`, `Portfolio`, `Orders`, `Risk`, `Analyst`, `Agent`, `Connections`, `Bots`, `Create`, `Mobile-Home`, `M-Portfolio`, `M-Risk`, `M-Create-SGrid`.
>
> Tình trạng mục cũ: A1 đạt. A2 **đạt một phần**: sidebar dạng thẻ, logo, mục đang chọn tô xanh và thẻ Emergency đã đúng; hàng tiêu đề còn lỗi (E1). Không còn tràn ngang ở 1024 / 1440 / 1920 px. A3, B1, B2, B3, B3b, B4 **chưa làm**: giao diện vẫn như vòng 1.

### E1. Chung

- [x] **E1.1 Hàng tiêu đề bị rớt xuống dưới tiêu đề** ở Portfolio, Execution & Orders, Risk Center, Trading Agent, Strategy Lab, AI Analyst (Overview và Settings thì đúng). Thiết kế: tiêu đề + mô tả bên trái, cụm chip bên phải **cùng hàng**; chỉ xuống dòng khi thật sự thiếu chỗ. Nguyên nhân có thể là dòng phụ ("Positions updated …", "Risk engine checked …") hoặc nút "New bot/New agent" bị nhét vào cùng cụm chip. Dòng phụ đặt thành chip "Updated …" như artboard (`Portfolio.dc.html`: "Positions updated 14:02:09"), không thêm chip thứ hai.
  - Đã sửa (2026-10-28, DEC-54): mọi trang dùng `PageHead` (`components/workspace.tsx`): khối tiêu đề co lại (`flex: 1 1 320px; min-width: 0`), cụm bên phải `flex-wrap` căn phải; prop `updated` đổi dòng phụ thành chip ("Positions updated …", "Risk engine checked …") thay chip "Updated Xs ago" chung; prop `action` đặt "+ New bot" / "+ New agent" cuối cụm (có icon `+`, New agent mở Strategy catalog qua `/bots?tab=catalog`). Theo artboard, cụm đầy đủ (Main account, Updated, chuông, avatar) chỉ ở Overview; các trang khác chỉ LIVE + SoDEX + chip/nút của trang. Orders, Agent, Settings, Edit, Strategy Lab bỏ header tự viết. Đã chụp 1440 / 375 (chưa kết nối SoDEX): cùng hàng, không cuộn ngang. Chưa chụp được trạng thái đã kết nối vì account thật bật 2FA.
- [x] **E1.2 Hàng tiêu đề trên mobile chiếm ~250 px** (4 hàng: account, LIVE, SoDEX, Updated, chuông, avatar) trước khi tới nội dung. Thiết kế mobile (`Mobile-Home`, `M-Portfolio`, `M-Risk`): chỉ một hàng gọn, chip `LIVE` nhỏ bên phải tiêu đề, trạng thái SoDEX dạng chữ nhỏ "● SoDEX · 12s ago". Chọn account, chuông, avatar chuyển vào menu "More" / màn Settings.
  - Đã sửa (2026-10-29): `PageHead` mobile: một hàng tiêu đề 24 px + chip `LIVE` nhỏ, dòng "● SoDEX · 12s ago" dưới tiêu đề (artboard Mobile-Home, M-Portfolio); chọn account, thông báo, email + Sign out chuyển xuống cuối sheet More (`MobileNav.more.footer` trong `packages/ui` AppShell). Key mới `common.badges.liveShort`, `common.shell.sodexAgo*` (chép từ artboard).
- [x] **E1.3 Đang tải mà hiện "Not available".** Ở mobile Overview, Risk snapshot và Watchlist hiện "Not available" trong ~5 giây đầu, sau đó mới ra dữ liệu. Đang tải phải là skeleton; "Not available" chỉ dùng khi backend trả về là không có (quy tắc 1.8, DESIGN.md D5).
  - Đã sửa (2026-10-29): Overview: hero, ô chỉ số, Performance, Risk snapshot, Watchlist, My Profit Bots, Recent activity hiện `Skeleton` khi đang tải; "Not available" chỉ khi backend trả không có. Portfolio mobile hero cũng vậy.
- [x] **E1.4 Tải chậm và gọi API lặp.** Một lần vào trang gọi `GET /me`, `/sodex/connection`, `/notifications` 3–4 lần mỗi cái; dữ liệu ra sau 5–8 s. Gom về một query key dùng chung (TanStack Query), đặt `staleTime` hợp lý, không refetch theo từng component con.
  - Đã sửa (2026-10-29): `lib/queries.ts` (`useMe`, `useSodexConnection`, `useNotifications`) thay cho các `useQuery` rải rác (16 file), một key mỗi tài nguyên + `staleTime`; QueryClient mặc định `staleTime: 15s` nên component con không refetch khi mount. Thông báo chỉ tải khi có chuông (Overview / sheet More). Chưa đo lại thời gian tải với account thật (2FA).
- [x] **E1.5 Định dạng số.** Có chỗ không có dấu phân cách hàng nghìn (Watchlist `80761`, phải là `80,761.xx`). Số dư spot hiện 15–18 chữ số thập phân (`0.000000982052580096`). Dùng một helper format chung: giá theo tick size, khối lượng theo lot size, tiền tệ 2 chữ số; số quá nhỏ hiện `< 0.0001` kèm tooltip giá trị đầy đủ.
  - Đã sửa (2026-10-29): `formatAmount` (`lib/format.ts`): phân cách hàng nghìn, giá theo tick, khối lượng theo lot (`tickSize`/`stepSize` từ `GET /api/v1/markets`), số < 0.0001 hiện "< 0.0001" kèm tooltip giá trị đầy đủ; áp dụng ở Portfolio, Orders, Watchlist. Có unit test.
- [x] **E1.6 Tên symbol thô.** Market và tài sản hiện mã nội bộ SoDEX (`vBTC_vUSDC`, `vUSDC`, `vMAG7.ssi`). Thiết kế hiện `BTC/USDC`, `BTC-PERP`, kèm tên đầy đủ dòng dưới ("Bitcoin perpetual"). Cần một hàm display name dùng chung; giá trị gửi API giữ nguyên mã gốc. Nếu không chắc cách đổi tên một mã nào đó (vd `.ssi`) thì hỏi, không đoán.
  - Đã sửa (2026-10-29): `lib/markets.ts` (`useMarketNames`): market dùng `displayName` của SoDEX (`vBTC_vUSDC` → `BTC/USDC`; perps SoDEX trả `BTC-USD`), tài sản lấy theo base/quote của market spot (`vBTC` → `BTC`, `vUSDC` → `USDC`); coin không có market (vd `vMAG7.ssi`, `WSOSO`) giữ nguyên mã. `GET /api/v1/markets` thêm `displayName`, `base`, `quote`, `tickSize`, `stepSize`, `trading`. Áp dụng ở Portfolio, Orders, Overview, Strategy Lab, Trading Agent, Create (tiêu đề, đơn vị, Preview), onboarding (analysis, plan). Tên đầy đủ ("Bitcoin perpetual") SoDEX không cung cấp nên không hiện (không đoán).

### E2. Overview (`Main.dc.html`, `Mobile-Home.dc.html`)

- [x] Vẫn thiếu hero (B2). Ô "Realized PnL" giá trị `−131.44 USDC` bị xuống hai dòng; số trong ô chỉ số không được ngắt dòng.
  - Đã sửa (2026-10-29): Hero đã có (B2); số trong ô chỉ số `white-space: nowrap`.
- [x] Performance: biểu đồ chỉ là một đường mảnh. Thiết kế có trục Y (giá trị), trục X (thời gian), vùng tô dưới đường, đường "Net deposits" nét đứt (ở đây Not available thì ẩn và ghi chú như hiện tại), chú thích Equity, tooltip khi rê chuột. Nút kỳ: thiết kế là `24H / 7D / 30D / All` đặt ở hero; app là `1D / 7D / 30D` trong thẻ Performance.
  - Đã sửa (2026-10-29): `EquityChart` (`charts.tsx`): trục Y 4 mốc, trục X 5 mốc, vùng tô, chú thích Equity, tooltip khi rê / chạm; dòng phụ "Equity, USDC · {kỳ}"; Net deposits vẫn ghi chú Not available. Nút kỳ 24H / 7D / 30D / All ở hero (B2).
- [x] Thiếu thẻ **Trading Agent** cạnh Performance. Khi chưa có bot: hiện thẻ trống có nút "Create a bot" dẫn tới Strategy Catalog.
  - Đã sửa (2026-10-29): Thẻ Trading Agent cạnh Performance; chưa có bot thì thẻ trống có icon + nút primary "Create a bot" → `/bots?tab=catalog`.
- [x] Risk snapshot: thiết kế có **thanh tiến độ** cho từng giới hạn và badge "Within limits" ở góc; app chỉ có chữ. Khi "Limit not set" thì thanh xám + link "Set limit".
  - Đã sửa (2026-10-29): Mỗi giới hạn có `Meter` (xanh / cam khi ≥ 80% hoặc UI warning), badge "Within limits" / "N limits breached" ở góc; "Limit not set" thì thanh xám + link "Set limit".
- [x] Watchlist: thiếu avatar coin, tên đầy đủ, sparkline 24h; giá chưa định dạng (E1.5).
  - Đã sửa (2026-10-29): Avatar chữ cái, tên tài sản + market, sparkline 24h (API overview trả 24 nến 1h trong cùng một request, field `spark`), giá theo tick. Tên đầy đủ (Bitcoin…) không có từ SoDEX nên không hiện.
- [x] My Profit Bots: "New bot" đang là chữ thường; thiết kế có nút "+ New bot" ở đầu section và các thẻ bot. Khi trống: thẻ empty có nút.
  - Đã sửa (2026-10-29): Hàng tiêu đề có nút "+ New bot"; thẻ bot (avatar, tên, market, trạng thái, Investment, Profit); trống thì thẻ empty có nút "Create a bot".
- [x] Recent activity: thiết kế có badge loại (FILL, UNKNOWN, CONFIG, RISK) và link "All orders & events →" ở góc phải tiêu đề.
  - Đã sửa (2026-10-29): Badge loại theo `bot_events.type` (CONFIG, RISK, ERROR, FILL, UNKNOWN…; nhãn ở `overview.activityTypes`, chờ duyệt), link "All orders & events →" ở góc phải tiêu đề.

### E3. Portfolio (`Portfolio.dc.html`, `M-Portfolio.dc.html`)

- [x] Thiếu tab **Open positions / Spot holdings / Pending orders** (có badge đếm), ô tìm symbol và filter Side. App đang xếp "No open positions" và bảng spot chồng lên nhau trong cùng thẻ.
  - Đã sửa (2026-10-29): Viết lại `portfolio-page.tsx`: tab có badge đếm, ô tìm symbol + filter Side (tab Open positions), Spot holdings, Pending orders (khối giữa thẻ + nút Open Execution & Orders).
- [x] Thiếu thẻ **Exposure** bên phải (thanh theo tài sản, chú thích Long / Short, ghi chú concentration). Không có vị thế thì hiện empty trong thẻ, không bỏ thẻ.
  - Đã sửa (2026-10-29): Thẻ Exposure luôn hiện bên phải (flex 3 / 1): thanh theo market, sọc cho Short, chú thích Long / Short (striped), khối concentration; không có vị thế thì trạng thái trống trong thẻ.
- [x] Ô "Margin in use" thiếu thanh tiến độ.
  - Đã sửa (2026-10-29): `Meter` dưới giá trị + "{amount} USDC of margin".
- [x] Dòng "Not included in equity (no price yet): …" nằm trơ giữa trang; chuyển thành ghi chú trong thẻ Equity hoặc banner thông tin nhỏ.
  - Đã sửa (2026-10-29): Chuyển thành ghi chú trong thẻ Equity, tên tài sản theo E1.6.
- [x] Mobile: thiết kế có hero equity + 3 ô nhỏ, tab dạng pill, mỗi vị thế là một **thẻ** (Size, Entry → mark, Unrealized PnL, Liquidation, nút Details). App dùng bảng cuộn ngang.
  - Đã sửa (2026-10-29): Mobile: hero equity + 3 ô (Unrealized, Available, Margin used), tab pill "Positions · N / Spot · N / Orders · N", mỗi vị thế một thẻ (Size, Entry → mark, Unrealized PnL, Liquidation). Nút Details chưa làm (chưa có màn chi tiết vị thế).

### E4. Execution & Orders (`Orders.dc.html`, `M-Orders.dc.html`)

- [x] Khi chưa có lệnh vẫn phải có: 4 ô chỉ số (Open, Filled · today, Rejected · today, Slippage), thẻ Orders với tab **History / Open / Fills / Failed & unknown** (badge đếm), filter Symbol / Side / Time, header bảng. Empty state nằm **trong** bảng. App hiện chỉ có một khối "No orders match these filters." — nói tới filter nhưng không có filter nào.
  - Đã sửa (2026-10-29): Đã có từ B4; thêm badge đếm trên tab (kiểu artboard), empty state trong bảng phân biệt "No orders yet…" (chưa có lệnh) và "No orders match these filters." (filter), symbol theo tên hiển thị, giá / khối lượng theo tick / lot.
- [x] Banner "N order has an unknown result" + nút "Review order" (khi có lệnh `unknown`) — chưa kiểm tra được vì không có lệnh.
  - Đã sửa (2026-10-29): Banner theo artboard (icon ?, tiêu đề, mô tả) + nút "Review order" chuyển sang tab Failed & unknown. Chưa kiểm tra với lệnh `unknown` thật.

### E5. Risk Center (`Risk.dc.html`, `M-Risk.dc.html`)

- [x] Banner trạng thái: thiết kế là thẻ gradient có icon khiên, tiêu đề "Within limits · N warning open", nút "See alerts". App là khối xanh lá phẳng.
  - Đã sửa (2026-10-29): Banner gradient + icon khiên, tiêu đề theo alert đang mở, "N server-enforced limits pass.", nút "See alerts".
- [x] Limits: thiết kế là **lưới 3 × 2 thẻ** (Daily loss, Max drawdown, Per-trade risk, Max leverage, Open positions, Concentration), mỗi thẻ có badge "Server-enforced" / "UI warning only" / "Not available", số lớn `0.42% of 3.00%`, **thanh tiến độ** (xanh / cam khi gần ngưỡng), dòng phụ, nút "Edit…". Thẻ gần ngưỡng có viền cam. App là danh sách dọc, số căn phải, không thanh.
  - Đã sửa (2026-10-29): Lưới thẻ (auto-fit, 3 cột ở 1440): badge Server-enforced / UI warning only / Not available, số "of X", `Meter` (cam khi ≥ 80% hoặc UI-only), dòng phụ, "Edit…"; thẻ gần ngưỡng viền cam; Concentration nét đứt.
- [x] Chú thích ở đầu thẻ Limits: hai nhãn có icon khoá / cảnh báo ở góc phải, không phải một dòng chữ xám dưới tiêu đề.
  - Đã sửa (2026-10-29): Hai nhãn có icon khoá / cảnh báo ở góc phải tiêu đề Limits.
- [x] Alerts và Emergency halt nằm **cạnh nhau** (2/3 + 1/3); Emergency halt là thẻ đỏ nhạt có icon, danh sách gạch đầu dòng (Stops N agents, Cancels N open orders, Does not close positions) và nút đỏ rộng hết thẻ.
  - Đã sửa (2026-10-29): Alerts (flex 2) + Emergency halt (flex 1) cạnh nhau; halt là thẻ đỏ nhạt có icon, 3 gạch đầu dòng, nút đỏ rộng hết thẻ. Thêm cảnh báo USDC âm (I3).
- [x] Mobile: mỗi giới hạn là một thẻ có badge "Server" / "UI warning", số + "of X", thanh tiến độ, link "Edit" bên phải. App đang để số và nút Edit căn giữa lơ lửng dưới đoạn mô tả.
  - Đã sửa (2026-10-29): Cùng thẻ, một cột ở mobile, badge ngắn "Server" / "UI warning", Edit bên phải; header mobile có ←.

### E6. Trading Agent (`Agent.dc.html`) — trạng thái chưa có bot

- [x] Thiết kế: hàng chọn agent (chip từng bot) → hero của bot đang chọn (tên, trạng thái, thanh vòng đời Stopped → Starting → Running → Paused → Stopping, 4 ô chỉ số, nút Pause) → Decisions & actions | Configuration | Recent errors. Khi chưa có bot: giữ tiêu đề trang, một thẻ empty lớn có minh hoạ/icon bot, câu "No agents yet" và nút primary "+ New agent" dẫn tới Strategy catalog. App chỉ có một dòng chữ.
  - Đã sửa (2026-10-29): Như F1 / F3: hàng chip agent, hero, Decisions, Configuration, Recent errors; chưa có bot thì một thẻ empty lớn (icon bot, "No agents yet", nút primary "+ New agent" → Strategy catalog).
- [x] Nút "New agent" đặt cuối cụm bên phải và có icon `+` (E1.1).
  - Đã sửa (2026-10-29): Đã sửa ở E1.1.

### E7. Create bot (`Create.dc.html`, `M-Create-SGrid.dc.html`)

- [x] Ngoài B1 (chưa làm): đã chọn market `vBTC_vUSDC` mà Preview vẫn chỉ là ba dòng chữ, không có biểu đồ / giá gần nhất.
  - Đã sửa (2026-10-29, B1 + DEC-68): panel Preview vẽ mức giá (lower/upper/stop) và giá gần nhất của market; mobile nằm trong form.
- [x] Ô chọn Market: danh sách ~100 mã thô, không sắp xếp, không tìm được. Cần combobox có ô tìm, nhóm theo quote, hiện tên hiển thị (E1.6) và giá gần nhất.
  - Đã sửa (2026-10-29): `MarketPicker` (combobox ARIA): ô tìm (theo tên hiển thị hoặc mã), nhóm theo quote, chỉ market `TRADING`, hiện tên hiển thị + mã gốc, phím ↑ ↓ Enter Esc. Giá gần nhất trong danh sách chưa có (cần API giá theo lô). E2E đổi sang `chooseMarket`.
- [x] Đơn vị (`vUSDC`, `%`) đang nằm **ngoài** ô nhập; thiết kế đặt trong ô, căn phải.
  - Đã sửa (2026-10-29, DEC-68): đơn vị nằm trong ô, căn phải (`Field` unit), fallback quote theo chiến lược (`fallbackQuote`).
- [x] Bấm "✦ AI parameters" khi chưa nhập Investment thì báo "Enter how much this bot can use, then try AI parameters again." nhưng ô Investment nằm tận dưới. Khi báo lỗi này: cuộn tới và focus ô Investment, viền ô báo lỗi. Cân nhắc đưa Investment lên ngay dưới Market (hỏi người dùng trước khi đổi thứ tự field so với STRATEGIES.md).
  - Đã sửa (2026-10-29, DEC-68): Amount nằm ngay dưới Market; thiếu vốn khi bấm AI parameters thì cuộn + focus ô vốn, viền lỗi "Enter an amount first.".
- [x] Nút "Start on mainnet" khi disabled đang là đỏ nhạt trông như lỗi; dùng kiểu disabled chung (xám) và ghi lý do bên dưới ("Save the draft to run the checks").
  - Đã sửa (2026-10-29): Đã sửa ở H2 (Button disabled xám + "To start: …").

### E8. AI Analyst (`Analyst.dc.html`)

- [x] "Today's briefing" là thẻ hero gradient có icon ✦ và vòng tròn trang trí; app là thẻ trắng.
  - Đã sửa (2026-10-29): Hero gradient + icon ✦ + vòng tròn trang trí.
- [x] Insight trống: hiện thẻ empty có icon, không chỉ một dòng chữ dưới tiêu đề "Insights".
  - Đã sửa (2026-10-29): Thẻ empty có icon ✦ + "No insights yet" (chờ duyệt).
- [x] Khi có insight: mỗi insight là thẻ 3 cột Observed data / Interpretation / Suggested check (cột cuối nền xanh nhạt), badge phạm vi ở góc, dòng Sources và nút hành động — chưa kiểm tra được vì không có insight.
  - Đã sửa (2026-10-29): Thẻ 3 ô Observed / Interpretation / Suggested check (ô cuối nền xanh nhạt), badge phạm vi, Sources + nút hành động. Chưa kiểm tra với insight thật.

### E9. Settings (`Connections.dc.html`, `M-Settings.dc.html`)

- [x] Gần đúng thiết kế. Còn: ô API key / Expires / Last used trong thiết kế là 3 ô nền xám bo góc; app là chữ trơn. "Expires" thiếu phần "in 182 days". Thiếu nút **"Renew key (sign again)…"** bên trái, "Disconnect…" là nút viền đỏ bên phải.
  - Đã sửa (2026-10-29): 3 ô nền xám, Expires "date · in N days", nút "Renew key (sign again)…" bên trái (DEC-59: key mới `DRIFT-<yyyymmdd>`, key cũ thôi được dùng nhưng vẫn còn trên SoDEX; engine chuyển key ngay), "Disconnect…" viền đỏ bên phải. Test API renewal.
- [x] Mobile: thanh tab xuống hai dòng; thiết kế cho tab cuộn ngang một dòng.
  - Đã sửa (2026-10-29): Tablist một dòng, cuộn ngang.

### E10. Strategy Lab

- [x] B3 và B3b vẫn chưa làm (desktop và mobile đều chưa có chip nhóm/engine, Fits/Risk chưa hai cột, "Set up …" chưa là nút).
  - Đã sửa (2026-10-29): Đã làm ở B3 / B3b (review vòng 2 xem bản build cũ).
- [x] Mobile: thẻ catalog đúng một cột, không tràn — giữ.
  - Đã sửa (2026-10-29): Giữ nguyên.

### E11. Đăng nhập

- [x] Trang **Sign in** ghi "STEP 1 OF 6" và rail bên trái là 6 bước của Create account. Sign in không phải bước onboarding: bỏ "STEP 1 OF 6", rail đổi thành nội dung giới thiệu ngắn (hoặc ẩn rail và để form ở giữa). Hỏi người dùng muốn kiểu nào nếu artboard không có màn Sign in.
  - Đã sửa (2026-10-29): `OnboardingShell noSteps`: Sign in không có rail, không thanh tiến độ, không "STEP 1 OF 6"; logo + form ở giữa + ghi chú an toàn (chọn phương án không cần câu chữ mới).

## F. Trading Agent — chi tiết bot (2026-10-28)

Kiểm tra `/agent/01a18307-0e83-7508-ac8a-6c62e7f395cb`, account `lthuangiang@gmail.com`, ở khổ 1440 px và 375 px. Bot "BTC" (Futures Grid, `BTC-USD`) đang ở trạng thái `draft`, version 3, chưa có event nào. So với `Agent.dc.html` và `Mobile-Agent.dc.html`. Code ở `apps/web/src/features/bots/components/agent-page.tsx`.

### F1. Lỗi logic làm vỡ trang (sửa trước)

- [x] **Trang hiện cùng lúc empty state và chi tiết bot.**
  - Đã sửa (2026-10-29): Viết lại `agent-page.tsx`: empty state chỉ khi không có `botId` và không có agent; có `botId` thì chỉ hiện chi tiết.
  - `agents` lọc bỏ bot `draft`/`archived` (dòng ~61), nên danh sách rỗng và trang hiện "No agents yet…", một bảng Decisions rỗng và "Configuration · Not available".
  - Trong khi đó `id = botId` vẫn có, nên ngay bên dưới lại render chi tiết bot "BTC", với Decisions và Configuration lần thứ hai.
  - Cách sửa: khi có `botId` thì không render khối empty state. Khối empty chỉ dùng khi không có `botId` **và** không có bot nào để chọn.
- [x] **Toàn bộ chi tiết bot bị ép vào cột 240 px ở desktop.**
  - Đã sửa (2026-10-29): Bỏ grid 240 px; danh sách agent là hàng thẻ chọn nằm ngang phía trên, chi tiết chiếm hết chiều ngang.
  - Grid `lg:grid-cols-[240px_minmax(0,1fr)]` giả định luôn có cột danh sách agent. Khi `agents` rỗng thì `<nav>` không render, nên khối chi tiết rơi vào cột 240 px; 2/3 màn hình bên phải bỏ trống.
  - Vì cột quá hẹp: bảng Decisions bị cắt cột "Result" và hiện thanh cuộn ngang; lưới Configuration 2 cột có chữ đè lên nhau ("BTC-USD" đè "Leverage", "isolated" đè "Direction").
  - Cách sửa: chỉ áp grid 2 cột khi có danh sách. Tốt hơn là theo thiết kế: danh sách agent là **hàng thẻ chọn nằm ngang** phía trên (`A · Grid · ADA/USDT · Running`…), không phải cột trái, và chi tiết chiếm hết chiều ngang.
- [x] **Người dùng đã chốt (2026-10-28): bot `draft` chỉ nằm ở Strategy Lab, không hiện ở Trading Agent.**
  - Đã sửa (2026-10-29): DEC-57 + SCREENS.md 8.3: draft → `router.replace(/bots/:id/edit)`, archived → `/bots`, sau khi API trả `state`; trong lúc chờ là skeleton.
  - Danh sách agent giữ nguyên bộ lọc bỏ `draft`/`archived`.
  - Vào `/agent/:botId` của một bot `draft` thì redirect (replace) sang `/bots/:botId/edit`. Bot `archived` thì sang `/bots`.
  - Chỉ redirect sau khi `GET /api/v1/bots/:id` trả về `state`. Trong lúc chờ thì hiện skeleton, không hiện empty state.
  - Claude Code ghi quyết định này vào `docs/DECISIONS.md` (mã DEC kế tiếp) và thêm một dòng vào `docs/SCREENS.md` mục 8.3.

### F2. Configuration

- [x] Giá trị hiện bằng `JSON.stringify(v)`, nên chuỗi có dấu ngoặc kép: `"BTC-USD"`, `"80444"`, `"isolated"`. Phải hiện giá trị đã format, không có ngoặc kép.
  - Đã sửa (2026-10-29): `config-view.tsx` định dạng giá trị, không còn ngoặc kép.
- [x] Enum đang hiện mã thô: `"short"`, `"isolated"`, `"arithmetic"`, `"close_at_market"`. Phải hiện label i18n giống form Create, ví dụ Short / Isolated / Arithmetic / Close at market.
  - Đã sửa (2026-10-29): Nhãn enum lấy từ `createBot.options` như form Create (Short, Isolated, Arithmetic, Close position…).
- [x] Thiếu đơn vị và định dạng số: `80444` → `80,444 USD`, margin `20` → `20 USDC`, leverage `2` → `2×`, max loss `2` → `2 USDC` (hoặc `%`, tuỳ field spec trong STRATEGIES.md).
  - Đã sửa (2026-10-29): Số có phân cách hàng nghìn, đơn vị theo field spec (quote / base theo tên hiển thị, %, ×), market theo E1.6.
- [x] Thiết kế gộp các field thành 5–6 dòng dễ đọc, căn trái label, căn phải giá trị, không có đường kẻ: Price range `80,444 – 85,623`; Grid levels `4 · arithmetic`; Investment / Margin; Stop if price below; Take profit `Not set`. App đang liệt kê 15 field rời, mỗi field một ô.
  - Đã sửa (2026-10-29): Gộp "Price range lower – upper", "Grid levels N · spacing"; lưới 2 cột, label trái giá trị phải, không đường kẻ. Các field khác vẫn mỗi dòng một field (đã định dạng).
- [x] Sau khối giá trị cần nút **"Edit bot"** full-width (nền `#E6ECFE`, chữ xanh đậm) và dòng ghi chú "Edits create v4 and go through review…". App chỉ hiện link Edit khi bot `running`/`paused`; nút "Edit bot" phải hiện với mọi trạng thái có trên trang này. Bot draft không vào trang này (xem F1).
  - Đã sửa (2026-10-29): Nút "Edit bot" full-width tonal + dòng "Edits create v{n}…", hiện với mọi trạng thái có trên trang.
- [x] Field "Start when price crosses" và "Take profit at total profit" đang hiện "Not provided". Với tham số tuỳ chọn mà người dùng bỏ trống, thiết kế ghi **"Not set"**. "Not provided" chỉ dành cho dữ liệu backend thiếu.
  - Đã sửa (2026-10-29): Tham số bỏ trống hiện "Not set".

### F3. Thẻ trạng thái (hero)

- [x] Thiết kế: thẻ hero nền gradient xanh nhạt, có hình tròn trang trí, icon bot 56 px nền xanh, tiêu đề `Grid · ADA/USDT`, pill trạng thái và dòng "Confirmed by backend 14:02:09", nút hành động chính góc phải.
  - Đã sửa (2026-10-29): Hero gradient + vòng tròn trang trí, icon bot 56 px (48 px mobile), tên bot, market hiển thị · chiến lược, pill trạng thái + dòng "Confirmed by backend {time}" / "Sent {time} · waiting for backend"…
  - App: thẻ trắng phẳng, tiêu đề chỉ là tên bot "BTC", dòng phụ `BTC-USD · Futures Grid` dùng symbol thô.
- [x] Thiếu **thanh vòng đời** `Stopped → Starting → Running → Paused → Stopping`, với bước hiện tại tô đậm.
  - Đã sửa (2026-10-29): Thanh Stopped → Starting → Running → Paused → Stopping, bước hiện tại tô đậm, đang chờ backend thì viền nét đứt (desktop).
- [x] Thiếu ô **Runtime**. Thiết kế có 4 ô chỉ số (Profit since start, Runtime, Open orders, Last decision); mỗi ô là ô nền trắng bo góc nằm trên nền gradient. App có 3 chỉ số chữ trơn, và trên desktop bị bẻ dòng ("Profit / since / start").
  - Đã sửa (2026-10-29): 4 ô nền trắng trên gradient: Profit since start, Runtime (từ event "Running" gần nhất khi đang chạy; khác thì Not available), Open orders, Last decision; không ngắt dòng.
- [x] Nút hành động chính (Pause / Resume / Start…) phải ở góc phải của thẻ, cùng hàng tiêu đề, như nút Pause trong thiết kế. Hiện nút đang nằm sát dưới pill trạng thái.
  - Đã sửa (2026-10-29): Nút chính ở góc phải hero cùng hàng tiêu đề; mobile full-width "Pause (keeps open orders)".

### F4. Decisions & actions

- [x] Trong khối chi tiết, section Decisions không có thẻ trắng bao ngoài (khác với bản empty phía trên và khác thiết kế). Tiêu đề "Decisions & actions" và link "All orders →" phải nằm trong thẻ.
  - Đã sửa (2026-10-29): Decisions nằm trong thẻ trắng, tiêu đề + link trong thẻ.
- [x] Link "All orders →" phải là chữ xanh đậm cỡ 13 px, cùng hàng tiêu đề. Ở desktop hẹp, link đang bị đẩy xuống dòng.
  - Đã sửa (2026-10-29): Link 13 px đậm, `whitespace-nowrap`, cùng hàng tiêu đề.
- [x] Khi có dữ liệu: cột Decision in đậm, cột Result là pill màu (Filled xanh lá, Open on SoDEX xanh dương, Unknown · not retried tím, No order xám, Confirmed xanh lá). Chưa kiểm tra được vì bot chưa có event.
  - Đã sửa (2026-10-29): Decision in đậm; Result là pill màu theo nội dung (Filled / Confirmed xanh lá, Open xanh dương, Unknown tím, còn lại xám). Chưa kiểm tra với event thật.

### F5. Thiếu section

- [x] **Recent errors**: mỗi lỗi một thẻ màu (rate limit nền hồng, unknown nền tím), có tiêu đề, giờ, mô tả, mã lỗi và link "Check order … →". Khi không có lỗi, cần empty state ngắn, không ẩn cả section.
  - Đã sửa (2026-10-29): Section Recent errors: event `type = error` thành thẻ đỏ nhạt (tiêu đề, giờ, mô tả); không có thì "No errors." (không ẩn section). Mã lỗi / link "Check order" chưa có vì event chưa lưu mã riêng.
- [x] **Stop this agent**: thẻ nền hồng nhạt, mô tả bên trái, nút viền đỏ "Stop agent…" bên phải. App chỉ hiện khối này khi `can(stop)`; giữ quy tắc đó.
  - Đã sửa (2026-10-29): Thẻ hồng nhạt, mô tả trái, nút viền đỏ "Stop agent…" phải (mobile full-width + dòng "You will see exactly what gets cancelled…"); chỉ khi `can(stop)`.

### F6. Mobile (375 px, `Mobile-Agent.dc.html`)

- [x] Cũng bị lỗi F1: empty state + chi tiết hiện cùng lúc, nên người dùng phải cuộn qua khoảng 900 px nội dung rỗng mới tới bot.
  - Đã sửa (2026-10-29): Như F1.
- [x] Header mobile của thiết kế: nút ← quay lại, tiêu đề "Trading Agent", chip "LIVE" nhỏ, tất cả trên một hàng. App dùng header desktop, gồm subtitle, nút "New agent", chip LIVE · MAINNET, SoDEX connected, chuông và avatar, chiếm khoảng 220 px (giống E1.2).
  - Đã sửa (2026-10-29): `PageHead` prop `back`: ← Home, tiêu đề, chip LIVE trên một hàng (E1.2).
- [x] Thẻ bot mobile: icon + tên + "Up 3d 4h 12m", pill trạng thái bên phải; lưới 2×2 ô nền xám (Profit · since start, Open grid orders `8 of 10`, Investment, Range); bên dưới là nút hành động full-width có giải thích, ví dụ "Pause (keeps open orders)".
  - Đã sửa (2026-10-29): Hero mobile: icon + tên + pill, lưới 2×2 ô (Profit, Runtime, Open orders, Last decision), nút full-width "Pause (keeps open orders)". "Up 3d 4h" dùng ô Runtime; Investment / Range nằm ở Configuration.
- [x] Recent decisions trên mobile là **danh sách**, mỗi dòng gồm giờ, hành động đậm và kết quả màu. Không dùng bảng 4 cột như app đang làm.
  - Đã sửa (2026-10-29): Mobile: danh sách giờ · hành động đậm · kết quả, không dùng bảng.
- [x] Cuối trang: nút viền đỏ "Stop agent…" full-width và dòng "You will see exactly what gets cancelled before anything happens."
  - Đã sửa (2026-10-29): Có (xem F5).
- [x] Configuration trên mobile đọc được (một cột), nhưng vẫn mắc các lỗi ở F2.
  - Đã sửa (2026-10-29): Một cột, cùng định dạng F2.
- [x] Ghi nhận: thanh tab dưới 5 mục (Home, Portfolio, Agent ở giữa, Strategy, More) đã có. A3 đạt một phần, cần kiểm tra lại trên các trang khác.
  - Đã sửa (2026-10-29): Đã có từ A3; header mobile mọi trang theo E1.2.

### F7. Dữ liệu

- [x] `GET /api/v1/bots` trả `capital: "20"`, nhưng `GET /api/v1/bots/:id` trả `capital: null` cho cùng bot. Hai endpoint phải thống nhất.
  - Đã sửa (2026-10-29): `botDetail` truyền config của version active vào `summary` → cùng công thức với danh sách; test API kiểm tra `capital = "500"` ở cả hai.

## G. Màn Create bot — sắp xếp lại field (2026-10-29)

Người dùng phản ánh form tạo bot khó dùng, khó hiểu: field quan trọng như margin không có hoặc nằm tận dưới. Yêu cầu: **hiện field cần thiết ở trên; field optional và field cài đặt ít khi đổi gom vào "Advanced settings" (collapse)**.

Đã kiểm tra `/bots/new/<strategy>` của 7 chiến lược ở khổ 1440 px và 375 px (Volume Maker đang khoá). So với `Create-FDCA.dc.html` và field spec trong `docs/STRATEGIES.md`. Code ở `apps/web/src/features/bots/fields.ts` và `components/bot-form.tsx`.

> **Lệch thiết kế có chủ đích.** Các artboard Create xếp mọi field phẳng theo 3 nhóm (Market · Parameters · Risk & exits). Phần collapse dưới đây là **yêu cầu mới của người dùng**. Claude Code ghi thành DEC mới (mã kế tiếp) trong `docs/DECISIONS.md` và cập nhật `docs/SCREENS.md` mục 8.2 trước khi code. Field spec, label, rule và error message giữ nguyên như STRATEGIES.md; chỉ đổi **thứ tự và chỗ hiện**.

### G1. Vấn đề chung trên mọi màn Create

- [x] **Không biết bot dùng bao nhiêu tiền.**
  - Ô vốn (Investment / Margin / Amount per buy / Total size) nằm giữa hoặc cuối nhóm Parameters. Futures Grid: Margin là field thứ 6 của Parameters, sau range và grid levels. Rebalancing: Investment nằm sau assets và threshold.
  - Không chỗ nào hiện **số dư khả dụng** (Spot hay Perps).
  - Ở DCA không có ô "margin" vì vốn là tổng của base + các safety order, nhưng UI không ghi điều đó. Người dùng không thấy tổng margin tối đa, dù `capitalOf()` trong `capital.ts` đã tính được. Thiết kế hiện "Max margin 812.50 USDC" ở preview. Đã sửa (2026-10-29): `apps/web/src/features/bots/fields.ts` (ô vốn ở section Amount), `components/amount-lines.tsx` (số dư Spot/Perps, Max capital/margin, Position up to), DEC-68.
- [x] **Thiếu đơn vị trên ô tiền.** Base order, Safety order, Margin, Investment, Lower/Upper price không có hậu tố `USDC` hoặc `USD` khi chưa chọn market. Thiết kế luôn có đơn vị trong ô. Đã sửa (2026-10-29): `apps/web/src/features/bots/form-layout.ts` (`fallbackQuote`), `components/bot-form.tsx`.
- [x] **Help text của Futures DCA chép từ Spot DCA, sai nghĩa với perp, nhất là khi Short.** Sửa theo artboard Create-FDCA: Đã sửa (2026-10-29): `apps/web/src/features/bots/fields.ts` (key `fdca*`), `preview.ts` (hint Direction), `messages/en.json`.

  | Field | App đang ghi | Artboard |
  |---|---|---|
  | Base order | First buy at start | Margin for first entry |
  | Safety order | First extra buy | Margin for first add |
  | Price drop to first safety | 0.1–20% | **Price move** to first safety · "Against your direction" |
  | Take profit | From average buy price | From average entry |
  | Stop loss | From average price · sells everything | Closes the position · must be before liquidation |
  | Direction | (không có) | "Long adds on drops" / Short tương ứng |

  Spot DCA giữ câu chữ hiện tại. Cần thêm key i18n riêng cho futures (`fdcaBaseOrder`…), không dùng chung key.
- [x] Form dài 15–17 field ngang hàng nhau, không phân biệt field bắt buộc, field tuỳ chọn và field ít khi đổi. Người dùng phải cuộn khoảng 2 màn hình mới tới nút Start. Đã sửa (2026-10-29): `apps/web/src/features/bots/components/bot-form.tsx`, `form-layout.ts` (section + Advanced settings đóng mặc định), DEC-68.
- [x] **Preview rỗng chiếm chỗ.** Khi chưa có dữ liệu, ô preview vẫn cao khoảng 250 px; trên mobile nó đứng trước form nên đẩy ô nhập đầu tiên xuống dưới màn hình. Khi chưa có dữ liệu, rút thành một dải thấp (khoảng 72 px) với câu "Fill in the settings to see the preview."; có số rồi mới mở rộng. Desktop: cột preview `sticky top` để luôn thấy khi cuộn form. Đã sửa (2026-10-29): `components/preview-visual.tsx` (dải 72 px), `components/visual-panel.tsx` (sticky desktop).
- [x] "Before it starts" chỉ ghi "Save the draft to run the checks." Thiết kế hiện danh sách check (API key, Builder fee, Balance, Order sizes, 2FA, Risk limits) có dấu ✓. Ít nhất check **Balance** phải chạy ngay khi nhập vốn, không chờ Save draft. Đã sửa (2026-10-29): `apps/web/src/features/bots/components/start-checks.tsx` (dry run `POST /api/v1/bots/checks` trên form chưa lưu).
- [x] Ô Market / Contract: xem G6. Bản mới đã có combobox tìm kiếm ở hầu hết các form; TWAP, Funding Arb (Asset) và Rebalancing vẫn chưa có. Đã sửa (2026-10-29): TWAP, Funding Arb và Rebalancing dùng `Picker` (DEC-66).

### G2. Bố cục mới cho panel settings (áp dụng cho mọi chiến lược)

Thứ tự từ trên xuống:

1. **Thẻ AI parameters**: giữ như hiện tại.
2. **Market**: market/contract (có tìm kiếm), engine nếu có, direction nếu là perp.
3. **Amount**: ô vốn của chiến lược, đặt **ngay sau market**.
   - Dưới ô: `Available: 1,234.56 USDC on Perps`, lấy từ backend; không có thì ghi "Not available".
   - Chiến lược perp: đặt Leverage cạnh ô vốn, cùng hàng (ô vốn 2/3, leverage 1/3). Dưới hàng có dòng `Position up to ≈ margin × leverage`, chỉ hiện khi cả hai ô đã có giá trị.
   - DCA: hai ô Base order / Safety order cùng hàng, kèm dòng tổng `Max margin used: 812.50 USDC` (Spot: `Max capital used`), tính bằng `capitalOf()`. Thêm một câu hint ở đầu nhóm: "Your total is the base order plus every safety order."
4. **Strategy**: chỉ các tham số bắt buộc quyết định cách bot chạy (xem bảng G3).
5. **Risk**: chỉ các field risk **bắt buộc** theo STRATEGIES.md, luôn hiện.
6. **Advanced settings**: collapse, **mặc định đóng**.
   - Chứa: field optional; field enum/bool đã có mặc định (spacing, margin mode, when the bot stops…); tham số bắt buộc mà AI parameters điền sẵn và ít người đổi (step/size multiplier…); Bot name.
   - Header khi đóng có dòng tóm tắt giá trị hiện tại, ví dụ `Arithmetic · Cross · Close position · 3 optional not set`, để người dùng không phải mở ra mới biết.
   - Có field **bắt buộc đang trống** hoặc **có lỗi** → header hiện `2 fields need a value` (màu lỗi). Khi bấm Save draft / Start / AI parameters mà còn lỗi bên trong thì tự mở section và focus field lỗi đầu tiên. Không bao giờ để lỗi nằm trong section đang đóng mà người dùng không thấy.
   - Nhớ trạng thái mở/đóng theo từng người dùng (localStorage là đủ); màn Edit bot dùng cùng quy tắc.
   - Có field trong Advanced vừa được AI điền hoặc người dùng sửa → chip `AI` / `Edited` cũng hiện ở header của section.
7. **Before it starts** + Save draft / Start: giữ như hiện tại.

Gợi ý kỹ thuật: thêm thuộc tính `tier: "main" | "advanced"` vào `FieldSpec` trong `fields.ts`, giữ `group` cho thứ tự; `bot-form.tsx` render nhóm `advanced` trong một `<details>`/Disclosure có thể điều khiển bằng state, để tự mở khi có lỗi.

### G3. Field nào hiện, field nào vào Advanced

| Chiến lược | Market | Amount (ngay sau market) | Strategy (hiện) | Risk (hiện) | Advanced settings (đóng) |
|---|---|---|---|---|---|
| Spot Grid | Market | Investment | Lower – Upper price (cùng hàng), Grid levels | Max loss | Spacing, Start when price crosses, Stop if price falls below, Take profit, When the bot stops, Bot name |
| Futures Grid | Contract, Direction | **Margin** + Leverage | Lower – Upper price, Grid levels | Max loss, Stop if price falls below *(xem G4)* | Margin mode, Spacing, Start when price crosses, Stop if price rises above, Take profit, When the bot stops, Bot name |
| Spot DCA | Market | Base order + Safety order → Max capital used | Max safety orders, Price drop to first safety, Take profit | — | Step multiplier, Size multiplier, Start (+ Start level), Stop loss, Max cycles, Max loss, Bot name |
| Futures DCA | Contract, Direction | Base order margin + Safety order margin → **Max margin used**, Leverage | Max safety orders, Price move to first safety, Take profit | **Stop loss** (bắt buộc) | Margin mode, Step multiplier, Size multiplier, Max loss, Bot name |
| Recurring Buy | Market | Amount per buy | Frequency, Day and time, Ends (+ Total budget / Number of buys) | — | Skip buys above price, If balance is too low, Bot name |
| Rebalancing | Quote asset | **Investment** (đưa lên trước assets) | Assets and weights, Rebalance when (+ Threshold) | — | Max trade per rebalance, Stop if value below, Take profit, Bot name |
| Funding Arbitrage | **Asset** (một picker, xem G4) | Investment → "Split 50/50: X on Spot · X on Perps", số dư cả hai engine | Enter when funding ≥ | Max loss | Perp leg leverage, Exit when funding ≤, Max price gap between legs, Keep perp margin ratio above, Bot name |
| TWAP | Engine, Market, Side | Total size (đơn vị base asset, số dư hoặc vị thế khả dụng) | Duration, Slices | Max slippage per slice | Price limit, Reduce-only (chỉ khi Perps), If slices are skipped, Bot name |

Vì sao chia như vậy: mỗi form chỉ còn **4–7 ô** hiện sẵn, gồm "mua/bán cái gì, bao nhiêu tiền, chạy theo khung nào, mất tối đa bao nhiêu". Field trong Advanced đều có mặc định hợp lệ, được AI điền, hoặc là tuỳ chọn.

### G4. Lỗi riêng từng chiến lược

- [x] **Futures Grid**: STRATEGIES.md S2 ghi "Stop if price falls below" có default `lower − 3%` và rule "must be before liquidation", không ghi Optional; app đặt `optional: true`. **Đã chốt (2026-10-29, người dùng uỷ quyền cho reviewer quyết):** field này **bắt buộc**, theo đúng STRATEGIES.md S2. Lý do: bot perp có đòn bẩy, cần một mức dừng trước giá thanh lý. Sửa `optional: true` → bỏ; AI parameters điền `lower − 3%`; validate "Must be closer than liquidation." Nằm ở nhóm Risk, hiện sẵn. Đã sửa (2026-10-29): `packages/strategies/src/futures-grid/schema.ts`, `apps/web/src/features/bots/fields.ts`, fixture test (DEC-65). Còn mở: validate liquidation, cần công thức (OPEN_QUESTIONS).
- [x] **Funding Arbitrage**: có cùng lúc ô text "Asset", dropdown "Spot market" và dropdown "Perp market". Người dùng có thể chọn BTC spot với ETH perp. Gộp thành **một picker Asset**, chỉ liệt kê tài sản có cả hai market; hai market tự suy ra và hiện dạng chữ phụ "Spot BTC/USDC · Perp BTC-PERP". Đã sửa (2026-10-29): `ArbAssetPicker` trong `apps/web/src/features/bots/components/asset-pickers.tsx`; hai market ẩn và tự điền (DEC-66).
- [x] **TWAP**: Đã sửa (2026-10-29): picker theo Engine, Reduce-only chỉ khi Perps, quy đổi giờ dưới Duration (DEC-67).
  - "Market" đang là ô text tự gõ. Phải là picker theo Engine.
  - Hint vẫn ghi "Any SoDEX spot market" khi đã chọn Perps.
  - "Reduce-only (perps)" vẫn hiện khi Engine = Spot. Chỉ hiện khi Perps.
  - Duration chỉ nhận phút; spec cho 5 min – 24 h. Thêm chọn đơn vị min/h, hoặc hiện bản quy đổi "= 4 h" dưới ô.
  - TWAP không có nút AI parameters, nên mọi ô số bắt buộc đều phải nằm ngoài Advanced (bảng G3 đã tính điều này).
- [x] **Recurring Buy**: Đã sửa (2026-10-29): bỏ "(optional)" với field hiện theo điều kiện; chọn thứ (Weekly), ngày 1–28 (Monthly) và ô giờ (DEC-67).
  - "Total budget (optional)" ghi optional, nhưng khi Ends = After budget thì field này là bắt buộc (`capitalOf` cần nó). Khi field hiện ra vì điều kiện `when` thì bỏ chữ "(optional)".
  - "Day and time" là ô text `09:00`; Weekly/Monthly không có chỗ chọn thứ hoặc ngày. Spec ghi default "Mon 09:00". Cần chọn thứ (Weekly) / ngày trong tháng (Monthly) + giờ.
- [x] **Rebalancing**: chọn "On a schedule" thì vẫn hiện ô Threshold, và không có ô chọn lịch. STRATEGIES.md S6 chưa có field lịch. **Đã chốt (2026-10-29, người dùng uỷ quyền cho reviewer quyết):** Đã sửa (2026-10-29): `schedule` + `timeZone` trong schema, `nextScheduled` trong engine, test ba chu kỳ; `thresholdPct` chỉ khi threshold (DEC-67).
  - Thêm field `schedule` (group 3, enum, bắt buộc khi `rebalanceWhen = schedule`): **Daily / Weekly / Monthly**, mặc định Weekly. Label "Rebalance every", hint "Checked at 00:00 in your time zone".
  - Weekly chạy thứ Hai, Monthly chạy ngày 1, đều lúc 00:00 theo múi giờ của người dùng (dùng `timeZone` giống Recurring Buy). Không cho chọn giờ, để form gọn.
  - `thresholdPct` chỉ hiện khi `rebalanceWhen = threshold` (thêm `when`).
  - Thay đổi cả spec và engine: bổ sung dòng vào STRATEGIES.md S6, zod schema `packages/strategies/rebalancing`, và `scheduler` phát `timer`. Có unit test cho cả ba chu kỳ.
- [x] **Futures DCA**: label "Price drop to first safety" sai khi Direction = Short. Dùng "Price move to first safety" như artboard. Đã sửa (2026-10-29): `apps/web/src/features/bots/fields.ts`, `apps/web/messages/en.json` (key `fdcaFirstStepPct`, câu chữ theo STRATEGIES.md S4).

### G5. Mobile (375 px)

- [x] Preview rỗng đứng trước form, chiếm khoảng 360 px (xem G1). Trên mobile, khi chưa có dữ liệu thì đặt dải preview thu gọn **sau** nhóm Amount; có dữ liệu thì preview hiện thành thẻ gọn trước Advanced settings. Đã sửa (2026-10-29): `components/create-bot.tsx`, `components/bot-form.tsx` (prop `preview`), `apps/web/src/lib/use-media.ts`.
- [x] Hàng "Base order + Safety order" và "Margin + Leverage" ở G2 xuống thành một cột ở dưới 480 px; dòng tổng `Max margin used` vẫn ngay dưới. Đã sửa (2026-10-29): `components/bot-form.tsx` (`row` xuống cột dưới 480 px; dòng Max margin nằm ngay dưới).
- [x] Nút Save draft / Start on mainnet nên là thanh dính đáy (sticky), nằm trên tab bar, để không phải cuộn hết form. Ô 2FA và checkbox xác nhận vẫn nằm trong form; thanh sticky chỉ cuộn tới chúng khi chưa điền. Đã sửa (2026-10-29): `components/create-bot.tsx` (thanh dính đáy dưới 1024 px; còn thiếu điều kiện thì cuộn tới mục đầu tiên).
- [ ] Header mobile đang có 3 chip (Perps, LIVE · MAINNET, Paper · Coming soon) trên một hàng riêng; đối chiếu `M-Create-*.dc.html` để biết giữ chip nào (chưa kiểm tra trong lần review này).

### G6. Ô chọn market / contract (tìm kiếm và lọc)

Người dùng nhấn mạnh: chọn asset/contract đang rất khó vì danh sách dài. Sau lần review G, bản mới đã có `MarketPicker` (combobox có ô "Search markets") ở **Spot Grid, Futures Grid, Spot DCA, Futures DCA, Recurring Buy** và ở hai ô market của Funding Arb. Đã thử ở 1440 px và 375 px: gõ "btc" / "eth" lọc đúng, chọn được. Còn thiếu:

- [x] **Áp dụng cho mọi chỗ chọn market hoặc tài sản**, không còn ô text tự gõ hay `<select>` dài: Đã sửa (2026-10-29): `picker.tsx`, `asset-pickers.tsx`, `fields.ts`, `bot-form.tsx` (DEC-66).
  - TWAP › Market: vẫn là ô text. Dùng `MarketPicker` với `engine` theo field Engine; đổi Engine thì xoá market đã chọn.
  - Funding Arb › Asset: vẫn là ô text, cộng thêm 2 picker. Thay bằng **một** picker tài sản (G4), chỉ liệt kê tài sản có cả spot lẫn perp đang `TRADING`.
  - Rebalancing › Assets and weights: mỗi dòng tài sản dùng picker tài sản spot, không cho chọn trùng một tài sản ở hai dòng.
- [x] **Thứ tự khi chưa gõ gì:** đang xếp A→Z, nên `1000BONK-USD`, `AAPL` đứng đầu còn BTC/ETH nằm giữa danh sách. Đã sửa (2026-10-29): SoDEX không có khối lượng 24h nên dùng nhóm "Popular" (BTC, ETH, SOL) rồi A→Z (`pickers.ts`, DEC-66).
  - Xếp theo khối lượng 24h giảm dần nếu marketdata có số này; không có thì xếp A→Z nhưng đưa BTC, ETH, SOL lên đầu dưới nhóm "Popular". Danh sách cố định này là quyết định UI, không phải số liệu.
  - Nếu xếp theo khối lượng 24h thì hiện số đó ở cột phải, dạng `Vol 12.3M`; không có thì không hiện.
- [x] **Cột phải của từng dòng:** với perps đang lặp lại đúng tên bên trái (`BTC-USD   BTC-USD`). Với spot, mã thô `vETH_vUSDC` không giúp người dùng. Bỏ mã thô; thay bằng giá gần nhất (`md:last:*` đã có cho Preview), hoặc khối lượng 24h như trên. Đã sửa (2026-10-29): bỏ mã thô; cột phải là giá gần nhất từ `/api/v1/markets` (`last`), không có thì để trống (DEC-66).
- [x] **Nhóm và lọc nhanh:** SoDEX có cả crypto lẫn cổ phiếu/chỉ số/hàng hoá (AAPL, NVDA, US500, SILVER, BRENTOIL…). Thêm hàng chip lọc trên danh sách: `All · Crypto · Stocks · Indices & commodities`, chỉ khi market info của SoDEX có trường phân loại. Không có thì bỏ chip, **không tự phân loại bằng tay**. Đã xử lý (2026-10-29): market info của SoDEX không có trường phân loại, nên không thêm chip (đúng điều kiện của mục; DEC-66).
- [x] **Tiêu đề nhóm:** perps đang ghi "USDC MARKETS" nhưng symbol là `-USD`. Ghi đúng quote hiển thị, hoặc bỏ tiêu đề nhóm khi chỉ có một nhóm. Đã sửa (2026-10-29): tiêu đề theo quote của tên hiển thị (`USD markets`), ẩn khi chỉ có một nhóm (DEC-66).
- [x] **Tìm kiếm:** khớp theo base asset, tên hiển thị và mã gốc, không phân biệt hoa thường. Bỏ qua `v`, `/`, `-`, `_`, để gõ `btcusd` hay `btc/usdc` đều ra. Kết quả khớp **đầu chuỗi** xếp trước kết quả khớp giữa chuỗi (gõ "eth" thì ETH đứng trước METH…). Đã sửa (2026-10-29): `searchKey` / `matchRank` trong `pickers.ts`, có test (DEC-66).
- [x] **Không có kết quả:** hiện "No markets match "xyz"." thay vì danh sách rỗng. Đã sửa (2026-10-29): "No markets match “xyz”." (`_pendingReview`).
- [x] **Bàn phím:** ↑/↓ di chuyển, Enter chọn, Esc đóng và trả lại giá trị cũ; dòng đang active cuộn vào tầm nhìn. Chạy axe cho combobox (role `combobox` + `listbox`, `aria-activedescendant`). Đã sửa (2026-10-29): Esc trả lại giá trị cũ, dòng active `scrollIntoView`; combobox/listbox/`aria-activedescendant`; p11-a11y đạt.
- [x] **Mobile:** danh sách thả xuống đang sát tab bar dưới đáy. Dưới 768 px, mở picker thành **bottom sheet cao khoảng 85% màn hình**: ô tìm ở trên, tự focus; danh sách cuộn bên trong; nút đóng. Trên iOS, ô tìm cỡ chữ ≥ 16 px để không bị tự zoom. Đã sửa (2026-10-29): dưới 768 px dùng `BottomSheet` có ô tìm `text-base` tự focus và nút Close; e2e mobile-390 p7/p9 đạt.
- [x] **Sau khi chọn:** ô hiện tên hiển thị (`ETH/USDC`), có nút × để xoá. Dưới ô hiện một dòng thông tin từ backend: `Last 3,412.50 · Min order 5 USDC · Max leverage 20×` (chỉ trường có dữ liệu). Đã sửa (2026-10-29): nút × và dòng "Last · Min order · Max leverage" (chỉ trường có dữ liệu; DEC-66).

## H. Lỗi logic: bot kẹt "Starting" và nút "Start on mainnet" không bật (2026-10-29)

Account `lthuangiang@gmail.com`. Đọc API, log docker compose và code; **không sửa gì**.

### H1. Bot "Futures Grid" (`01a1836f-…`) kẹt ở `starting` từ 2026-10-28 16:54 UTC

**Chuỗi nguyên nhân (đã xác minh bằng log):**
1. `signer` không giải mã được API key: mọi `POST /v1/sign` trả 500 với lỗi `Vault POST /v1/transit/decrypt/… failed with 400` (`apps/signer/src/vault.ts:71`).
2. Lý do: service `vault` trong `docker-compose.yml` chạy **dev mode**, toàn bộ dữ liệu nằm trong RAM. Mỗi lần stack khởi động lại, `vault-init` tạo một khoá transit `drift-api-keys` **mới**. Ciphertext của API key trong Postgres được mã hoá bằng khoá cũ nên không giải mã được nữa. Lần restart gần nhất cách lúc review khoảng 19 phút; key được tạo ngày 2026-10-28.
3. Bot perp phải đặt đòn bẩy trước khi gửi lệnh (`#ensureLeverage`, `apps/engine/src/engine.ts:609`). `HttpGateway.setLeverage` bắt mọi exception rồi trả `unknown` (`http-gateway.ts:227`). Engine log "leverage update result unknown; retrying" rồi `return`. Mỗi tick (khoảng 2 giây) lại thử, **vô hạn**:
   - không backoff;
   - không ghi event cho người dùng (Decisions & actions trống);
   - không pause bot.
4. Trong khi đó check "DRIFT API key" vẫn ✓, vì `startChecks` (`apps/api/src/modules/bots/service.ts:385`) chỉ xem `status = active` và `expiresAt` trong DB, không kiểm tra key có dùng được không. Header vẫn hiện "SoDEX connected".

**Hệ quả:** mọi bot của account này đều không gửi được gì lên SoDEX, kể cả lệnh huỷ, cho tới khi người dùng ký lại key.

**Sửa:**
- [x] **Infra (dev):** Vault không được mất khoá khi restart.
  - Đã sửa (2026-10-29): DEC-55: Vault server mode + file storage trên volume `vaultdata`, `infra/vault/dev-init.sh` init / unseal / token cố định / transit; đã thử restart Vault: khoá giữ nguyên (cùng thời điểm tạo). ARCHITECTURE.md ghi production dùng KMS / Vault cluster. Key DRIFT tạo trước DEC-55 vẫn phải ký lại.
  - Chạy Vault server mode với storage `file` trên một named volume, kèm script init/unseal dev. Hoặc dùng khoá transit cố định import lúc init (`transit/keys/drift-api-keys/import`).
  - Ghi rõ trong `docs/ARCHITECTURE.md`: production dùng KMS hoặc Vault cluster, không bao giờ dev mode.
- [x] **Engine: phân biệt lỗi.**
  - Đã sửa (2026-10-29): `NotSentError` / outcome `not_sent` kèm mã (`key_unusable`, `key_not_active`, `stale_epoch`, `signer_unavailable`) cho lỗi ở bước ký; `unknown` chỉ khi đã gửi (DEC-56).
  - "Signer hoặc mạng lỗi **trước khi** request rời DRIFT" không phải `unknown`: SoDEX chưa nhận gì. Đặt tên riêng (ví dụ `not_sent`).
  - `unknown` chỉ dùng khi request đã gửi mà không có kết quả.
- [x] **Engine: không retry vô hạn.**
  - Đã sửa (2026-10-29): Backoff 2 s → 60 s, quá 5 lần / 5 phút thì pause `ORDER_REJECTED` + event lỗi kèm mã; sự kiện thị trường thì hoàn tác bước chiến lược để thử lại đúng lệnh. `setLeverage`: đọc account state `S` trước, `unknown` thì chỉ gửi lại khi đọc được và thấy chưa áp dụng. Test engine: 21/21 (thêm 4 test).
  - Với `not_sent`: backoff mũ (2 s → 4 s → … tối đa 60 s). Quá 5 lần hoặc 5 phút thì pause bot và ghi event lỗi kèm mã.
  - Với `unknown` của `setLeverage`: đọc lại đòn bẩy và margin mode hiện tại của account qua REST để đối soát trước khi gửi lại (quy tắc 1.7), không gửi mù.
- [x] **Reason code mới — người dùng đã duyệt (2026-10-29): `API_KEY_UNUSABLE`** (paused, scope account). Dùng khi key còn `active` và còn hạn nhưng signer không ký được (decrypt lỗi, key bị SoDEX từ chối vì không tồn tại…). UI báo "DRIFT can't sign with your API key. Renew it in Settings › SoDEX access." Resume giống `API_KEY_EXPIRED`: chỉ sau khi ký lại key, rồi người dùng tự resume từng bot. Claude Code thêm mã vào `packages/shared/src/enums.ts` (`ReasonCode` + `REASON_CODE_META`), DOMAIN.md mục 7.2, i18n, ghi DEC mới trong `docs/DECISIONS.md`, kèm unit test cho state machine.
  - Đã sửa (2026-10-29): `API_KEY_UNUSABLE` trong `ReasonCode` + `REASON_CODE_META` (paused, account), DOMAIN.md 7.2, i18n `reasons`, email `notify.ts`, resume như `API_KEY_EXPIRED`; test state machine; DEC-56.
- [x] **Check "DRIFT API key" phải kiểm tra key dùng được.** Thêm endpoint nội bộ của signer `POST /v1/keys/:id/verify`: chỉ decrypt rồi bỏ, không ký, không trả gì về secret. `startChecks` và `/sodex/connection` gọi endpoint này; lỗi thì check ✕ "Renew the key in Settings", header không được ghi "SoDEX connected".
  - Đã sửa (2026-10-29): Signer `POST /v1/keys/:id/verify` (+ test với khoá transit khác → 422); `startChecks` và `/sodex/connection` gọi qua `verifyApiKey` (cache 60 s); key không dùng được → check ✕ detail `unusable`, `apiKey.status = unusable`, header "SoDEX key needs renewal" (desktop + mobile). Test API.
- [x] **UI bot đang chờ:** ở trạng thái chuyển tiếp (`Starting…`) quá 60 s thì Agent và Strategy Lab hiện "Waiting for SoDEX longer than usual · since 16:54", cùng event lỗi gần nhất. Không để người dùng nhìn "Starting" 16 tiếng mà không có lý do.
  - Đã sửa (2026-10-29): `waitingTooLong` (> 60 s ở trạng thái chuyển tiếp): Strategy Lab (cột Status) và Trading Agent (hero, kèm event lỗi gần nhất) hiện "Waiting for SoDEX longer than usual · since {time}".
- [x] **Người dùng tự gỡ được ngay:** Settings › SoDEX access phải có nút "Renew key (sign again)…" (đã ghi ở E9). Hiện chỉ còn cách Disconnect rồi kết nối lại.
  - Đã sửa (2026-10-29): Nút "Renew key (sign again)…" (DEC-59).

### H2. Nút "Start on mainnet" không bao giờ bật

Nút chỉ bật khi đạt **đủ 6 điều kiện** (`create-bot.tsx:333`):
1. đã bấm **Save draft** (`botId !== null`);
2. **không sửa gì sau khi save** (`!dirty`): sửa một ô bất kỳ thì checklist biến mất, quay về "Save the draft to run the checks.";
3. **mọi check đều ✓** (`allOk`);
4. đã tick ô xác nhận;
5. đã nhập mã 2FA đủ 6 số;
6. AI parameters không đang chạy.

UI không nói điều kiện nào còn thiếu. Nút disabled lại có màu đỏ nhạt (E7), nên trông như lỗi chứ không như "chưa đủ điều kiện".

**Trường hợp cụ thể đã kiểm tra — draft "NVDA" (Spot Grid, `vNVDA_vUSDC`):** `GET /bots/:id/checks` trả `min_size: false`, các check khác ✓. Config: investment 50 USDC, 10 levels, range 212.64–239.12. Mỗi lệnh khoảng 5 USDC ÷ giá ≈ 0.022 NVDA; sau làm tròn, lệnh ở các mức giá thấp nhỏ hơn mức tối thiểu của SoDEX. **Logic check đúng**; vấn đề là UI chỉ ghi "Below SoDEX minimum order size." mà không nói cần bao nhiêu.

**Sửa:**
- [x] **Chạy check trực tiếp, không bắt Save draft.** Thêm `POST /api/v1/bots/checks` nhận `{ strategy, config }` (dry run, không ghi DB), gọi debounce 500 ms khi form hợp lệ. Checklist luôn hiện và cập nhật theo ô đang nhập.
  - Đã sửa (2026-10-29): `POST /api/v1/bots/checks` (dry run, config parse bằng zod, không ghi DB) + `useDryRunChecks` (debounce 500 ms, chỉ khi form hợp lệ). Test API: dry run bằng checks của draft đã lưu.
- [x] **Bấm "Start on mainnet" thì tự lưu draft** (tạo bot hoặc version mới) nếu `dirty`, chạy check lại, rồi mới start; chỉ dừng nếu có check ✕. Nút "Save draft" giữ lại cho người muốn lưu mà chưa chạy.
  - Đã sửa (2026-10-29): Start lưu draft / version mới nếu chưa lưu hoặc đã đổi, rồi start; server kiểm tra lại checks khi start. "Save draft" giữ nguyên.
- [x] **Nói rõ vì sao nút còn tắt.** Ngay trên nút hiện danh sách điều kiện còn thiếu, ví dụ "To start: tick the confirmation · enter your 2FA code · fix Order sizes". Mỗi mục là link cuộn tới chỗ cần sửa. Nút disabled dùng màu xám (`bg-surface-2`, chữ `ink-3`), không dùng đỏ nhạt.
  - Đã sửa (2026-10-29): Dòng "To start: …" ngay dưới nút, mỗi mục là link (`#start-ack`, `#start-2fa`, `#check-<key>`, `#settings`); `Button` disabled (không pending) dùng nền `surface-2`, chữ `muted` cho mọi variant.
- [x] **Check min size phải nói con số.**
  - Đã sửa (2026-10-29): `minSizeDetail` (packages/strategies, thuần): lệnh nhỏ nhất sau làm tròn, mức tối thiểu SoDEX, vốn tối thiểu đề xuất (tìm nhị phân trên `meetsMinSize`); API trả trong `data` của check; UI ghi "Smallest order ≈ … ; SoDEX minimum … . Use at least … USDC or fewer grid levels."
  - API trả `detail` gồm lệnh nhỏ nhất sau làm tròn, mức tối thiểu của SoDEX (`minNotional` / `minQuantity`), và **vốn tối thiểu đề xuất** tính bằng công thức tất định: tìm investment nhỏ nhất để mọi lệnh ≥ minimum với cùng levels và range.
  - UI ghi, ví dụ: "Smallest order ≈ {min} USDC; SoDEX minimum {required} USDC. Use at least {investment} USDC or fewer grid levels." Số lấy từ API, không bịa.
- [x] Mỗi check ✕ có hành động đi kèm: balance → hiện số dư khả dụng và số cần; api_key → link "Renew key"; fresh_price → "Waiting for a live price from SoDEX…".
  - Đã sửa (2026-10-29): balance: "Available X · needs Y"; api_key: link "Renew key →" (Settings); builder fee / 2FA: link tới Settings; fresh_price: "Waiting for a live price from SoDEX…".
- [x] Unit test: `meetsMinSize` với dữ liệu NVDA ở trên; tính vốn tối thiểu đề xuất; dry-run checks trả cùng kết quả với checks của draft đã lưu.
  - Đã sửa (2026-10-29): `min-size.test.ts` với dữ liệu NVDA thật (rules `vNVDA_vUSDC` đọc từ SoDEX): fail, vốn đề xuất đạt và thấp hơn 0.01 thì không đạt; dry run = checks của draft (`bots.test.ts`).

## I. Portfolio thiếu phần Perps (2026-10-29)

Người dùng phản ánh: Portfolio có vẻ chỉ hiện dữ liệu Spot, bỏ quên Perps. Kiểm tra `/portfolio` ở 1440 px, `GET /api/v1/portfolio`, `apps/api/src/modules/account/service.ts:98` và `packages/shared/src/portfolio/value.ts`. So với `Portfolio.dc.html` và `M-Portfolio.dc.html`.

### I1. Đang xảy ra gì

- **Backend có đọc Perps**, nhưng chỉ dùng để **cộng dồn** vào số tổng (`valuePortfolio`):
  - Equity = giá trị Spot + `av` của Perps (+ isolated).
  - Available = vUSDC Spot chưa khoá + `am` của Perps.
  - Margin in use, danh sách vị thế mở.
- **Số liệu thật lúc review:** equity `245.39`, available `225.30`. Nhưng danh sách duy nhất trên trang là "Spot holdings" (vUSDC `101.84` + 2 coin chưa có giá). Khoảng **143.55 USDC** nằm ở Perps (`245.39 − 101.84`) và khoảng **123.46 USDC** khả dụng ở Perps (`225.30 − 101.84`), nhưng **không hiện ở bất kỳ đâu**. Đây là lý do người dùng thấy "chỉ có Spot".
- Không có vị thế mở, nên tab Open positions trống. Đúng với dữ liệu, nhưng càng làm phần Perps "biến mất".
- **Artboard cũng thiếu:** `Portfolio.dc.html` chỉ có 4 ô tổng + bảng vị thế, không có khối số dư theo engine. Phần sửa dưới đây là **bổ sung thiết kế**. Claude Code ghi thành DEC mới và cập nhật `docs/SCREENS.md` (mục Portfolio) trước khi code.

### I2. Vì sao phải tách theo engine

- Bot Spot chỉ dùng được tiền ở ví Spot; bot Perps chỉ dùng margin ở Perps. Check "Balance" của màn Create cũng kiểm tra theo engine (`startChecks`).
- Hiện "Available balance 225.30 USDC" là gộp hai ví. Người dùng tưởng có 225 USDC cho bot Spot, nhưng thực tế chỉ có 101.84.

### I3. Sửa

- [x] **API:** `PortfolioView` thêm khối `accounts`. Mọi số lấy nguyên từ SoDEX; thiếu thì `null`, không suy ra:
  - Đã sửa (2026-10-29, DEC-58): `valuePortfolio` + `portfolioViewSchema.accounts` (bản đầy đủ ở mục "Hệ quả" bên dưới); `equity` / `available` không đổi. Test `valuePortfolio` với số liệu thật của review.
  ```ts
  accounts: {
    spot:  { value: string; available: string; inOrders: string; unpricedCoins: string[] };
    perps: { accountValue: string;      // av (+ isolated iw + ur, như equity hiện tại)
             walletBalance: string | null; // Σ B[].wb (quote)
             availableMargin: string;    // am
             marginInUse: string;        // cm + im
             unrealizedPnl: string;
             openPositions: number } | null; // null khi chưa đọc được Perps
  }
  ```
  `equity` và `available` giữ như cũ (= tổng hai khối), để Overview và Risk không đổi.
- [x] **UI: thêm hàng "Accounts"**, ngay dưới 4 ô tổng: 2 thẻ cạnh nhau (mobile xếp dọc).
  - Đã sửa (2026-10-29, DEC-58): `accounts-row.tsx`: thẻ Spot (Value, Available USDC, In orders, coin chưa có giá) và thẻ Perps (Account value, Usable as margin, Usable for isolated, Margin in use + thanh, Unrealized PnL, Open positions), chip engine Spot xanh / Perps tím; mobile xếp dọc.
  - **Spot**: Value · Available USDC · In orders · số coin chưa có giá (nếu có).
  - **Perps**: Account value · Wallet balance · Available margin · Margin in use (thanh %) · Unrealized PnL · Open positions.
  - Mỗi thẻ có chip engine giống Strategy Lab (Spot xanh, Perps tím).
- [x] **Ô "Available balance"** đổi hint thành dạng tách: `Spot 101.84 · Perps 123.46`, để không ai hiểu nhầm là một ví.
  - Đã sửa (2026-10-29, DEC-58): Hint `Spot 101.84 · Perps 123.46` (Perps = `am`).
- [x] **Ô "Margin in use"**: khi chưa có vị thế, hiện `0% · 0 of 143.55 USDC Perps`, không chỉ `0%` và "0.00 USDC of margin".
  - Đã sửa (2026-10-29, DEC-58): Hint `0% · 0.00 of 143.61 USDC Perps` kèm thanh.
- [x] **Tab "Spot holdings"** đổi tên thành **"Balances"** và có 2 nhóm: Spot (từng coin) và Perps (từng coin trong `B[]` với `wb`). Hoặc giữ "Spot holdings" và thêm tab "Perps balance". Chọn cách 2 tab nếu `B[]` thường chỉ có vUSDC.
  - Đã sửa (2026-10-29, DEC-58): Tab "Balances": nhóm Spot (từng coin) + nhóm Perps (bảng collateral từ `B[]`).
- [x] **Đã giải thích: khoản ≈ 20 USDC là haircut của Multi-Asset Margin** (người dùng chỉ ra; tài liệu SoDEX: https://sodex.com/documentation/trading-mechanics/multi-asset-margin). Đã xác minh bằng `GET /api/v1/perps/accounts/{addr}/state` (mainnet, 2026-10-29):

  | Asset (`B[]`) | `wb` | `px` (index) | Giá trị đủ | `mr` | `wm` (tính vào margin) |
  |---|---|---|---|---|---|
  | vUSDC | 101.6227 | 1 | 101.62 | 1.0 | 101.62 |
  | WSOSO | 130.2262 | 0.30009 | 39.08 | 0.5 | 19.54 |
  | vQQQ | 0.004045 | 718.19 | 2.91 | 0.8 | 2.32 |
  | **Tổng** | | | **143.61 = `av`** | | **123.49 = `am`** |

  Vậy `av` là giá trị theo index **chưa trừ haircut**, còn `am` là margin dùng được **sau** collateral ratio. `ami = 101.62` là phần USDC, tức margin dùng được cho vị thế **Isolated**: Isolated không dùng được tài sản thế chấp khác USDC. Không có lệnh ngoài DRIFT nào giữ tiền (`O`, `TO`, `DO` đều rỗng).

- [x] **Hệ quả cho khối `accounts.perps` (thay bản ở trên):**
  - Đã sửa (2026-10-29, DEC-58): Đúng cấu trúc này: `accountValue` (av + isolated), `availableMargin` (am), `availableIsolated` (ami), `marginInUse`, `unrealizedPnl`, `openPositions`, `collateral[]` (asset, balance, indexPrice, value = wb × px, collateralRatio, marginValue); schema `perpsAccountStateSchema` đọc thêm `ami`, `px`, `mr`, `wm`.
  ```ts
  perps: {
    accountValue: string;        // av: giá trị theo index, chưa haircut
    availableMargin: string;     // am: margin dùng được cho Cross (đã haircut)
    availableIsolated: string;   // ami: chỉ USDC, dùng cho Isolated
    marginInUse: string;         // cm + im
    unrealizedPnl: string;
    openPositions: number;
    collateral: {                // từ B[]; px, mr, wm lấy nguyên của SoDEX
      asset: string; balance: string; indexPrice: string;
      value: string;             // wb × px
      collateralRatio: string;   // mr
      marginValue: string;       // wm
    }[];
  } | null
  ```
- [x] **UI thẻ Perps:**
  - Đã sửa (2026-10-29, DEC-58): Thẻ Perps hiện Account value và Usable as margin, dòng "Haircut X USDC · Non-USDC collateral counts at its collateral ratio (Multi-Asset Margin)" + link tài liệu SoDEX; bảng Collateral ở tab Balances (USDC đứng đầu).
  - Hiện cả hai số: `Account value 143.61` và `Usable as margin 123.49`, kèm dòng giải thích "Non-USDC collateral counts at its collateral ratio (Multi-Asset Margin)" và link tài liệu SoDEX.
  - Bảng **Collateral**: Asset · Balance · Index price · Value · Ratio · Counts as margin. Dòng USDC đứng đầu.
  - Có chênh lệch thì ghi rõ: `Haircut 20.12 USDC`.
- [x] **USDC âm:** SoDEX cho phép số dư USDC ở Perps âm (lỗ, phí, funding chỉ trừ bằng USDC) và có thể bị thanh lý dù không có vị thế. Khi `wb` của vUSDC < 0: thẻ Perps hiện cảnh báo đỏ "Negative USDC balance −X. Your other collateral is backing it and can be liquidated if prices fall. Add USDC or convert collateral." Risk Center hiện cùng cảnh báo. Đã sửa (2026-10-29): `apps/web/src/features/account/components/{accounts-row,risk-page}.tsx`.
- [x] **Giá của coin "chưa có giá":** Spot đang báo `SOSO`, `MAG7ssi` "no price yet" vì tìm market `<coin>_vUSDC` không ra. `B[].px` của Perps có index price cho các coin thế chấp (WSOSO có `px`). Dùng `px` này để định giá coin tương ứng ở Spot, ghi nguồn là "SoDEX index price". Coin không có trong `B[]` và không có market thì vẫn "Not included".
  - Đã sửa (2026-10-29, DEC-58): Coin Spot không có market được định giá bằng `B[].px` (index price SoDEX), ghi "Priced at the SoDEX index price: …" dưới Equity; coin không có trong `B[]` vẫn "Not included". Có test.

- [x] **Lỗi logic liên quan (quan trọng hơn UI):**
  - Đã sửa (2026-10-29, DEC-58): Balance của bot Perps: Cross → `am`, Isolated → `ami`, Funding Arb chân perp → Cross; fail ghi "Needs X USDC; usable as margin Y (isolated: Z)". Available phần Perps vẫn là `am`. Test API (Isolated ✕ dù `am` đủ) + test `valuePortfolio` (Cross / Isolated khác nhau).
  - Check **Balance** của bot Perps (`startChecks`, `apps/api/src/modules/bots/service.ts`) đang so vốn cần với `getPerpsAccountValue()` = `av`, tức giá trị **chưa haircut**. Bot có thể qua check dù margin thật không đủ. Sửa:
    - Margin mode **Cross** → so với `am`.
    - **Isolated** → so với `ami`, vì Isolated chỉ dùng USDC.
    - Funding Arb (chân perp): theo margin mode của chân perp.
  - Check fail thì ghi rõ: "Needs 150 USDC; usable as margin 123.49 (isolated: 101.62)".
  - Ô "Available balance" ở 4 ô tổng: phần Perps phải là `am`, không phải `av`. Hiện code đã dùng `am`; giữ nguyên và ghi chú trong DEC.
  - Unit test: account có collateral không phải USDC; Cross và Isolated cho ra số khả dụng khác nhau.
- [x] **Ghi chú đòn bẩy theo symbol:** state có `S[]` là đòn bẩy và margin mode **đang đặt cho từng symbol** của account (ví dụ `BTC-USD 40× CROSS`, `COIN-USD 5× ISOLATED`). Đòn bẩy trên SoDEX đặt theo account + symbol, nên bot Futures Grid đặt `BTC-USD 2×` sẽ đổi luôn đòn bẩy người dùng đang dùng khi tự giao dịch BTC-USD.
  - Đã sửa (2026-10-29, DEC-58): Check `leverage_conflict` (✕ vị thế xung đột, ✕ bot DRIFT khác cùng symbol khác thiết lập, ✓ + cảnh báo vàng + checkbox riêng khi chỉ khác cài đặt), engine kiểm tra lại trước `updateLeverage` (vị thế xung đột → không đổi, pause `ORDER_REJECTED` + event). Hàm thuần `leverageConflict` + 5 test, test API và test engine. SCREENS.md 8.2, SODEX.md cập nhật.
  - Màn Create bot Perps phải báo trước: "Your BTC-USD leverage on SoDEX is 40× cross. Starting this bot sets it to 2× isolated for the whole account."
  - **Người dùng đã chốt (2026-10-29): chặn khi có vị thế.**
    - Thêm check mới `leverage_conflict` vào "Before it starts" (`startChecks`) cho mọi bot Perps (Futures Grid, Futures DCA, Funding Arb chân perp, TWAP perps, Volume Maker).
    - **Chặn (✕)** khi trên symbol đó đang có vị thế mở (`P[]` có `sz ≠ 0`) và `S[]` khác đòn bẩy hoặc margin mode của bot. Câu chữ: "You have an open BTC-USD position at 40× cross. Close it or match this bot to 40× cross before starting."
    - **Chặn (✕)** khi đã có bot DRIFT khác đang chạy trên cùng symbol với đòn bẩy hoặc margin mode khác, vì hai bot sẽ ghi đè nhau. Câu chữ: "Your bot "Grid BTC" runs BTC-USD at 3× isolated."
    - **Không có vị thế, chỉ khác cài đặt** → check ✓ kèm cảnh báo vàng "Your BTC-USD leverage on SoDEX is 40× cross. Starting this bot sets it to 2× isolated for your whole account." và một checkbox xác nhận riêng. Nút Start chỉ bật khi đã tick.
    - Cùng đòn bẩy và margin mode → ✓, không cảnh báo.
    - Kiểm tra lại ở **engine** ngay trước `setLeverage` (lúc start, resume và khi áp dụng version mới đổi leverage/margin mode). Nếu lúc đó có vị thế xung đột thì không đổi đòn bẩy, pause bot với `ORDER_REJECTED`, kèm event "Leverage not changed: open BTC-USD position at 40× cross." Đây không phải retry; người dùng tự resume.
    - Dữ liệu lấy từ `GET /perps/accounts/{addr}/state` (`S[]`, `P[]`), không cache quá 10 s khi chạy check.
    - Unit test: có / không vị thế; khác đòn bẩy; khác margin mode; hai bot cùng symbol.
    - Claude Code ghi thành DEC mới trong `docs/DECISIONS.md` và thêm vào `docs/SCREENS.md` mục 8.2 (checks) cùng `docs/SODEX.md` (đòn bẩy theo account + symbol).
- [x] **Overview**: thẻ Equity / Risk snapshot dùng cùng khối `accounts`, có dòng `Spot X · Perps Y` dưới số equity.
  - Đã sửa (2026-10-29, DEC-58): Hero Overview có dòng `Spot X · Perps Y` dưới equity (từ `accounts`).
- [x] **Unit test** `valuePortfolio`: account chỉ có Perps, chỉ có Spot, cả hai; có / không có vị thế isolated; `B[]` rỗng.
  - Đã sửa (2026-10-29, DEC-58): 4 test mới: Multi-Asset Margin thật (am / ami / collateral), định giá bằng index price, chỉ Spot / chỉ Perps / `B[]` rỗng, vị thế isolated.

## J. Review tổng thể — góp ý cải thiện (2026-10-29)

> Xem lại 8 màn desktop 1440×900 và Overview + Strategy Lab ở 375×812, account thật (#1645, có 3 bot, đang có key không ký được — xem H1). Mục nào đổi câu chữ hoặc hành vi so với thiết kế thì Claude Code ghi DEC trước khi sửa.

### J1. Số liệu dễ gây hiểu lầm (làm trước, liên quan quy tắc 1.8)
- [x] **"+200.77 USDC (+449.69%) last 24 hours"** (Overview hero, mobile cũng vậy) và **"Equity is up 449.67% over 24 hours"** (AI Analyst › Today's briefing).
  - Đã sửa (2026-10-29, DEC-70): hero không còn %, màu trung tính + "Equity change · includes deposits and transfers"; AI Analyst bỏ câu % equity. Test analyst cập nhật.
  - Biểu đồ Performance cho thấy equity nhảy bậc từ ~44 lên ~245 trong một điểm: đó là tiền nạp vào, không phải lợi nhuận. Ngay dưới biểu đồ app đã ghi "Net deposits: Not available".
  - Sửa (tao quyết định): khi net deposits không có, **không hiện %** và đổi nhãn thành "Equity change · includes deposits and transfers". Màu trung tính (không xanh/đỏ, không mũi tên ↗).
  - AI Analyst không được dùng % thay đổi equity làm câu mở đầu khi không có net deposits. Dùng realized PnL của kỳ (đã có: −0.27 USDC) hoặc bỏ câu đó.
  - Test: fixture có một lần nạp tiền giữa kỳ → hero không hiện %, briefing không nói "up X%".
- [x] **Profit "0"** cho bot Futures Grid BNB-USD (Overview › My Profit Bots, Strategy Lab) trong khi bot NVDA ghi "Not available" và BTC ghi "−0.03". Bot chưa có fill nào thì hiện "No fills yet", bot có fill thì có đơn vị: "−0.03 USDC". Không hiện `0` trần.
  - Đã sửa (2026-10-29, DEC-70): `BotSummary.fills`; `BotProfit` hiện "No fills yet" hoặc PnL kèm đơn vị (Overview, Strategy Lab, Trading Agent).
- [x] **Trục Y biểu đồ Performance** đang là 24.48 · 105 · 185 · 266 (chia đều từ min/max). Dùng nice ticks (ví dụ 0 · 100 · 200 · 300), số chẵn, cùng số chữ số thập phân.
  - Đã sửa (2026-10-29, DEC-70): `niceTicks` (`apps/web/src/lib/nice-ticks.ts`, 5 test), nhãn trục cùng số thập phân.

### J2. Trạng thái kết nối nói sai sự thật
- [x] Chip **"SoDEX connected"** (header mọi màn) và badge **"Connected"** (Settings › SoDEX access) vẫn xanh trong khi bot vừa pause vì "DRIFT can't sign with your API key".
  - Đã sửa (2026-10-29, DEC-71): chip header vàng "SoDEX · key needs renewal" khi verify fail hoặc có bot paused `API_KEY_UNUSABLE` sau khi tạo key; Settings có pill "Key unusable", banner, Renew key là nút chính; engine ghi `last_used_at` (throttle 60 s), null → "Never".
  - Khi có bot pause `API_KEY_UNUSABLE` hoặc lần verify key gần nhất fail: chip đổi thành vàng "SoDEX · key needs renewal", bấm vào mở Settings › SoDEX access.
  - Settings: badge "Key unusable" + banner vàng trên cùng thẻ: "DRIFT can't sign with this key. Renew it to resume your bots." với nút **Renew key** là nút chính (hiện đang là nút phụ màu nhạt).
  - "Last used: Not available" → lấy thời điểm ký thành công gần nhất từ signer; chưa từng ký thì "Never".

### J3. Overview
- [x] Thẻ **Trading Agent**: "Last action" trống, phần dưới thẻ trống ~120 px. Hiện 3 event gần nhất của bot (đã có trong Recent activity) hoặc thu thẻ lại theo nội dung.
  - Đã sửa (2026-10-29, DEC-71): hiện 3 event gần nhất ("Recent actions"), trống → "No activity yet".
- [x] Thẻ bot đầu tiên trong **My Profit Bots** không có tên và symbol (chỉ có avatar "B" + Paused). Hiện tên bot + symbol như hai thẻ còn lại.
  - Đã sửa (2026-10-29, DEC-71): dữ liệu tên có đủ; lỗi do pill trạng thái dài ép mất tên. Header thẻ đổi sang flex-wrap.
- [x] Tên bot mặc định đang là tên chiến lược ("Futures Grid") hoặc base asset ("NVDA", "BTC"). Thống nhất một quy tắc: `<Base> <Strategy>`, ví dụ "BNB Futures Grid". Người dùng vẫn đổi được.
  - Đã sửa (2026-10-29, DEC-71): `defaultBotName` → `<Base> <Strategy>`, dùng làm placeholder và giá trị khi để trống (3 test).
- [x] Mobile: dòng thay đổi equity bị ngắt 4 dòng cạnh "last 24 hours". Đặt nhãn kỳ xuống dòng riêng dưới số; 4 ô tổng xếp 2×2 như `Mobile-Home.dc.html`, không phải 1 cột.
  - Đã sửa (2026-10-29, DEC-71): nhãn kỳ xuống dòng riêng; ô tổng 2×2 dưới lg.

### J4. Strategy Lab
- [x] **Mobile 375 px**: bảng My bots cuộn ngang, cột Status, Profit, Actions bị đẩy ra ngoài màn. Ở < 768 px đổi sang danh sách thẻ như `Mobile-Bots.dc.html`: tên + symbol, chip trạng thái, profit, một nút hành động chính.
  - Đã sửa (2026-10-29, DEC-72): < 768 px hiện danh sách thẻ: tên, market · chiến lược, chip trạng thái, profit, một nút chính.
- [x] Mobile: hai bộ lọc Status / Engine xếp 2 dòng. Đặt cùng một hàng (mỗi ô 50%).
  - Đã sửa (2026-10-29, DEC-72): hai bộ lọc chia đôi một hàng trên mobile.
- [x] Desktop: nút hành động không đồng nhất ("Resume" + "Edit", "Continue", "View"). Giữ đúng một nút chính theo trạng thái + menu "⋯" cho phần còn lại; bot paused vì key thì nút chính là "Renew key", không phải "Resume" (Resume chắc chắn fail).
  - Đã sửa (2026-10-29, DEC-72): `botActions` (3 test): một nút chính + menu ⋯; bot paused vì key → "Renew key".

### J5. Execution & Orders
- [x] Mặc định lọc **Time: Today** nên màn trống dù hôm qua có lệnh. Mặc định "Last 7 days". Empty state khi lọc ra rỗng có nút "Show last 30 days" và "Clear filters".
  - Đã sửa (2026-10-29, DEC-72): mặc định "7 days"; empty state có "Show last 30 days" và "Clear filters".
- [x] Ô "Slippage · Not available · No reference price stored yet" chiếm 1/4 hàng tổng. Khi chưa có dữ liệu, thu nhỏ thành dòng phụ dưới hàng tổng.
  - Đã sửa (2026-10-29, DEC-72): slippage thành dòng phụ dưới hàng tổng.

### J6. Risk Center
- [x] Thẻ **Concentration** có chip "Not available" bị ép 2 dòng, đè tiêu đề. Chip cùng kích thước với "Server-enforced" / "UI warning only", không xuống dòng.
  - Đã sửa (2026-10-29, DEC-72): chip `flex-none whitespace-nowrap`, tiêu đề `min-w-0`.
- [x] Số và "Not set" nằm cùng hàng nhưng khác cỡ, đọc thành "0.16% Not set". Đổi thành "0.16% of limit · No limit set" hoặc khi chưa có giới hạn thì ẩn thanh tiến độ và hiện nút "Set limit" (giống Risk snapshot ở Overview).
  - Đã sửa (2026-10-29, DEC-72): chưa có giới hạn → "No limit set", ẩn thanh tiến độ, nút "Set limit".
- [x] Link "Edit…" ở mỗi thẻ là chữ 12 px, vùng bấm < 44 px. Đổi thành nút nhỏ có vùng bấm 44 px.
  - Đã sửa (2026-10-29, DEC-72): nút viền, `min-h-tap` (44 px), aria-label kèm tên giới hạn.

### J7. AI Analyst
- [x] Ngữ pháp số nhiều: "1 fills paid", "over 1 days". Dùng ICU plural trong `messages/en.json`.
  - Đã sửa (2026-10-29, DEC-72): helper `count` trong analyst (test mới); chuỗi đếm trong en.json chuyển ICU plural.
- [x] "Based on data as of 06:39:22 UTC" dùng UTC, các màn khác dùng giờ địa phương ("Oct 29, 13:38:28"). Thống nhất giờ của user + ghi múi giờ một lần trong Settings › Profile.
  - Đã sửa (2026-10-29, DEC-72): analyst nhận `users.timezone`, định dạng "Oct 29, 13:39:22", bỏ "UTC".

### J8. Chung
- [x] **Định dạng thời gian không thống nhất**: "Updated 5s ago" (Overview), "Risk engine checked Oct 29, 13:38:28" (Risk), "Positions updated Oct 29, 13:39:35" (Portfolio), "0s ago" (mobile). Chọn một: tương đối ("Updated 5s ago") cho chip header, tuyệt đối có tooltip.
  - Đã sửa (2026-10-29, DEC-72): chip header luôn tương đối ("… 12s ago"), giờ tuyệt đối ở tooltip `title`.
- [x] **Trang 404** (`/admin` và route không tồn tại) là trang mặc định của Next.js, chữ đen nền trắng, không có nav. Thêm `app/not-found.tsx` dùng layout DRIFT: "This page doesn't exist." + nút "Back to Overview".
  - Đã sửa (2026-10-29, DEC-72): `app/not-found.tsx` dùng header DRIFT + "This page doesn't exist." + "Back to Overview".
- [x] Khối **EMERGENCY** ở sidebar luôn hiện cả khi không có bot nào đang chạy. Khi 0 bot running: thu lại thành một dòng "Halt all agents" màu nhạt; khi có bot running mới hiện đầy đủ khối đỏ.
  - Đã sửa (2026-10-29, DEC-72): 0 bot running → một dòng nhạt "Halt all agents…"; có bot running → khối đỏ.
- [x] Mục nav **Users** (role team) nằm chung nhóm với Builder Revenue và Settings. Tách nhóm "Team" có nhãn nhỏ, để người dùng thường không thấy (đã ẩn theo role — kiểm tra lại bằng account không phải team).
  - Đã sửa (2026-10-29, DEC-72): nhóm "Team" có nhãn trong sidebar; lọc theo role giữ nguyên (`TEAM_ONLY`), account thường không thấy.

## K. Landing page (mới, 2026-10-29)

> Artboard **"Landing · Public"** (`Landing.dc.html`, desktop 1440 + responsive) đã thêm vào canvas DRIFT Redesign, hàng "Public". Đây là thiết kế mới, chưa có trong `docs/SCREENS.md`.

- [x] **Route**: `/` khi **chưa đăng nhập** hiện Landing (hiện đang redirect 307 về `/signin`). Đã đăng nhập thì `/` vẫn là Overview. Claude Code ghi DEC mới + thêm vào SCREENS.md mục 8 (route ↔ artboard) và mục 9 (public pages).
  - Đã sửa (2026-10-29, DEC-69): `app/page.tsx` theo cookie phiên; SCREENS.md mục 8 có hàng Landing; e2e p11-auth-gate.
- [x] Trang tĩnh, render server-side, không gọi API cần đăng nhập. Không có số liệu marketing (số user, volume, % lợi nhuận): quy tắc 1.8. Danh sách chiến lược lấy từ cùng nguồn với Strategy catalog (8 chiến lược; Volume Maker không hiện khi flag tắt).
  - Đã sửa (2026-10-29, DEC-69): Landing không gọi API; `LANDING_STRATEGIES` 8 chiến lược, không có Volume Maker (unit test).
- [x] Nút: "Create account" → `/signup`, "Sign in" → `/signin`, "How it works" → anchor trong trang. Footer chỉ có link "Risk Disclosure" → `/risk` (mục L).
  - Đã sửa (2026-10-29, DEC-69): đã có; footer chỉ link "Risk Disclosure" → `/risk-disclosure` (`/risk` là Risk Center).
- [x] Câu chữ chép nguyên văn từ artboard vào `messages/en.json` (namespace `landing`).
  - Đã sửa (2026-10-29, DEC-69): namespace `landing` đã có.
- [x] SEO: `<title>DRIFT · Profit bots for SoDEX</title>`, meta description, Open Graph image (chụp hero). `robots` cho phép index chỉ trang này.
  - Đã sửa (2026-10-29, DEC-73): title + description + Open Graph (ảnh `opengraph-image`), noindex mặc định, chỉ Landing index, `robots.txt`. e2e `p11-public`.
- [x] Mobile 375 px: mọi section xếp 1 cột, nav thu thành logo + "Sign in"; không cuộn ngang. Kiểm tra axe không lỗi.
  - Đã sửa (2026-10-29, DEC-73): e2e `p11-public` chạy axe + kiểm cuộn ngang ở 1440 và 390 cho `/`, `/risk-disclosure`, 404.

- [x] **Đã làm (2026-10-29, DEC-69):** `features/public` (`LandingPage`, `RiskDisclosurePage`, `PublicHeader`, `StrategyGrid` có lọc All/Spot/Perps), `app/page.tsx` (cookie → Landing hoặc Overview, metadata + Open Graph khi chưa đăng nhập), `app/risk-disclosure/page.tsx`, `proxy.ts` (`redirectFor`), checkbox Signup, câu chữ `landing` + `riskDisclosure`, token `--on-ink-*`. Test: `features/public/__tests__/public.test.ts` (proxy, danh sách chiến lược, không còn "Terms"/"0.05%"/placeholder), e2e `p11-auth-gate` cập nhật (chưa chạy e2e). Đã xem trên `next dev` ở 1440 và 375 px: không cuộn ngang, bộ lọc và FAQ chạy. **Chưa làm:** ảnh Open Graph, quét axe, chạy e2e. Container `web` đã build lại; `http://localhost` có trang mới. Còn: khi **đã đăng nhập** mà mở `/risk-disclosure`, header vẫn hiện "Sign in / Create account" — nên đổi thành nút "Back to Overview".

## L. Risk Disclosure (thay bản 3 trang pháp lý, 2026-10-29)

> **Người dùng quyết định (2026-10-29):** DRIFT là app cá nhân, không có công ty → **bỏ Terms of Service và Privacy Policy**, chỉ giữ **Risk Disclosure**. Canvas đã gỡ hai artboard kia; còn `Legal-Risk.dc.html` (hàng "Public", tiêu đề "Public · Risk Disclosure").

- [x] **Route** công khai `/risk-disclosure` (`/risk` đã là Risk Center), không cần đăng nhập. Header (logo → `/`, Sign in, Create account), mục lục anchor bên trái, nội dung bên phải; < 768 px mục lục xếp lên trên. Không có thanh chuyển tài liệu.
- [x] Nội dung chép nguyên văn từ artboard vào `messages/en.json` (namespace `risk`). Không còn placeholder nào; dòng ngày là "Last updated Oct 29, 2026".
  - Đã sửa (2026-10-29, DEC-69): namespace `riskDisclosure` (vì `risk` là Risk Center), dòng ngày "Last updated Oct 29, 2026".
- [x] Nội dung đã khớp hành vi thật: LIVE mainnet, đòn bẩy và thanh lý, Multi-Asset Margin (USDC âm, thanh lý khi không có vị thế), đòn bẩy theo account + symbol (DEC-58), rủi ro từng chiến lược, backtest không phải dự báo, phí builder 0.01% (DEC-46). Hành vi đổi thì sửa trang này cùng PR.
  - Đã sửa (2026-10-29, DEC-69): các section loss, leverage, margin, sharedLeverage, strategy, backtest, technical, costs (phí lấy từ `DRIFT_BUILDER_FEE_RATE`), actions.
- [x] **Signup** (desktop + mobile): checkbox đổi thành "I have read the Risk Disclosure. Automated trading can lose money…" với link `/risk`. Không còn chữ "Terms". Vẫn bắt tick mới cho tạo account.
  - Đã sửa (2026-10-29, DEC-69): checkbox "I have read the Risk Disclosure…" link `/risk-disclosure`, vẫn bắt buộc tick; test không còn "Terms".
- [x] Landing: footer chỉ còn link "Risk Disclosure".
  - Đã sửa (2026-10-29, DEC-69): `PublicFooter` chỉ có "Risk Disclosure".
- [x] Không cần lưu version đồng ý hay dialog đồng ý lại.
  - Đã sửa (2026-10-29, DEC-69): không lưu version, không có dialog đồng ý lại.
- [x] Claude Code ghi DEC (bỏ Terms/Privacy, thêm `/risk`) + thêm route vào SCREENS.md.
  - Đã sửa (2026-10-29, DEC-69): DEC-69; SCREENS.md mục 8 có `/risk-disclosure`.

### L1. Sửa kèm khi rà phí và cách kết nối
- [x] (đã sửa, DEC-69) `apps/web/messages/en.json` dòng ~1363 `feeSubOn`: vẫn ghi "maxFeeRate 50". Đổi thành "max per fill · maxFeeRate 10 · builder #{builderId}" (DEC-46). Comment ở `apps/api/src/modules/sodex/routes.ts:54` cũng ghi "0.05%".
- [x] Canvas đã đổi mọi chỗ builder fee 0.05% → 0.01% (Settings, Onboarding 2 và 6, Create, Bot spec, Builder Revenue, mobile tương ứng); giữ "0.05% slippage" của backtest. Mục Volume Maker trên Bot spec: "the same 0.01% as every DRIFT bot".
- [x] Canvas Onboarding 2 vẫn vẽ **một** chữ ký `AddAPIKeyWithBuilder`, trong khi app làm **hai** chữ ký theo DEC-25. App đúng, artboard lệch; không sửa app theo artboard. Landing đã ghi "two wallet signatures".
  - Đã sửa (2026-10-29, DEC-25): không sửa app (app đúng DEC-25); artboard cần chủ canvas sửa. Comment `routes.ts:54` sửa 0.05% → 0.01%.

## M. Watchlist: thêm / bỏ market (2026-10-29)

### M1. Hiện tại
- Không có cách nào thêm hay bỏ trong UI. Danh sách lấy từ `goals.markets` (onboarding bước 5 "Your goals"), lấy **4 cái đầu**, ép thành perps `<X>-USD`; mặc định `BTC`, `ETH` (`apps/api/src/modules/account/service.ts`, đoạn `const watch = …`).
- Market không có mark price bị **lọc mất im lặng** (`watchlist.filter((w) => w.mark !== null)`), nên chọn một coin chỉ có spot sẽ không bao giờ hiện.
- Muốn đổi thì phải làm lại bước Goals; đổi goals lại ảnh hưởng tới đề xuất chiến lược. Hai việc này không nên dính nhau.

### M2. Sửa (tao quyết định)
- [x] **Dữ liệu riêng**: bảng `watchlist_items (user_id, market, engine spot|perps, position, created_at)`, unique `(user_id, market)`, tối đa **8**. Lần đầu đọc mà chưa có dòng nào thì seed từ `goals.markets` (như hiện tại); sau đó độc lập với goals.
  - Đã sửa (2026-10-29, DEC-74): bảng `watchlist_items` + `users.watchlist_seeded_at` (migration 0010); seed từ goals một lần, bỏ market không có.
- [x] **API**: `GET /api/v1/watchlist`; `PUT /api/v1/watchlist` nhận danh sách có thứ tự (thay toàn bộ, có `Idempotency-Key`), zod kiểm tra market tồn tại trong `GET /api/v1/markets`, > 8 → lỗi `VALIDATION`. Overview tiếp tục trả `watchlist` đã định giá.
  - Đã sửa (2026-10-29, DEC-74): `GET`/`PUT /api/v1/watchlist` (`apps/api/src/modules/account/watchlist.ts`); Overview trả `engine`, `price`.
- [x] **UI Overview (desktop + mobile)**: header thẻ Watchlist thêm nút icon bút chì `aria-label="Edit watchlist"`. Chế độ sửa:
  - mỗi dòng có nút × `aria-label="Remove BTC-USD"` và tay kéo để sắp xếp, kèm nút ▲ ▼ cho bàn phím;
  - nút "+ Add market" mở `MarketPicker` (G6), có cả Spot và Perps, market đã có thì disabled kèm "Added";
  - đủ 8 thì "+ Add market" disabled, ghi "Up to 8 markets";
  - "Save" / "Cancel"; khi lưu giữ trạng thái "Saving…" tới khi API trả về (quy tắc 1.6).
  - Đã sửa (2026-10-29, DEC-74): `watchlist-card.tsx`: bút chì, ▲ ▼ ×, tay kéo, "+ Add market" (Perps/Spot + MarketPicker, "Added"), "Up to 8 markets", Save/"Saving…"/Cancel.
- [x] Bỏ và thêm nhanh không cần vào chế độ sửa: trong bảng market của `MarketPicker` và trang Create bot, nút ☆ / ★ "Add to watchlist".
  - Đã sửa (2026-10-29, DEC-74): `WatchStar` dưới ô `MarketPicker` (Create và Edit) cho market đang chọn; không đặt trên từng dòng gợi ý (lý do ở DEC-74).
- [x] Market không có giá → vẫn hiện dòng, giá ghi "Not available", không lọc mất.
  - Đã sửa (2026-10-29, DEC-74): hiện "Not available", không lọc.
- [x] Nhãn "Mark price · 24h" đổi thành "Price · 24h": perps dùng mark price, spot dùng last price; chip nhỏ "Spot" / "Perps" cạnh tên.
  - Đã sửa (2026-10-29, DEC-74): "Price · 24h"; spot dùng giá gần nhất; chip Spot/Perps.
- [x] Empty state: "Your watchlist is empty." + nút "Add market".
  - Đã sửa (2026-10-29, DEC-74): "Your watchlist is empty." + "Add market" (mở thẳng chế độ sửa và ô thêm).
- [x] Bấm vào một dòng → mở menu: "New bot on BTC-USD" (vào Strategy Lab với market điền sẵn), "Remove".
  - Đã sửa (2026-10-29, DEC-74): menu "New bot on X" (catalog lọc theo market, Create điền sẵn) và "Remove".
- [x] Test: API (thêm, bỏ, sắp xếp, > 8, market không tồn tại, seed từ goals một lần), component (chế độ sửa, bàn phím, axe).
  - Đã sửa (2026-10-29, DEC-74): API `account.test.ts` (seed một lần, thay, sắp xếp, > 8, trùng, sai engine, không tồn tại, rỗng không seed lại, giữ market thiếu giá); unit `watchlist-list.test.ts`, `preset-market.test.ts`; e2e `p12-watchlist` (bàn phím, axe, lưu, menu → Create).
- [x] Claude Code ghi DEC + cập nhật SCREENS.md mục Overview. Canvas chưa có artboard cho chế độ sửa; làm theo mô tả này, dùng component có sẵn (`MarketPicker`, nút icon, `Card`).
  - Đã sửa (2026-10-29, DEC-74): DEC-74; SCREENS.md "8.x Overview — Watchlist".
