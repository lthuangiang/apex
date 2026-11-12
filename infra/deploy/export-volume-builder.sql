-- Export lịch sử giao dịch của bot Volume Builder (strategy volume_farm, chế độ live) để phân tích tham số.
-- Không xuất email, user id, account SoDEX hay khoá. Ghi 5 file CSV vào /tmp/vb-export (trong container postgres).
--
-- Chạy trên server, trong /opt/drift:
--   docker compose exec -T postgres sh -c 'rm -rf /tmp/vb-export && mkdir -p /tmp/vb-export'
--   docker compose exec -T postgres psql -U drift -d drift -v ON_ERROR_STOP=1 -f - < export-volume-builder.sql
--   docker compose cp postgres:/tmp/vb-export ./vb-export && tar czf vb-export.tgz vb-export && rm -rf vb-export

\pset footer off

-- 1. Cấu hình từng version của bot (tham số đang dùng, lúc áp dụng).
\copy (select b.id as bot_id, b.name as bot_name, b.market, b.state, b.reason_code, b.created_at as bot_created_at, v.version, v.status as version_status, v.param_source, v.applied_at, v.created_at as version_created_at, v.config::text as config from bots b join bot_versions v on v.bot_id = b.id where b.strategy = 'volume_farm' and b.mode = 'live' order by b.id, v.version) to '/tmp/vb-export/configs.csv' with (format csv, header)

-- 2. Decisions: Enter, Closed (lý do thoát, giá vào / ra, lãi ròng), dời stop, bỏ qua lệnh, pause, stop.
\copy (select e.bot_id, e.occurred_at, e.type, e.decision, e.why, e.result from bot_events e join bots b on b.id = e.bot_id where b.strategy = 'volume_farm' and b.mode = 'live' order by e.bot_id, e.occurred_at) to '/tmp/vb-export/events.csv' with (format csv, header)

-- 3. Lệnh: tag vf:<lượt>:in|out|sl, loại lệnh, trạng thái, lý do bị từ chối, thời điểm gửi / ack.
\copy (select o.bot_id, o.id as order_id, o.cl_ord_id, o.tag, o.market, o.side, o.type, o.time_in_force, o.price, o.size, o.filled_size, o.avg_price, o.status, o.reduce_only, o.reject_code, o.reject_message, o.submitted_at, o.acked_at, o.created_at from orders o join bots b on b.id = o.bot_id where b.strategy = 'volume_farm' and b.mode = 'live' order by o.bot_id, o.created_at) to '/tmp/vb-export/orders.csv' with (format csv, header)

-- 4. Fill: giá, khối lượng, phí (đã gồm builder fee), builder fee, maker hay taker.
\copy (select o.bot_id, f.order_id, o.tag, o.side, o.type, f.price, f.size, f.fee, f.builder_fee, f.is_maker, f.filled_at from fills f join orders o on o.id = f.order_id join bots b on b.id = o.bot_id where b.strategy = 'volume_farm' and b.mode = 'live' order by o.bot_id, f.filled_at) to '/tmp/vb-export/fills.csv' with (format csv, header)

-- 5. Nến 1 phút của các market đã chạy, từ 1 giờ trước bot đầu tiên: để tính lãi lớn nhất / lỗ lớn nhất trong
--    lượt (MFE / MAE) và chạy backtest lại đúng giai đoạn.
\copy (select c.market, c.ts, c.open, c.high, c.low, c.close, c.volume from candles_1m c where c.market in (select distinct market from bots where strategy = 'volume_farm' and mode = 'live') and c.ts >= (select min(created_at) - interval '1 hour' from bots where strategy = 'volume_farm' and mode = 'live') order by c.market, c.ts) to '/tmp/vb-export/candles_1m.csv' with (format csv, header)

\echo 'Done: /tmp/vb-export'
