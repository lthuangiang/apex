# Prompt cho agent code: AI Desk B+

Bạn đang làm trong monorepo DeskLabs (tên code cũ: DRIFT; pnpm, turbo, Next, Fastify, Drizzle, NATS, Vault). Nhiệm vụ: xây **AI Desk concept B+** theo **DEC-164, DEC-165, DEC-166** và design trong `docs/mockups/ai-desk-bplus/`. AI Desk là **người quản lý tiền** cho người mới: thẻ Mục tiêu, việc cần làm có what-if, thành tích đề xuất, nút ✦ ở mọi màn, và Desk AI panel để hỏi đáp.

Trả lời và viết tài liệu bằng tiếng Việt. Câu chữ trên giao diện, tên field, API, enum, code, commit message bằng tiếng Anh, **chép đúng như design**, không tự dịch.

---

## 1. Đọc trước khi code (theo thứ tự)

1. `CLAUDE.md`: quy tắc sản phẩm 1.1–1.10, thuật ngữ, quy định code. **Bắt buộc.**
2. `docs/DECISIONS.md`: **DEC-166** (phạm vi B+, spec chính), **DEC-165** (Claude API, `claude-sonnet-5-5`, 20 câu/ngày, lưu chat 90 ngày, báo cáo 08:00 giờ địa phương, beta đóng), **DEC-164** (5 vòng của Desk AI, nguyên tắc an toàn, 4 quy tắc đề xuất), DEC-105 (AI Desk bản đầu, paper), DEC-108 (sidebar), DEC-115 (2FA không bắt buộc), DEC-130/131 (phân tích và Review this run của Volume Builder), DEC-141 (Strategy Analytics).
3. `docs/AI_DESK.md` (mục 3 nguyên tắc không đổi), `docs/AI_DESK_RECOMMENDED.md` (luồng Recommended + paper đã code), `docs/SCREENS.md` mục AI Desk, `docs/BACKTEST.md`, `docs/RECO_ENGINE.md`, `docs/DOMAIN.md`, `docs/CODING_STANDARDS.md`, `docs/DESIGN.md`, `docs/ARCHITECTURE.md` mục 3–4.
4. Design: `docs/mockups/ai-desk-bplus/`
   - **B+ (màn chính):** `BP-Scope` (phạm vi), `BP-Home` (trang chủ), `BP-WhatIf` (so sánh phương án), `BP-AskHere` (✦ trong Trading Agent), `BP-Record` (thành tích), `BP-Phone`.
   - **B (màn chat, dùng trong Desk AI panel):** `B-Scope`, `AIDesk-Home-AI` (báo cáo sáng dạng chat), `B-Empty` (lần đầu, chưa có bot), `B-NewBot` (tạo bot qua chat), `B-Fix` (sheet xem trước + tin xác nhận), `B-Answer` (trả lời câu hỏi), `B-Result` (kết quả tiền ảo → tiền thật), `B-History`, `B-Phone`.
   - `Sidebar.dc.html`: menu đúng như app (DEC-108). Bỏ qua nhóm "Copy Trading" nếu Copy Trading chưa có trong code.
   - Lấy **bố cục và câu chữ** từ mockup. Số trong mockup là mẫu. Giao diện thật dùng `@drift/ui` và design token, không chép style inline.
5. Code hiện có:
   - AI Desk: `apps/api/src/modules/desk/*`, `apps/web/src/app/desk/*`, `apps/web/src/features/desk/*`, `packages/shared/src/desk/*`
   - Quy tắc, rủi ro: `packages/shared/src/portfolio/{analyst,risk,value}.ts`, `packages/shared/src/reco/*`, `apps/api/src/modules/reco/*`
   - Phân tích / replay: `apps/api/src/modules/bots/analytics.ts` (Strategy Analytics, Review this run), service `apps/backtest`, `packages/strategies/src/sim/`
   - Bot, version, apply: `apps/api/src/modules/bots/*`, màn Edit bot trong `apps/web/src/features/bots/*`
   - Trading Agent, Portfolio, Strategy Lab trong `apps/web/src/app/{agent,portfolio,bots}`
   - Goals: `PUT /api/v1/goals` (onboarding)

