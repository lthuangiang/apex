import localFont from "next/font/local";

// Font của landing và trang MCP (DEC-TBD-fonts-self-host): tự host từ gói npm @fontsource-variable (OFL-1.1), subset latin,
// bản variable. Build không phụ thuộc Google Fonts, CSP `font-src 'self'` vẫn đủ. Chỉ module của landing / trang MCP
// import file này, nên app không nạp các font này (bước 2 đổi font cả app là PR riêng).

const spaceGrotesk = localFont({
  src: "../../../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2",
  weight: "500 700",
  display: "swap",
  variable: "--font-space-grotesk",
});

const inter = localFont({
  src: "../../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  weight: "400 600",
  display: "swap",
  variable: "--font-inter",
});

const jetbrainsMono = localFont({
  src: "../../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  weight: "400 500",
  display: "swap",
  variable: "--font-jetbrains-mono",
});

/** Class gắn biến font lên khối `.landing`. */
export const LANDING_FONTS = `${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable}`;
