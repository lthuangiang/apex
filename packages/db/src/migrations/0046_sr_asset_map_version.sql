-- Signal research (#309): version danh sách tài sản lúc mở lệnh giấy. Cột nullable, không default (chỉ sửa metadata);
-- lệnh cũ để null.
ALTER TABLE "signal_paper_trades" ADD COLUMN "asset_map_version" text;