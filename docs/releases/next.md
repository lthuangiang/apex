# vTBD (sau v2.18.6)

PM đổi tên file theo tag khi người dùng gõ "release" (xem `docs/RELEASE.md` mục 2; số version để TBD). Danh sách tính từ tag `v2.18.6` (2026-11-25). Mục nào ghi **chưa merge** là việc đang làm: khi PR merge thì bỏ chữ đó và thêm số PR; PR không vào bản này thì xoá dòng.

## Cho người dùng (English, dùng được cho GitHub Release)

Chưa có thay đổi.

Not financial advice. Past results are not a forecast.

## Kỹ thuật

- Nền cho "một sự kiện nhiều coin, chia cỡ lệnh" (#530 PR1, DEC-TBD-news-event-coins; **chưa merge**): `news_signals.event_key` / `event_coins` (mặc định 1), engine đưa vào tín hiệu, bot news chia `sizeUsdc` cho `event_coins` (làm tròn xuống tới cent, vẫn trần 200 USDC). Không đổi hành vi: scheduler chưa ghi các cột này nên mọi tín hiệu vẫn là một coin. **Điều kiện thứ tự:** bản này phải được release và deploy trước khi merge #530 PR2 (scheduler ghi nhiều coin); nếu không, engine cũ mở đủ cỡ lệnh cho mỗi coin.

**Migration (chạy khi deploy):** `0061_news_event_coins` (#530 PR1): thêm hai cột vào `news_signals` (`event_key` text null, `event_coins` int not null default 1). Chỉ thêm cột, không backfill.

**Biến môi trường mới:** không có.
