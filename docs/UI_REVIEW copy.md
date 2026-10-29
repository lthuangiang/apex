# DRIFT — Danh sách sửa UI theo thiết kế (review 2026-10-28)

> So app chạy ở `http://localhost` với canvas "DRIFT Redesign" (render từng artboard `.dc.html`), cùng khổ 1440×900 và 375×812. Tài khoản test chưa kết nối SoDEX nên chỉ xem được trạng thái trống.
>
> Làm theo thứ tự dưới đây. Mỗi mục có: artboard đối chiếu, chỗ sửa dự kiến, tiêu chí xong. Không đổi câu chữ UI ngoài những gì thiết kế có. Thiếu chi tiết khoảng cách/kích thước thì đọc lại artboard qua công cụ Artifact (DEC-31) hoặc hỏi người dùng, không đoán.
>
> Khi sửa xong một mục: đánh dấu `[x]`, ghi file đã đổi. Nếu một mục mâu thuẫn với `docs/DECISIONS.md` thì quyết định thắng; ghi lại ở mục "Không sửa".

## A. Lỗi chung (ảnh hưởng mọi màn — làm trước)

- [ ] **A1. Nạp font Plus Jakarta Sans.**
  - Hiện trạng: `packages/ui/src/styles/tokens.css:43` khai báo `--font-sans: "Plus Jakarta Sans"…` nhưng không có `next/font` hay `@font-face`; `document.fonts` rỗng, trình duyệt dùng font hệ thống.
  - Sửa: dùng `next/font/google` (weight 400, 500, 600, 700, 800; `display: swap`) trong `apps/web/src/app/layout.tsx`, gắn biến CSS và trỏ `--font-sans` vào biến đó. `next/font` tự host file nên không cần mở CSP `font-src`.
  - Xong khi: `document.fonts` có Plus Jakarta Sans trạng thái `loaded`; Storybook của `packages/ui` cũng dùng đúng font.

- [ ] **A2. Khung app (sidebar + hàng tiêu đề) theo artboard `Main.dc.html`.**
  - Sidebar là **thẻ trắng nổi**, không phải cột phẳng cao hết màn: cách mép 12–16 px, bo góc lớn (radius thẻ như các card khác), viền `#E3E7F5`.
  - Logo: ô vuông bo góc nền xanh primary có icon biểu đồ, cạnh chữ "DRIFT" + "Profit Bot workspace".
  - Mục đang chọn: **nền xanh primary đặc, chữ và icon trắng**, có bóng nhẹ (hiện tại là nền xanh nhạt).
  - "Builder Revenue" (chỉ role `team`) và "Settings" nằm sau một đường kẻ, tách khỏi nhóm điều hướng chính.
  - Thẻ **Emergency** (nền đỏ nhạt, viền đỏ, nút "Halt all agents…") nằm ở **cuối sidebar**, không nằm trong nội dung Overview.
  - **Bỏ thanh trắng trên cùng.** Hàng tiêu đề nằm trong vùng nội dung: tiêu đề trang + mô tả bên trái; bên phải là chọn account ("Main account" ▾), chip `LIVE · MAINNET`, chip trạng thái SoDEX ("SoDEX connected" / chưa kết nối), "Updated Xs ago", nút chuông, avatar (menu avatar chứa email và Sign out).
  - Chỗ sửa: `AppShell` trong `packages/ui`, `apps/web/src/components/workspace-shell.tsx`.
  - Xong khi: chụp Overview cạnh `Main.dc.html` ở 1440 px thấy cùng cấu trúc khung.

- [ ] **A3. Thanh điều hướng mobile theo `Mobile-Home.dc.html`.**
  - Hiện trạng: 8 tab, nhãn bị cắt ("Ove…", "Port…").
  - Sửa: 5 mục — Home, Portfolio, **Agent** (nút tròn nổi ở giữa, nền primary), Strategy, More. "More" mở danh sách các trang còn lại (Execution & Orders, Risk Center, AI Analyst, Builder Revenue nếu `team`, Settings).
  - Xong khi: ở 375 px không nhãn nào bị cắt; mọi trang vẫn tới được trong ≤ 2 lần chạm.

## B. Từng màn