Không tự bịa quy tắc nghiệp vụ, công thức hay ngưỡng. Tài liệu không nói thì chọn cách **an toàn nhất**, ghi vào báo cáo cuối, rồi làm tiếp. **Dừng lại hỏi** khi việc đó đụng tới tiền thật, cho AI quyền thay đổi gì đó, hoặc đổi một DEC đã có.

---

## 2. Phạm vi v1 (DEC-166)

| Phần | Làm gì | Nguồn dữ liệu |
|---|---|---|
| **Thẻ Mục tiêu** | Mục tiêu của user (từ goals), thước đo lỗ đã dùng / lỗ cho phép, một câu Desk AI | goals + Risk Center |
| **Needs you** | Tối đa 3 việc, xếp theo mức độ. Mỗi việc: vấn đề bằng lời thường + **what-if** ("Last 7 days, as it is" so với "If it had used …") + một nút chính | 4 quy tắc (mục 3) |
| **So sánh phương án** | 2–3 lựa chọn (gồm "Keep as it is"), mỗi lựa chọn có kết quả 7 ngày, số lệnh bị SoDEX đóng, lệnh tệ nhất, tiền ký quỹ mỗi lệnh; Desk AI nêu lựa chọn của nó và lý do; Apply → version mới gắn "AI suggested" | replay / backtest (mục 4) |
| **Thành tích** | 7 ngày sau mỗi Apply: so kết quả thật với replay cấu hình cũ trên cùng các ngày. Nhãn: Helped / Made it worse / Still measuring / No clear effect (chênh < 0.50 USDC). Có Switch back | version bot + replay |
| **Sức khoẻ bot** | Healthy / Watch / Needs you cho từng bot | 4 quy tắc + analyst rules |
| **✦ Ask about this** | Nút ✦ cạnh số liệu, bot, quyết định ở Trading Agent, Portfolio, Strategy Lab → panel có sẵn bối cảnh | decisions, reason code, số liệu màn hình |
| **Desk AI panel** | Hỏi đáp trên trang chủ; báo cáo sáng; lần đầu chưa có bot; tạo bot qua chat; báo kết quả tiền ảo; History | LLM (mục 5) |

**Không làm ở v1:** thời tiết thị trường (trên mockup gắn nhãn v2: ẩn), cảnh báo trong ngày theo mức độ, nối Copy Trading, AI tự giảm rủi ro, phòng thử chiến lược (`AI_DESK_ASK.md`), Verified / Research Lab, push, đa ngôn ngữ.

---

## 3. Bốn quy tắc tạo việc "Needs you" (DEC-164)

1. **Thanh lý trước stop loss:** khoảng cách thanh lý (từ đòn bẩy và maintenance margin của SoDEX cho market đó) nhỏ hơn khoảng stop loss. Kiểm tra cấu hình, không cần lệnh.
2. **Chạm max loss:** bot dừng vì max loss → việc "Review"; what-if chỉ khi có phương án sửa cụ thể.
3. **Lệnh taker tốn phí:** tỷ lệ lượt có chiều taker và chi phí mỗi 1M theo nhóm maker/taker (cách tính như DEC-130), dùng cờ maker trên fill SoDEX.
4. **Review this run có bộ tốt hơn:** dùng kết quả Review this run (DEC-131); chỉ đề xuất khi bộ tốt hơn rõ ràng theo đúng tiêu chí đã có.

Mỗi việc là một bản ghi có id, bot, quy tắc, mức độ, thời điểm, fact đầu vào. Bỏ qua ("Later" / "Not now") được ghi lại và không hiện lại trong 7 ngày, trừ khi dữ liệu xấu đi. Ngưỡng nào chưa có trong tài liệu: đặt trong một file config chung, ghi rõ trong báo cáo.

---

## 4. What-if và thành tích

