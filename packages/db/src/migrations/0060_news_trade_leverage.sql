-- #458: đòn bẩy isolated SoDEX đã xác nhận lúc vào lệnh news, lưu theo từng lệnh (không suy từ config). Chỉ thêm cột,
-- không backfill: lệnh ghi trước bản này để null.
ALTER TABLE "news_signal_trades" ADD COLUMN "leverage" smallint;