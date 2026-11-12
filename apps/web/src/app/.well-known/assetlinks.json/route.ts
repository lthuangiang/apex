// Digital Asset Links cho app Android (TWA, infra/mobile/README.md): Android chỉ ẩn thanh địa chỉ khi tên miền
// khai báo đúng package và SHA-256 của khoá ký. Đọc env lúc chạy, nên đổi khoá chỉ cần đặt env và khởi động lại web:
//   ANDROID_PACKAGE_NAME   ví dụ com.drift.app
//   ANDROID_CERT_SHA256    một hoặc nhiều fingerprint, cách nhau bằng dấu phẩy (thêm key Play App Signing nếu dùng)
// Chưa đặt thì trả danh sách rỗng (hợp lệ, không uỷ quyền app nào).

import { assetLinks } from "@/features/public/asset-links";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(assetLinks(process.env), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
