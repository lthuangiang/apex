// Đọc claim `exp` (giây) của một JWT ở client, không kiểm chữ ký. Hàm thuần: không lưu, không log, không trả token; chỉ
// trả số mili giây. Token lệch dạng hoặc không có `exp` → null.

export function jwtExpiryMs(token: string): number | null {
  const part = token.split(".")[1];
  if (part === undefined) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as unknown;
    if (typeof json !== "object" || json === null) return null;
    const exp = (json as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}
