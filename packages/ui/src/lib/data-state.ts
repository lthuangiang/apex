/** Bốn trạng thái bắt buộc cho mọi vùng dữ liệu (docs/DESIGN.md D5). `stale` đi kèm `ready`. */
export type DataStatus = "loading" | "empty" | "error" | "ready";

/** Thời điểm đã được format ở app (theo múi giờ người dùng) kèm giá trị ISO cho `<time>`. */
export interface Timestamp {
  dateTime: string;
  text: string;
}
