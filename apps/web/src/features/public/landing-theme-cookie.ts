// Cookie theme của landing / trang MCP (đọc ở server, ghi ở client). Module thường (không "use client") để page server
// gọi được. Không chứa dữ liệu cá nhân; chỉ "light" / "dark".

export type LandingTheme = "light" | "dark";

/** Server đọc cookie này để vẽ đúng theme ngay lần đầu (không chớp sáng khi người dùng đã chọn tối). */
export const LANDING_THEME_COOKIE = "desklabs_landing_theme";

/** Giá trị cookie hợp lệ → theme; còn lại → null (mặc định sáng). */
export function themeFromCookie(v: string | undefined): LandingTheme | null {
  return v === "dark" || v === "light" ? v : null;
}
