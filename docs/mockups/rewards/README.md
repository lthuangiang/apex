# Rewards (SoPoints + Blind Boxes): bản phác cuối

Tích hợp Rewards API chính thức của SoDEX vào DeskLabs: xem SoPoints, xem Blind Box, rồi claim / open / merge ngay trong app. Thư mục này chép nguyên vào `docs/mockups/rewards/` khi được duyệt.

- `index.html`: một file tự chứa, có mục lục; mỗi màn dựng lại theo class Tailwind thật của app (dữ liệu mẫu).
- `rewards-motion-demo.html`: bấm thử hiệu ứng popup Claim / Open / Merge, có nút bật / tắt reduced motion (dữ liệu giả, không gọi SoDEX, không mở ví).
- Ảnh PNG: mỗi màn hai bản, `-1440.png` và `-390.png`.

## Danh sách màn

| # | Màn | Ảnh |
|---|---|---|
| 01 | Sidebar mới (Rewards vị trí 2, chip New; Portfolio ngay trên Settings) và menu More trên mobile | `01-sidebar-*` |
| 02 | Overview: thẻ SoDEX rewards khi chưa ký (dữ liệu công khai) | `02-overview-unsigned-*` |
| 03 | Overview: đã ký | `03-overview-signed-*` |
| 04 | Overview: có job đang chạy, popup đã đóng (job mới nhất + "+1 more") | `04-overview-job-*` |
| 05 | Overview: phiên rewards hết hạn | `05-overview-expired-*` |
| 06 | Thẻ SoDEX rewards: hết hạn, lỗi mạng, 429, đang tải | `06-overview-card-states-*` |
| 07 | Overview: bấm Claim trên thẻ mở popup tại chỗ (mobile: bottom sheet) | `07-overview-claim-popup-*` |
| 08 | Trang Rewards khi chưa ký (toàn trang) | `08-rewards-unsigned-*` |
| 09 | Rewards › SoPoints | `09-rewards-sopoints-*` |
| 10 | Rewards › Blind Boxes › Backpack | `10-rewards-boxes-backpack-*` |
| 11 | Backpack khi có job chạy (popup đã đóng) | `11-rewards-boxes-job-running-*` |
| 12 | Blind Boxes › History | `12-rewards-boxes-history-*` |
| 13 | Blind Boxes › Weekly draw | `13-rewards-boxes-weekly-draw-*` |
| 14 | Blind Boxes › Live feed | `14-rewards-boxes-live-feed-*` |
| 15 | Popup Claim: xác nhận → xử lý → kết quả → lỗi | `15-popup-claim-*` |
| 16 | Popup Open: xác nhận (box cũ nhất trước, danh sách token ID) → chờ ví → xử lý theo job → hé lộ → kết quả → lỗi | `16-popup-open-*` |
| 17 | Popup Merge: xác nhận (+ Show all) → chờ ví → xử lý → kết quả → lỗi | `17-popup-merge-*` |
| 18 | Trạng thái: chờ ví, sai ví, chưa kết nối SoDEX, hết hạn, lỗi mạng, 429, lỗi nghiệp vụ, rỗng, tải, khôi phục job sau reload, job trước còn chạy, kết quả không rõ, xong khi popup đã đóng | `18-states-*` |

## Quyết định đã chốt

1. **Overview phương án B:** thẻ SoDEX rewards thay thẻ Trading Agent, cùng vị trí và độ rộng (`flex-[1_1_320px]`, cùng hàng với Performance `flex-[2_1_520px]`). Hero Account value giữ nguyên trạng. Ở 390 thẻ đứng đúng chỗ thẻ Trading Agent cũ (sau Performance).
   - Thông tin của thẻ Trading Agent còn ở My bots (tên, trạng thái, lý do pause, link `/agent/:id`), Recent activity và mục sidebar. Mất: bot "nổi bật nhất", tên chiến lược, "Updated", Recent actions theo một bot, nút "Open agent".
