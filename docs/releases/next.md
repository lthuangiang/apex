# vTBD (sau v2.18.7)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.7` (2026-11-25). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Nền cho "một sự kiện nhiều coin, chia cỡ lệnh" (#530 PR1, DEC-392; **chưa merge**): `news_signals.event_key` / `event_coins` (mặc định 1), engine đưa vào tín hiệu, bot news chia min(`sizeUsdc`, trần 200 USDC) cho `event_coins` (làm tròn xuống tới cent; tổng của sự kiện không vượt 200, vd 500 / 3 → 66.66 mỗi coin). Không đổi hành vi: scheduler chưa ghi các cột này nên mọi tín hiệu vẫn là một coin. **Điều kiện thứ tự:** bản này phải được release và deploy trước khi merge #530 PR2 (scheduler ghi nhiều coin); nếu không, engine cũ mở đủ cỡ lệnh cho mỗi coin.
- Một bài tin nêu nhiều coin của một sự kiện ra một tín hiệu mỗi coin, chia cỡ lệnh (#530 PR2, DEC-TBD-news-event-split; **chưa merge**): Rules `news-v6` + reader `news-classifier-v7` (`other_markets`); paper chia `sizeUsdc` ÷ k, phần dưới cỡ tối thiểu bị bỏ `BELOW_MIN_ORDER_SIZE`; bài đăng lại cùng sự kiện trong 24 giờ không mở lệnh mới (`SAME_EVENT`, trừ lần thử lại trong 120 phút); mainnet ghi một dòng `news_signals` mỗi coin với `event_key` / `event_coins`. Đổi Rules nên tổng kết, nhãn và cổng đếm lại từ v6; bài đang dở chuyển sang v6. **Điều kiện thứ tự:** chỉ merge sau khi bản có #530 PR1 đã release VÀ deploy (người dùng xác nhận); eval reader v7 bắt buộc trước khi merge.

**Migration (chạy khi deploy):** `0061_news_event_coins` (#530 PR1): thêm hai cột vào `news_signals` (`event_key` text null, `event_coins` int not null default 1). Chỉ thêm cột, không backfill. `0062_sr_context_per_coin` (#530 PR2): `signal_contexts` đổi unique từ (bài) sang (bài, market), một snapshot ngữ cảnh mỗi coin; chỉ đổi index, dòng cũ giữ nguyên.

**Biến môi trường mới:** không có.
