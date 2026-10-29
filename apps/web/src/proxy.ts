import { SESSION_COOKIE } from "@drift/shared";
import { NextResponse, type NextRequest } from "next/server";

// Content-Security-Policy chặt (CODING_STANDARDS C12): script chỉ chạy khi có nonce của request này, không có
// `unsafe-inline` cho script. Next đọc nonce từ header CSP của request và gắn vào script của nó.
// Style giữ `unsafe-inline` (thuộc tính `style` động của biểu đồ); C12 chỉ cấm cho script.

/**
 * Nguồn ngoài của WalletConnect (relay, verify, modal); chỉ mở khi có Project ID. Modal (Reown AppKit) lấy
 * danh sách ví và logo ví từ api.web3modal.org: thiếu thì "All Wallets" chỉ hiện ô xám.
 */
const WALLETCONNECT = {
  connect:
    "https://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.com wss://*.walletconnect.org https://*.reown.com wss://*.reown.com https://*.web3modal.org https://*.web3modal.com",
  frame:
    "https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.org",
  img: "https://*.walletconnect.com https://*.reown.com https://*.web3modal.org https://*.web3modal.com",
  font: "https://fonts.reown.com",
};

export function buildCsp(nonce: string, dev: boolean, walletConnect = false): string {
  const wc = (k: keyof typeof WALLETCONNECT) => (walletConnect ? ` ${WALLETCONNECT[k]}` : "");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${wc("img")}`,
    `font-src 'self'${wc("font")}`,
    // RPC ValueChain: wagmi đọc chain khi chuyển mạng trong ví.
    `connect-src 'self' https://mainnet.valuechain.xyz${dev ? " ws: wss:" : " wss:"}${wc("connect")}`,
    `frame-src 'self'${wc("frame")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Trang chỉ dùng khi chưa đăng nhập: đã có phiên thì về Overview. */
const SIGNED_OUT_PATHS = ["/signup", "/signin"];
/** Trang mở cho cả hai trạng thái. `/` chưa đăng nhập là Landing, đã đăng nhập là Overview (app/page.tsx). */
const OPEN_PATHS = ["/", "/risk-disclosure", "/robots.txt", "/opengraph-image"];

/** Chặn theo cookie phiên: null = cho qua, còn lại là đường dẫn cần chuyển tới. */
export function redirectFor(path: string, signedIn: boolean): string | null {
  if (OPEN_PATHS.includes(path)) return null;
  const signedOutOnly = SIGNED_OUT_PATHS.includes(path);
  if (!signedIn && !signedOutOnly) return "/signup";
  if (signedIn && signedOutOnly) return "/";
  return null;
}

export function proxy(request: NextRequest) {
  // Phiên còn hạn hay không do api quyết định (401 thì client chuyển về /signup).
  const target = redirectFor(request.nextUrl.pathname, request.cookies.has(SESSION_COOKIE));
  if (target !== null) return NextResponse.redirect(new URL(target, request.url));

  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(
    nonce,
    process.env.NODE_ENV === "development",
    (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "") !== "",
  );
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
}

export const config = {
  // Bỏ qua API (api tự đặt header), file tĩnh, icon (app/icon.svg, apple-icon.png) và prefetch.
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
