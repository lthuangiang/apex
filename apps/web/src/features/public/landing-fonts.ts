import localFont from "next/font/local";

// Font của landing và trang MCP (DEC-TBD-fonts-self-host): tự host từ gói npm @fontsource-variable (OFL-1.1), subset latin,
// bản variable. Build không phụ thuộc Google Fonts, CSP `font-src 'self'` vẫn đủ. Chỉ module của landing / trang MCP
// import file này, nên app không nạp các font này (bước 2 đổi font cả app là PR riêng). Các trang import thẳng từ file
// component (không qua barrel `features/public`), để route của app không kéo theo font này. `preload: false`: route `/`
// còn hiện Overview cho người đã đăng nhập, không nên tải trước font của landing cho họ.

const spaceGrotesk = localFont({
  src: "../../../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2",
  weight: "500 700",
  display: "swap",
  preload: false,
  variable: "--font-space-grotesk",
});

const inter = localFont({
  src: "../../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  weight: "400 600",
  display: "swap",
  preload: false,
  variable: "--font-inter",
});

const jetbrainsMono = localFont({
  src: "../../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  weight: "400 500",
  display: "swap",
  preload: false,
  variable: "--font-jetbrains-mono",
});

/** Class gắn biến font lên khối `.landing`. */
export const LANDING_FONTS = `${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable}`;