- [ ] **B1. Create bot — bố cục theo `Create.dc.html`** (`apps/web/src/features/bots/components/create-bot.tsx`, `visual-panel.tsx`, `bot-form.tsx`).
  - Hai cột: **trái (flex 3) = phần trực quan**, **phải (flex 2) = Settings**. Hiện app đang đảo: form + tab ở trái, "Before it starts" tách thành cột phải.
  - Cột trái: tiêu đề `{visTitle}` + dòng market/last price; tab Preview / Backtest; ở Preview là biểu đồ của chiến lược (grid: dải range, các mức, đường Stop đỏ nét đứt, nhãn Upper / Lower / Last / Stop; DCA: thang lệnh; …) và hàng ô chỉ số (Per level, Step, Orders at start, Round-trip fees…).
  - Chưa chọn market: vẫn giữ khung biểu đồ, hiện trạng thái trống (không vẽ số giả).
  - Cột phải, từ trên xuống: banner AI ("✦ Filled by AI" + "Clear parameters", hoặc thanh "✦ AI parameters"), nhóm Market, Parameters, Risk & exits, rồi checks "Before it starts", checkbox xác nhận, 2FA, "Save draft" / "Start on mainnet" ở cuối cột.
  - Field: có đơn vị bên trong ô (`USDT`, `%`), chip "AI" cạnh label khi giá trị do AI điền, dòng gợi ý dưới ô ("9.3% below last price", "2–200 · step …"). Segmented control (Arithmetic / Geometric…) rộng hết cột.
  - **Không hiện giá trị enum thô**: Preview đang hiện `arithmetic`, `keep_base` — phải dùng label i18n ("Arithmetic", "Keep base asset").
  - Header: chip engine (`Spot` / `Perps`) đứng trước chip LIVE, cạnh "Paper · Coming soon".
  - Xong khi: cả 8 chiến lược (và Volume Maker khi bật cờ) dùng đúng bố cục; chụp cạnh artboard thấy cùng thứ tự phần tử; ở mobile hai cột xếp chồng như `M-Create-*.dc.html`.

- [ ] **B2. Overview — hero theo `Main.dc.html`.**
  - Thẻ hero gradient (`#E3E8FE → #CBD5FB`, có vòng tròn trang trí): "Welcome back", "Account value (equity)", số lớn + `USDC`, dòng thay đổi trong kỳ; nút chọn kỳ **24H / 7D / 30D / All** ở góc phải hero; 4 ô chỉ số (Unrealized PnL, Realized PnL, Available balance, Margin in use) nằm **trong** hero.
  - Khi chưa có dữ liệu vẫn giữ hero, các số hiện "Not available".
  - Thẻ "Trading Agent" (bot đang chạy nổi bật) cạnh Performance như thiết kế.
  - "Connect SoDEX" phải là **nút primary**, không phải chữ thường.

- [ ] **B3. Strategy Lab theo `Bots.dc.html`.**
  - Số đếm trên tab dạng badge ("My bots [6]", "Strategy catalog [9]").
  - Nút "New bot" có icon `+`.
  - Có cả filter **Status** và **Engine**, nằm trong thẻ chứa bảng.
  - Danh sách bot là bảng: Bot, Strategy, Mode, Status, Profit, Capital, hành động (Open/Resume/View/Continue, Edit/Duplicate/Delete, menu ⋯).

- [ ] **B4. Trạng thái chưa kết nối SoDEX (Risk Center, Trading Agent, Execution & Orders, Portfolio, Overview).**
  - Hiện trạng: Risk Center và Trading Agent còn mỗi một dòng chữ; Orders mất filter/tab.
  - Sửa: giữ khung trang (tiêu đề section, filter, tab, header bảng) theo artboard tương ứng; khối thông báo dùng chung một component có nút primary **Connect SoDEX** dẫn tới `/onboarding/connect`.
  - Xong khi: mọi trang trên có cùng một khối "chưa kết nối" và vẫn nhận ra được bố cục của trang.

## C. Không sửa (khác thiết kế nhưng đúng quyết định)

- Signup chỉ email, không "Continue with wallet", không mật khẩu (DEC-28, DEC-31).
- Kết nối SoDEX hai chữ ký (DEC-25); không có nút chọn Testnet (DEC-23).
- Field số để trống cho tới khi bấm AI parameters (DEC-38).
- Volume Maker ẩn / Coming soon (DEC-43).

## D. Chưa review (cần account SoDEX đã kết nối)

Màn có dữ liệu thật; chi tiết Trading Agent (`/agent/:botId`) và Edit bot; kết quả Backtest; Builder Revenue (role `team`); các màn mobile ngoài Overview. Review lại sau khi xong A và B.
