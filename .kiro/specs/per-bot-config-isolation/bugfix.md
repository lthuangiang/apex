# Bugfix Requirements Document

## Introduction

Khi chạy multi-bot (nhiều bot song song), `ConfigStore.applyOverrides()` mutate trực tiếp global `config` object được import từ `src/config.ts`. Do tất cả bot instance đều trỏ đến cùng một object này, bot khởi tạo sau sẽ ghi đè config của bot trước. Kết quả là mọi `Watcher` instance đều đọc config của bot cuối cùng gọi `applyOverrides()`, thay vì config riêng của từng bot.

Triệu chứng quan sát được: SoDEX bot exit ngay sau khi fill entry (FARM TIME EXIT sau 3–5 giây) thay vì hold đúng `FARM_MIN_HOLD_SECS=120s`, do `config.FARM_MIN_HOLD_SECS` và `config.FARM_MAX_HOLD_SECS` bị ghi đè bởi Decibel bot init.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN hai hoặc nhiều bot instance được khởi tạo song song và mỗi bot gọi `ConfigStore.applyOverrides()` với config riêng THEN hệ thống mutate cùng một global `config` object, khiến bot khởi tạo sau ghi đè toàn bộ config của bot trước

1.2 WHEN `Watcher` đọc `config.FARM_MIN_HOLD_SECS` hoặc `config.FARM_MAX_HOLD_SECS` trong quá trình chạy THEN hệ thống trả về giá trị từ global `config` đã bị ghi đè bởi bot khác, không phải config của bot hiện tại

1.3 WHEN SoDEX bot (farmMinHoldSecs=120) và Decibel bot cùng khởi tạo THEN hệ thống khiến SoDEX bot đọc `FARM_MIN_HOLD_SECS` của Decibel bot, dẫn đến `farmHoldUntil` được set đúng nhưng hold time check sử dụng sai giá trị config

### Expected Behavior (Correct)

2.1 WHEN hai hoặc nhiều bot instance được khởi tạo song song và mỗi bot gọi `ConfigStore.applyOverrides()` với config riêng THEN hệ thống SHALL đảm bảo mỗi bot chỉ đọc config của chính nó, không bị ảnh hưởng bởi `applyOverrides()` của bot khác

2.2 WHEN `Watcher` cần đọc giá trị config như `FARM_MIN_HOLD_SECS` hoặc `FARM_MAX_HOLD_SECS` THEN hệ thống SHALL đọc từ `configStore.getEffective()` của bot instance đó thay vì global `config` object

2.3 WHEN SoDEX bot (farmMinHoldSecs=120) và Decibel bot cùng chạy THEN hệ thống SHALL đảm bảo SoDEX bot luôn hold đúng 120 giây bất kể Decibel bot có gọi `applyOverrides()` hay không

### Unchanged Behavior (Regression Prevention)

3.1 WHEN chỉ có một bot instance duy nhất đang chạy THEN hệ thống SHALL CONTINUE TO áp dụng config overrides và bot hoạt động đúng như trước

3.2 WHEN dashboard gọi API để cập nhật config override cho một bot cụ thể THEN hệ thống SHALL CONTINUE TO chỉ thay đổi config của bot đó, không ảnh hưởng đến các bot khác

3.3 WHEN `ConfigStore.resetToDefaults()` được gọi cho một bot THEN hệ thống SHALL CONTINUE TO reset về base config values cho bot đó mà không ảnh hưởng đến các bot khác

3.4 WHEN `ConfigStore.loadFromDisk()` được gọi lúc startup THEN hệ thống SHALL CONTINUE TO load và validate persisted overrides từ disk đúng như hiện tại

3.5 WHEN bot đang ở trạng thái IN_POSITION và cần kiểm tra exit conditions (FARM_TP_USD, FARM_EARLY_EXIT_SECS, FARM_EARLY_EXIT_PNL) THEN hệ thống SHALL CONTINUE TO evaluate đúng các điều kiện exit dựa trên config của bot đó
