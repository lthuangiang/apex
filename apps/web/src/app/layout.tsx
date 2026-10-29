import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import type { ReactNode } from "react";

import { Providers } from "./providers";
import "./globals.css";

// Chỉ Landing được index (UI_REVIEW K): mặc định noindex, `app/page.tsx` bật lại khi chưa đăng nhập.
export const metadata: Metadata = { title: "DRIFT", robots: { index: false, follow: false } };

// Font tự host từ gói npm (OFL-1.1): build không phụ thuộc Google Fonts, CSP `font-src 'self'` vẫn đủ.
// Bản variable phủ weight 400–800. Token `--font-sans` trỏ vào biến này.
const jakarta = localFont({
  src: "../../node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2",
  weight: "200 800",
  display: "swap",
  variable: "--font-jakarta",
});

export default async function RootLayout({ children }: { children: ReactNode }) {
  const messages = await getMessages();
  // Đọc header để trang render động theo request: Next gắn nonce CSP (proxy.ts) vào script của nó.
  await headers();
  return (
    <html lang="en" className={jakarta.variable}>
      <body className="min-h-screen bg-bg text-ink">
        <NextIntlClientProvider messages={messages}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
