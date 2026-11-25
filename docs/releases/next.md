# vTBD (sau v2.18.8)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.8` (2026-11-25). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Một bài tin nêu nhiều coin của một sự kiện ra một tín hiệu mỗi coin, chia cỡ lệnh (#530 PR2, DEC-393; **chưa merge**): Rules `news-v6` + reader `news-classifier-v7` (`other_markets`); paper chia `sizeUsdc` ÷ k, phần dưới cỡ tối thiểu bị bỏ `BELOW_MIN_ORDER_SIZE`; bài đăng lại cùng sự kiện trong 24 giờ không mở lệnh mới (`SAME_EVENT`, trừ lần thử lại trong 120 phút); mainnet sau cờ mới `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` (scheduler, mặc định **tắt**): tắt = mỗi bài một dòng `news_signals` cho coin chính, `event_coins` 1 (paper vẫn hiện lệnh chia, Mainnet một lệnh đủ cỡ cho coin chính; `SAME_EVENT` vẫn áp nên Mainnet chỉ ít lệnh hơn); bật = một dòng mỗi coin với `event_key` / `event_coins` = k (engine chia cỡ từ #530 PR1, đã có trong v2.18.8). Đổi Rules nên tổng kết, nhãn và cổng đếm lại từ v6; bài đang dở chuyển sang v6. **Điều kiện thứ tự:** cờ tắt mặc định; deploy mọi service (engine, api, scheduler) lên bản mới trước, bật cờ sau; rollback về bản trước v2.18.8 thì tắt cờ TRƯỚC (`docs/DEPLOY.md` mục 2.20). Eval reader v7 chưa chạy theo quyết định của người dùng ngày 25/11; việc kiểm sẽ là file export Signal Research 24 giờ đầu sau deploy.
- Trace và danh sách lệnh của sự kiện nhiều coin (#530 PR3, DEC-394; **chưa merge**): trace trả thêm `event` (k, bài đầu của bài đăng lại, kết quả / story / lệnh / snapshot Context từng coin), feed trả `tradedAssets`, chi tiết lệnh trả `eventCoins`, tổng kết trả `funnel.sizeSplit`, Mainnet trades trả `eventCoins`. Web: band Normalize liệt kê mọi market, Filter "{passed} of {n} coins passed", Decide "Long {size} USDC × {n}", lý do "Same event" kèm "First article", câu "Size split across {n} coins from one event.", ghi chú "Up to {size} USDC each"; cỡ lệnh chia hiện đủ cent. Không migration. **Triển khai:** PR2 + PR3 lên cùng một lần deploy (PR1 đã có trong v2.18.8); cờ `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` tắt mặc định, bật sau khi mọi service đã lên bản mới. Cờ tắt: bot Mainnet nhận tín hiệu một coin (`event_coins` 1), Mainnet trades không hiện câu chia.

**Migration (chạy khi deploy):** `0062_sr_context_per_coin` (#530 PR2): `signal_contexts` đổi unique từ (bài) sang (bài, market), một snapshot ngữ cảnh mỗi coin; chỉ đổi index, dòng cũ giữ nguyên.

**Biến môi trường mới:** `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` (scheduler, mặc định `false`; #530 PR2, `docs/DEPLOY.md` mục 2.20). Để `false` khi deploy; bật sau khi mọi service đã lên bản mới.
