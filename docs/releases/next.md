# vTBD (sau v2.18.7)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.7` (2026-11-25). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Nền cho "một sự kiện nhiều coin, chia cỡ lệnh" (#530 PR1, DEC-392; **chưa merge**): `news_signals.event_key` / `event_coins` (mặc định 1), engine đưa vào tín hiệu, bot news chia min(`sizeUsdc`, trần 200 USDC) cho `event_coins` (làm tròn xuống tới cent; tổng của sự kiện không vượt 200, vd 500 / 3 → 66.66 mỗi coin). Không đổi hành vi: scheduler chưa ghi các cột này nên mọi tín hiệu vẫn là một coin. PR1, PR2, PR3 lên prod cùng một lần; chia sự kiện cho mainnet nằm sau cờ `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` của PR2 (mặc định tắt).
- Một bài tin nêu nhiều coin của một sự kiện ra một tín hiệu mỗi coin, chia cỡ lệnh (#530 PR2, DEC-393; **chưa merge**): Rules `news-v6` + reader `news-classifier-v7` (`other_markets`); paper chia `sizeUsdc` ÷ k, phần dưới cỡ tối thiểu bị bỏ `BELOW_MIN_ORDER_SIZE`; bài đăng lại cùng sự kiện trong 24 giờ không mở lệnh mới (`SAME_EVENT`, trừ lần thử lại trong 120 phút); mainnet sau cờ mới `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` (scheduler, mặc định **tắt**): tắt = mỗi bài một dòng `news_signals` cho coin chính, `event_coins` 1 (paper vẫn hiện lệnh chia, Mainnet một lệnh đủ cỡ cho coin chính; `SAME_EVENT` vẫn áp nên Mainnet chỉ ít lệnh hơn); bật = một dòng mỗi coin với `event_key` / `event_coins` = k. Đổi Rules nên tổng kết, nhãn và cổng đếm lại từ v6; bài đang dở chuyển sang v6. **Điều kiện thứ tự:** cờ tắt mặc định, chỉ bật sau khi mọi service (engine, api, scheduler) đã lên bản mới; rollback về bản trước v2.18.8 thì tắt cờ TRƯỚC (`docs/DEPLOY.md` mục 2.20). Eval reader v7 chưa chạy theo quyết định của người dùng ngày 25/11; việc kiểm sẽ là file export Signal Research 24 giờ đầu sau deploy.

**Migration (chạy khi deploy):** `0061_news_event_coins` (#530 PR1): thêm hai cột vào `news_signals` (`event_key` text null, `event_coins` int not null default 1). Chỉ thêm cột, không backfill. `0062_sr_context_per_coin` (#530 PR2): `signal_contexts` đổi unique từ (bài) sang (bài, market), một snapshot ngữ cảnh mỗi coin; chỉ đổi index, dòng cũ giữ nguyên.

**Biến môi trường mới:** `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` (scheduler, mặc định `false`; #530 PR2, `docs/DEPLOY.md` mục 2.20). Để `false` khi deploy; bật sau khi mọi service đã lên bản mới.