2. **Sidebar:** Rewards ở vị trí 2 (chip New, kiểu chip của `BetaChip`), Trading Agent vẫn vị trí 3 (DEC-108), Portfolio xuống nhóm dưới ngay trên Settings. Mobile: thanh dưới giữ nguyên (DEC-208), Rewards đứng đầu menu More. Cần ghi DEC mới cho thứ tự này.
3. **Bỏ transfer / Send box.** Quy tắc sản phẩm 1 giữ nguyên. Lịch sử vẫn hiện dòng "Transfer in / out" do SoDEX ghi (chỉ đọc). Mở PFP (on-chain, gas SOSO) là link ra SoDEX.
4. **Open / Merge lấy box cũ nhất trước:** chọn theo `boxes[].mintedAt` tăng dần (bằng nhau, hoặc thiếu `mintedAt`, thì theo `tokenId`), bỏ box đang nằm trong job chưa xong; gửi thì sắp token ID tăng dần nghiêm ngặt (yêu cầu của `box/open` / `box/merge`). Popup hiện danh sách ID tăng dần: ≤ 5 hiện đủ, nhiều hơn 4 ID + "and {n} more" + "Show all".
5. **JWT chỉ ở trong trình duyệt**, gọi thẳng gateway SoDEX; server DeskLabs không nhận, không lưu token, không tự claim.
6. **Không có giao dịch on-chain nào từ DeskLabs.** Đăng nhập = `personal_sign`; open / merge = chữ ký EIP-712; claim chỉ cần JWT.
7. **Quyết định PM:** Volume multiplier hiện cặp có hệ số cao nhất (bằng nhau thì theo thứ tự API); Claim trên thẻ Overview mở popup tại chỗ; nhiều job cùng lúc hiện job mới nhất + "+1 more".
8. Trạng thái lấy từ SoDEX (quy tắc 6): bước tiến trình theo `job.status` (submitting → pending → revealed), không có thanh phần trăm; hiệu ứng hé lộ chỉ chạy khi đã có kết quả. Kết quả không rõ thì không gửi lại mù (quy tắc 7): đọc `lottery/jobs?active=true`; lần thử mới luôn lấy `sign-params` mới.
9. Không hiện số mà API không trả (quy tắc 8): không "trade thêm $X", không xác suất, không mã mời / squad / Season 1; thiếu trường thì "Not available".

## Endpoint và trường dùng

Gateway `https://mainnet-gw.sodex.dev`, đường dẫn `/api/v1/…`. Envelope `{code, msg|message, data}`; thành công khi `code === 0`; cybereator trả object trực tiếp.

| Endpoint | Auth | Trường |
|---|---|---|
| `POST auth/nonce`, `auth/verify` | công khai | `data.message`, `data.accessToken` |
| `GET sopoints/summary` | JWT | `totalPoints`, `basePoints`, `boostPoints`, `referralPoints`, `currentTier`, `nextTier`, `nextTierPoints`, `rank`, `totalUser` |
| `GET sopoints/week/info` | công khai (đã kiểm: HTTP 200, `code: 0` không cần Authorization) | `weekNo`, `weekName`, `weekStatus`, `weekPoolPoints`, `nextWeekStartTime`, `distributionTime` |
| `GET sopoints/week/list` | JWT | `weekNo`, `weekName`, `weekStartTime`, `weekEndTime`, `spotVolume`, `futuresVolume`, `rank`, `points`, `pointsStatus` |
| `GET sopoints/volume-weights` | công khai (đã kiểm: HTTP 200, `code: 0`) | `round.round_id`, `round.end_ts_ms`, `weights[].symbol`, `market_type`, `coefficient` |
| `GET lottery/meta` | công khai | `rules.mergeSize`, `rules.limits.maxBoxOpen`, `rules.limits.maxTreasureOpen`, `rewardTokens[].asset` |
| `GET lottery/treasures` | JWT | `total`, `maxPerOpen`, `lifetime` |
| `POST lottery/treasure/open` | JWT | body `count` → `jobId`, `kind`, `status` |
| `GET lottery/boxes` | JWT | `total`, `maxPerOpen`, `byLevel[]` (`level`, `count`, `mergeSize`, `canMergeNow`, `mergesAvailable`), `boxes[]` (`tokenId`, `level`, `source`, `mintedAt`) |
| `GET lottery/box/sign-params` | JWT | `chainId`, `verifyingContract`, `domainName`, `domainVersion`, `primaryType`, `nonce`, `deadline` |
| `POST lottery/box/open`, `box/merge` | JWT + EIP-712 | body `tokenIds`, `nonce`, `deadline`, `signature` → `jobId` |
| `GET lottery/job/{id}`, `lottery/jobs?active=true` | JWT | `status`, `minted[]`, `boxes[]` (`tokenId`, `rewardUsd`, `reward.asset`, `reward.amount`, `pfpTokenId`), `result` (`tokenId`, `level`, `consumedTokenIds`), `error` |
| `GET lottery/ledger`, `lottery/history` | JWT | `items[]` (`kind`, `tsMs`, `from`, `to`, `rewardUsd`, `reward`), `totalRewardUsd`, `totalRewardByAsset[]` |
| `GET lottery/draw/entries` | JWT | `round`, `status`, `deadlineMs`, `tickets`, `boxes`, `byLevel[]`, `wins`, `entries[].won`, `prizeLevel` |
| `GET lottery/feed` | công khai | `items[]` (`kind`, `tsMs`, `wallet`, `level`, `tokenId`, `rewardUsd`, `reward`, `pfp`) |
| `GET lottery/pfps`, `cybereator/profile/{id}` | JWT / công khai | `pfps[].profileTokenId`; `stage`, `thumb`, `image` |

