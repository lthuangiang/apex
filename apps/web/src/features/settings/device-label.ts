/** Tên dễ đọc của phiên đăng nhập từ user agent, ví dụ "Chrome on macOS". Không nhận ra thì trả nguyên chuỗi. */
export function deviceLabel(ua: string | null): string | null {
  if (ua === null || ua === "") return null;
  const browser = ua.includes("Edg/")
    ? "Edge"
    : ua.includes("Chrome/")
      ? "Chrome"
      : ua.includes("Firefox/")
        ? "Firefox"
        : ua.includes("Safari/")
          ? "Safari"
          : null;
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : ua.includes("Android")
      ? "Android"
      : ua.includes("Mac OS X")
        ? "macOS"
        : ua.includes("Windows")
          ? "Windows"
          : ua.includes("Linux")
            ? "Linux"
            : null;
  return browser === null || os === null ? ua : `${browser} on ${os}`;
}