- **Volume Builder:** chạy lại trên **lệnh vào thật** của bot (cách của Review this run, DEC-131).
- **Chiến lược khác:** dùng service backtest (P9) trên nến của cùng 7 ngày; giao diện ghi rõ nguồn ("Replayed on your real trades" hoặc "Backtest on 1-minute candles").
- Luôn ghi **"not a forecast"**. Không dự báo tương lai, không hứa lợi nhuận (quy tắc 1.8).
- Không đủ dữ liệu (bot quá mới, quá ít lệnh) → không hiện what-if, ghi "Not enough trades to compare", không hiện `0`.
- Thành tích: job chạy 7 ngày sau Apply, lưu kết quả; tính công bằng, **hiện cả lần làm xấu đi**; "Still measuring" khi chưa đủ 7 ngày.
- Tính toán là hàm thuần có unit test (đặt trong `packages/shared` hoặc dùng `packages/strategies/src/sim`), dùng `decimal.js`.

---

## 5. Desk AI (LLM) — luật cứng

1. **Model:** `claude-sonnet-5-5` qua **Claude API trực tiếp**, SDK `@anthropic-ai/sdk` (DEC-165). API key lấy từ Vault như secret khác; không log, không đưa ra client. Không dùng gói Claude cá nhân.
2. **Hai tầng:** code tạo **fact** có cấu trúc (số liệu, nguồn, id). LLM **chỉ viết lời** quanh fact.
3. **Kiểm tra số:** mọi con số trong câu trả lời phải khớp một fact; không khớp → thay bằng **câu mẫu** soạn sẵn từ fact. Có test.
4. **Công cụ của LLM:** chỉ đọc (bot, tóm tắt fill, fact, `recommend()`) và **tạo bản nháp** (đề xuất thay đổi, kế hoạch bot mới). **Không có công cụ thực thi.** Apply / Start luôn là nút user bấm, đi qua luồng hiện có (`startChecks`, "Applying vN…").
5. **Không đọc văn bản bên ngoài.** Tên bot, ghi chú do user nhập được đưa vào như dữ liệu, có đánh dấu.
6. **Phạm vi trả lời v1:** giải thích (vì sao lỗ, thuật ngữ), an toàn tiền, so sánh bot của user, tạo bot. Câu hỏi dự đoán giá hay khuyên mua bán coin cụ thể → từ chối lịch sự bằng câu mẫu và chuyển về bot của user. Kèm "Not financial advice" theo DEC-165e.
7. **Giới hạn:** 20 câu hỏi / user / ngày (báo cáo sáng không tính); hết lượt hoặc LLM lỗi → câu mẫu, app vẫn chạy đầy đủ không cần LLM.
8. **Báo cáo sáng:** 08:00 giờ địa phương (`users.timezone`; chưa có thì lấy từ trình duyệt), user đổi giờ trong Settings; tạo một lần mỗi ngày.
9. **Lưu chat 90 ngày**, tự xoá sau đó; nút "Delete history" trong History.
10. **Nhật ký mỗi lượt LLM:** model, phiên bản prompt, id các fact đầu vào, câu trả lời, số token, chi phí ước tính, `traceId`. Không log secret.
11. Dùng prompt caching cho phần system / tool cố định; đo token và chi phí thật (DEC-165 ước tính ~$0.12 / user / ngày) và ghi vào báo cáo.
12. Pause do max loss là **engine** làm: giao diện ghi "Bot stopped", không ghi là AI làm.

---

## 6. Luật sản phẩm khác, không được vi phạm

- Chỉ giao dịch: không code rút hay chuyển tiền (quy tắc 1.1).
- Paper chỉ từ AI Desk › Try with fake money (DEC-105); không đổi `mode` tại chỗ; số liệu paper tách khỏi tiền thật.
- Không bắt 2FA (DEC-115).
- Quyền truy cập: chỉ tài khoản được bật cờ AI Desk (beta đóng, DEC-165e).
- Mọi thao tác đổi trạng thái có `Idempotency-Key`; lỗi theo format C6.
- Câu chữ trong `apps/web/messages/en.json` (chuỗi mới vào `_pendingReview`); component chỉ dùng design token.
- Test dùng `@drift/sodex-mock` và mock Claude API (không gọi API thật trong test); không chạy bot trên mainnet.
- Không thêm dependency ngoài ARCHITECTURE mục 4 (`@anthropic-ai/sdk` đã có ở DEC-165); cần thêm thì dừng hỏi.

