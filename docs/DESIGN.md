# DRIFT — Thiết kế

> Đọc khi làm bất kỳ UI nào. Route ↔ artboard ở `docs/SCREENS.md`; field của từng chiến lược ở `docs/STRATEGIES.md`.

## D1. Canvas thiết kế
- Link: **https://claude.ai/artifact/CqbALjUJ4r7gcGk8XUua6v** ("DRIFT Redesign").
- Canvas là **private**. Chủ sở hữu chia sẻ bằng menu **Share** cho người cần xem. Claude Code không mở được link này; nếu cần đối chiếu chi tiết, hỏi người dùng gửi ảnh chụp hoặc bản export (Share › Export) của đúng artboard.
- Trên canvas, bấm **Play** để dùng thử các artboard có tương tác (tab, dialog, nút trạng thái). Bảng **Tweaks** bật các trạng thái đặc biệt:

| Artboard | Tweak | Trạng thái xem được |
|---|---|---|
| Create · <Strategy> | `showErrors` | thông báo lỗi của mọi field |
| Create · <Strategy> | `backtestUnavailable` | "Backtest unavailable for this market" |
| Create · <Strategy> | `strategy` | đổi sang chiến lược khác |
| Strategy Lab · My bots & catalog | `feeRevoked` | mọi bot LIVE bị pause vì builder fee = 0 |
| Desktop · Settings | `keyExpired` | API key đã hết hạn |
| Onboarding 2 · Connect SoDEX | `maxFeeRate` | đổi mức phí hiển thị (giữ 50) |

## D2. Bố cục canvas (các hàng artboard)
1. **Desktop workspace:** Overview, Portfolio, Execution & Orders, Risk Center, AI Analyst, Trading Agent, Builder Revenue, Settings.
2. **Mobile:** Home, Strategy Lab, Trading Agent, Design tokens.
3. **Onboarding (desktop):** 6 bước, từ Create account tới Strategy plan.
4. **Bots & settings:** Strategy Lab (My bots & catalog), Edit running bot, Bot & settings spec.
5. **Create bot (desktop):** một artboard cho mỗi chiến lược, 9 artboard (gồm Volume Maker).
6. **Create bot (mobile):** 9 artboard tương ứng.
7. **Mobile còn lại:** Portfolio, Orders, Risk, AI Analyst, Edit bot, Builder Revenue, Settings, Onboarding 1–6.

## D3. Đọc thiết kế cho đúng
- **Số liệu trên canvas là dữ liệu mẫu.** Không hard-code bất kỳ con số, tên bot, địa chỉ ví, ngày giờ nào từ canvas. Mọi giá trị lấy từ API.
- **Câu chữ trên canvas là câu chữ thật.** Chép nguyên văn vào `messages/en.json`. Phần trong ngoặc vuông như `[confirm …]` là ghi chú thiết kế, **không** hiển thị cho người dùng.
- Các artboard Create dùng **một component chung**. Code cũng phải là một component `CreateBotScreen` nhận `strategy`, không viết 9 màn riêng.
- Artboard mobile là layout < 768px của **cùng route**, không phải app riêng.
- Màu, bo góc, spacing lấy từ token ở mục 13. Nếu canvas có giá trị lệch token, dùng token và báo lại.

## D4. Icon
- Icon nét (stroke) 24×24, nét 1.8–2px, đầu nét tròn. Dùng `lucide-react` cho thống nhất (DEC-17); icon nào không có thì vẽ SVG riêng theo cùng kiểu.
- Không dùng emoji làm icon. Ký hiệu chữ được phép dùng: ✓ ✕ ▲ ▼ ❚❚ ■ ✦ (chỉ kèm chữ, không đứng một mình).

## D5. Trạng thái bắt buộc cho mọi vùng dữ liệu
loading (skeleton) · empty (kèm hành động tiếp theo) · error (thông báo + thử lại) · stale (badge + thời điểm cập nhật). Không có vùng dữ liệu nào chỉ có trạng thái "đã tải xong".

## D6. Checklist khi chuyển một artboard thành code
- [ ] Đúng route và layout desktop + mobile (`docs/SCREENS.md`).
- [ ] Câu chữ chép nguyên văn vào i18n.
- [ ] Chỉ dùng token và component trong `packages/ui`.
- [ ] Đủ 4 trạng thái dữ liệu (D5) và các trạng thái chuyển tiếp của thao tác.
- [ ] Dialog xác nhận có danh sách hệ quả cụ thể; thao tác nguy hiểm có 2FA nếu tài liệu yêu cầu.
- [ ] Bàn phím dùng được từ đầu tới cuối, focus luôn nhìn thấy.
- [ ] Ảnh chụp desktop (1440) và mobile (390) trong PR.

---

## 13. Design system

Font: **Plus Jakarta Sans** 400/500/600/700/800. Mọi con số dùng `font-variant-numeric: tabular-nums`.