## Ghi chú triển khai

- **Ký:** wagmi sẵn có. Đăng nhập bằng `useSignMessage` với đúng chuỗi `data.message`, không cần đổi mạng; trước khi ký so ví đang kết nối với master wallet của tài khoản. Open / merge bằng `useSignTypedData`, chuyển ví sang ValueChain trước như `use-sodex-signature.ts` (ví từ chối ký typed data khi `domain.chainId` khác mạng đang chọn; chỉ đổi mạng, không tốn gas).
- **JWT:** lưu `sessionStorage` theo địa chỉ ví; xoá khi 401, đổi ví, "Sign out of rewards", đăng xuất DeskLabs. Không localStorage, không cookie, không log, lọc header `Authorization` khỏi báo lỗi / analytics. Rủi ro XSS được giảm nhờ CSP nonce + `strict-dynamic` hiện có; token không rút / chuyển được tiền và open / merge còn cần chữ ký ví riêng.
- **CORS:** gateway trả `access-control-allow-origin: *`, preflight cho phép `Authorization, Content-Type`. Thêm `https://mainnet-gw.sodex.dev` vào CSP `connect-src` (và domain ảnh PFP vào `img-src`).
- **Backend:** không cần endpoint mới. Chỉ cần cờ tính năng (đề xuất `sodexRewards` trong `/api/v1/features`, bật theo tài khoản; tắt thì ẩn mục sidebar, thẻ Overview và route) và sửa CSP. Gateway origin để ở biến môi trường public.
- **Rate limit:** 6.000 weight / phút / IP người dùng (gọi từ trình duyệt, không đụng bucket Redis của DeskLabs). Poll job 2 s khi có job; summary / boxes / week list / feed làm mới 60 s khi trang hiển thị; 429 thì đọc `data.retryAfter`, dừng poll, hiện đếm ngược.
- **Popup:** desktop là dialog giữa màn; mobile là bottom sheet (`packages/ui` đã có `BottomSheet`). Đóng popup không huỷ job; dải trạng thái hiện ở thẻ Overview và tab Blind Boxes, "View" mở lại đúng bước.
- **Thẻ Overview:** danh sách dòng dùng `flex flex-1 flex-col justify-between` để dàn đều theo chiều cao Performance; nút cuối cùng kiểu với "Open agent" (`mt-auto flex min-h-tap items-center justify-center rounded-control bg-accent-tint text-sm font-bold text-accent-ink no-underline`).
- **Hiệu ứng** (bấm thử trong demo): dialog vào mờ + scale 0.96 → 1, 180 ms; ví chờ thở 1.6 s; bước đang chạy thở 1.4 s; Open lật thẻ 520 ms, lệch 140 ms (quá 8 box thì phần còn lại hiện cùng lúc, có Skip); Merge 10 ô bay vào tâm 450 ms rồi box mới nở 320 ms; Claim box rơi 420 ms, lệch 120 ms. `prefers-reduced-motion`: chỉ mờ dần ≤ 150 ms, không lật / bay / lắc.

## Câu hỏi còn mở ([confirm], không hiện trên UI)

1. DEC cho thứ tự sidebar mới (Rewards vị trí 2, Portfolio xuống nhóm dưới) và việc thẻ Trading Agent rời Overview.
2. Chip "New" bỏ khi nào (30 ngày, hay sau lần đầu mở trang).
3. Tên tier thật và kiểu của `currentTier` / `nextTier`; `nextTierPoints` là ngưỡng tổng hay số điểm còn thiếu (quyết định thanh tiến độ).
4. Kiểu số của `totalPoints` / `points`; đơn vị `spotVolume` / `futuresVolume`; giá trị `pointsStatus` ngoài `CONFIRMED`.
5. Thời hạn JWT (có `exp` không).
6. Volume do API key của DeskLabs tạo có được tính cho master wallet không (ví đăng nhập rewards phải là master wallet).
7. Tên "Blind Boxes" (DeskLabs) hay "Treasure Boxes" (tài liệu SoDEX).
8. Định dạng `boxes[].mintedAt` và đó là lúc mint hay lúc ví nhận; `boxes[]` sắp theo thứ tự nào (có phải đọc hết các trang 200 box trước khi chọn không).
9. `chainId` trong `sign-params` có luôn là 286623 không.
10. Giá trị / nhãn của `boxes[].source`, `treasures.bySource`; hình dạng item `ledger` theo `kind` và `history.totalRewardByAsset[]`.
11. Giá trị `draw/entries.status`, hình dạng `wins`, `prizeLevel`.
12. `rarity` của PFP; domain ảnh `image` / `thumb` cho CSP.
13. URL đích của "Open on SoDEX ↗" và "Rules on SoDEX ↗".
14. Chuỗi lỗi thật của `error` / `msg` (bản phác dùng câu ví dụ).
