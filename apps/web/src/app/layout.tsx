import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import type { ReactNode } from "react";

import { SHARE_IMAGE } from "@/lib/share-image";

import { Providers } from "./providers";
import "./globals.css";

// Chỉ Landing được index (UI_REVIEW K): mặc định noindex, `app/page.tsx` bật lại khi chưa đăng nhập.
// `metadataBase` lấy theo tên miền của request (Traefik gắn X-Forwarded-Host / Proto), để og:image là URL tuyệt đối
// đúng tên miền (trước đây ra http://localhost:3000, mạng xã hội không tải được ảnh). DEC-156.
export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "desklabs.xyz";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return {
    metadataBase: new URL(`${proto}://${host}`),
    title: "DeskLabs",
    robots: { index: false, follow: false },
    openGraph: { siteName: "DeskLabs", type: "website", images: [SHARE_IMAGE] },
    twitter: { card: "summary_large_image", images: [SHARE_IMAGE] },
  };
}

// Thanh trạng thái của trình duyệt / app cài từ manifest cùng màu nền `--bg` (app chỉ có giao diện sáng).
export const viewport: Viewport = { themeColor: "#eef1fa" };

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