Định nghĩa token một lần dưới dạng CSS variable trong `packages/ui`, map vào Tailwind. Không viết mã hex trực tiếp trong component.

| Token | Giá trị | Dùng cho |
|---|---|---|
| `--bg` | `#EEF1FA` | nền app |
| `--surface` | `#FFFFFF` | card, panel |
| `--surface-2` | `#F5F7FD` | tile bên trong, header bảng |
| `--border` | `#E3E7F5` | viền card |
| `--border-input` | `#D5DCF2` | input, nút phụ |
| `--ink` | `#141A33` | chữ chính, nút tối |
| `--ink-2` | `#3B4262` | chữ phụ |
| `--muted` | `#5F6684` | label, caption (tối thiểu 12px) |
| `--accent` | `#2E62E8` | hành động chính, mục nav đang chọn |
| `--accent-ink` | `#1D47B8` | chữ accent trên nền nhạt |
| `--accent-tint` | `#E6ECFE` | nút tonal, chip |
| `--hero` | `linear-gradient(135deg, #E3E8FE, #CBD5FB)` | chỉ dùng cho hero card |
| `--pos` | `#0F7A43` (nền `#DDF4E7`, chấm `#16A05A`) | lãi, running |
| `--neg` | `#C2312F` (chữ `#A72826`, nền `#FDE4E1`) | lỗ, nguy hiểm, badge LIVE |
| `--warn` | `#7A3E00` trên `#FDEBD3` (thanh `#E08A2E`) | cần chú ý, giới hạn chỉ cảnh báo ở UI |
| `--unknown` | `#5A2CA0` trên `#F0E6FF` | unknown / đang đối soát |
| `--bot-orange` / `--bot-teal` | `#FFE3C7` / `#CDF1EC` | minh hoạ chiến lược; nền chip nhóm GRID / DCA ở catalog |
| `--cat-grid-ink` / `--cat-dca-ink` | `#5C2E00` / `#003D37` | chữ chip nhóm GRID / DCA ở catalog |
| `--cat-exec-bg` | `#EDEFF5` | nền chip nhóm EXECUTION (chữ `--ink-2`) |
| `--fits` | `#0B6A39` | nhãn "Fits" ở thẻ catalog |
| `--ink-body` | `#1F2645` | mô tả trong thẻ catalog |
| `--neg-soft` / `--neg-border` / `--neg-deep` / `--neg-text` | `#FFF4F2` / `#F6D3CD` / `#8A2A1E` / `#5B2A22` | thẻ Emergency cuối sidebar (artboard Main) |
| `--shadow-accent` | `0 6px 16px rgb(46 98 232 / .28)` | mục nav đang chọn, nút primary nổi |
| `--shadow-float` | `0 -8px 24px rgb(20 26 51 / .06)` | bottom nav mobile |

- Bo góc: 12 control · 18 tile · 24 card · 28 hero. Spacing: 4, 8, 12, 16, 20, 24, 32.
- Vùng bấm tối thiểu 44px. Focus ring `3px solid #8FB0FF`, offset 2px.
- Tôn trọng `prefers-reduced-motion`.

**Component dựng trước (trong `packages/ui`):**
- Khung trang: AppShell (sidebar + bottom nav mobile), PageHeader.
- Badge, trạng thái: LiveBadge, ComingSoonChip, ConnectionStatus, LastUpdated, StatusPill (trạng thái bot + reason).
- Hiển thị số: MetricCard, PnLValue (dấu + mũi tên + màu).
- Form: Field (label, chip AI/Edited, đơn vị, hint, error), SegmentedControl, Switch.
- Hộp thoại: ConfirmDialog (tiêu đề, danh sách hệ quả, nút chính/danger, chỗ nhập 2FA), BottomSheet (dialog trên mobile).
- Dữ liệu: DataTable (trên mobile cuộn ngang trong khung riêng), EmptyState / ErrorState / StaleBadge, ActivityTimeline.
- Chuyên dụng: WalletSignaturePreview, ChecklistRow (đạt / lỗi / link sửa), BacktestPanel.

**Accessibility:**
- Dùng đúng `<button>`, `<a>`, `<input>` có label. Dùng `role="switch"` / `tablist` / `radiogroup` khi phù hợp.
- Lỗi field có `aria-invalid` và text lỗi hiển thị.
- Dialog giữ focus bên trong và trả focus về chỗ cũ khi đóng.
- Nút chỉ có icon phải có `aria-label`.
- Tương phản chữ ≥ 4.5:1. Trạng thái không bao giờ chỉ thể hiện bằng màu.

**Responsive:** mỗi route một layout.
- ≥ 1024px: layout có sidebar.
- < 768px: bottom nav, một cột, dialog thành bottom sheet, nút chính ghim ở đáy có safe-area padding.
- Bảng cuộn trong khung của nó, không bao giờ làm cả trang cuộn ngang.