---

## 7. Thứ tự làm

Mỗi mốc xong thì chạy `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` của phần liên quan.

**M0 · Kiểm tra, không sửa code.** Đối chiếu code AI Desk hiện có (DEC-105) với B+: phần nào dùng lại (Recommended, Why this one, paper, Your bots), phần nào thay. Kiểm tra Review this run / backtest đã đủ để làm what-if cho từng chiến lược chưa. Ghi kết quả vào báo cáo; thiếu nền tảng quan trọng thì dừng hỏi.

**M1 · Fact và quy tắc.** Module fact (thuần) + 4 quy tắc + sức khoẻ bot + bảng lưu việc "Needs you" (migration). Unit test cho từng quy tắc với fixture.

**M2 · What-if và so sánh phương án.** Tính 2–3 phương án cho mỗi việc (replay hoặc backtest), API cho sheet so sánh, Apply tạo version mới gắn "AI suggested" (dùng luồng Edit / apply hiện có). Test: cùng fixture ra cùng kết quả; thiếu dữ liệu không hiện `0`.

**M3 · Trang chủ B+.** `/desk`: thẻ Mục tiêu, Needs you, sức khoẻ bot; đủ 4 trạng thái; responsive 1440 / 390; a11y. Giữ các luồng DEC-105 đang chạy (Recommended, paper) hoạt động, đưa vào đúng chỗ theo mockup.

**M4 · Thành tích.** Job đo sau 7 ngày, bảng kết quả, trang Thành tích, Switch back. Test cả trường hợp làm xấu đi và "No clear effect".

**M5 · Desk AI (LLM).** Client Claude, lớp fact → prompt, kiểm tra số, câu mẫu dự phòng, giới hạn 20 câu, từ chối câu ngoài phạm vi, nhật ký, lưu chat 90 ngày. Desk AI panel trên trang chủ, báo cáo sáng 08:00, màn lần đầu (B-Empty), tạo bot qua chat (bọc Recommended + paper), báo kết quả tiền ảo, History.

**M6 · ✦ Ask about this.** Nút ✦ và panel bối cảnh trên Trading Agent, Portfolio, Strategy Lab; chỉ hiện cho tài khoản bật cờ AI Desk.

**M7 · E2E và tài liệu.** E2E: việc "Needs you" → so sánh → Apply → version mới; hết 20 câu → câu mẫu; LLM lỗi (mock) → app vẫn chạy; ✦ mở đúng bối cảnh. Cập nhật `docs/AI_DESK.md`, `docs/SCREENS.md` (route mới), `docs/DOMAIN.md` (bảng mới). Ghi **một DEC mới** cho các lựa chọn lúc code (ghi "chọn theo khuyến nghị, chờ duyệt").

---

## 8. Definition of done

- Đạt mục 14 của `docs/CODING_STANDARDS.md`.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` (phần AI Desk) pass.
- Mọi luật ở mục 5 và 6 có test, hoặc có lý do rõ trong báo cáo vì sao chưa test được.
- App chạy đủ khi tắt LLM (không có API key): mọi màn vẫn hiện bằng câu mẫu.

---

## 9. Báo cáo cuối

Viết bằng tiếng Việt, gồm:
1. Đã làm gì theo từng mốc, file chính đã đổi; mốc nào bỏ qua và vì sao.
2. Lệnh test đã chạy và kết quả **thật** (fail thì dán output).
3. Token và chi phí LLM đo được cho một user mẫu một ngày.
4. Lựa chọn tự đưa ra khi tài liệu không nói, ngưỡng đã đặt, và DEC đã ghi.
5. Việc còn lại, rủi ro, câu hỏi cần người dùng chốt.

Không commit hay push trừ khi người dùng yêu cầu.
