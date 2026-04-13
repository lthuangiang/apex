# Bugfix Requirements Document

## Introduction

Cải thiện hành vi start/stop của bot giao dịch. Hiện tại khi start bot, giá trị `maxLoss` mặc định quá cao ($50), session không được reset hoàn toàn, và các message Telegram thiếu thông tin quan trọng như Account Balance. Khi stop bot, message không bao gồm thông tin về delay trước khi bot chạy lại.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN bot được start THEN hệ thống khởi tạo `maxLoss` mặc định là $50 thay vì $5

1.2 WHEN bot được start THEN hệ thống không reset các giá trị session trong `Watcher` như `sessionStartBalance`, `sessionCurrentPnl`, `sessionVolume`, `recentPnLs`, `currentProfile`, `cooldownUntil`, `lastTradeContext`

1.3 WHEN bot được start THEN message Telegram gửi lên chỉ có nội dung "Bot started. Session initialized." mà không bao gồm Account Balance, Max Fee Loss, hay thông tin session

1.4 WHEN bot được stop THEN message Telegram không bao gồm thông tin về delay (cooldown) hiện tại trước khi bot có thể chạy lại

### Expected Behavior (Correct)

2.1 WHEN bot được start THEN hệ thống SHALL khởi tạo `maxLoss` mặc định là $5

2.2 WHEN bot được start THEN hệ thống SHALL reset toàn bộ giá trị session trong `Watcher` bao gồm `sessionStartBalance`, `sessionCurrentPnl`, `sessionVolume`, `recentPnLs`, `currentProfile`, `cooldownUntil`, `lastTradeContext`

2.3 WHEN bot được start THEN hệ thống SHALL gửi message Telegram chi tiết bao gồm Account Balance hiện tại, Max Fee Loss, symbol đang trade, và thời gian bắt đầu session

2.4 WHEN bot được stop THEN hệ thống SHALL gửi message Telegram bao gồm thông tin cooldown hiện tại (nếu có) — thời gian còn lại trước khi bot có thể vào lệnh tiếp theo

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `set_max_loss` command được gọi sau khi start THEN hệ thống SHALL CONTINUE TO cập nhật `maxLoss` theo giá trị người dùng nhập

3.2 WHEN bot đang chạy và đạt max loss THEN hệ thống SHALL CONTINUE TO tự động dừng và gửi thông báo emergency stop

3.3 WHEN bot được stop trong khi không có cooldown active THEN hệ thống SHALL CONTINUE TO gửi stop message bình thường mà không bị lỗi

3.4 WHEN bot được start lần thứ hai trong cùng một process THEN hệ thống SHALL CONTINUE TO từ chối start nếu session đang running
