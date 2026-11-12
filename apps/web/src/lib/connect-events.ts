import type { ConnectEventType } from "@drift/shared";
import { z } from "zod";

import { api } from "@/lib/api";

// Ghi từng bước của màn Connect SoDEX (DEC-114) để team hỗ trợ khách bị kẹt. Gửi ngầm, lỗi gửi không bao giờ chặn
// màn hình. Không gửi chữ ký, key hay secret; địa chỉ ví chỉ gửi dạng rút gọn.

type Value = string | number | boolean | null | string[];
export type EventData = Record<string, Value>;

const WALLET_FLAGS = [
  "isMetaMask",
  "isOkxWallet",
  "isOKExWallet",
  "isBinance",
  "isBitKeep",
  "isBitget",
  "isTrust",
  "isTrustWallet",
  "isCoinbaseWallet",
  "isRabby",
  "isTokenPocket",
  "isPhantom",
  "isSafePal",
] as const;

const IN_APP = [
  ["MetaMaskMobile", "MetaMask"],
  ["OKApp", "OKX"],
  ["BNC/", "Binance"],
  ["Binance", "Binance"],
  ["BitKeep", "Bitget"],
  ["Bitget", "Bitget"],
  ["Trust", "Trust"],
  ["TokenPocket", "TokenPocket"],
  ["CoinbaseBrowser", "Coinbase"],
  ["SafePal", "SafePal"],
] as const;

/** Thiết bị và trình duyệt, đọc ở client lúc mở trang. Chỉ là gợi ý để hỗ trợ, không dùng để chặn. */
export function deviceInfo(): EventData {
  if (typeof window === "undefined") return {};
  const ua = navigator.userAgent;
  // iPad ở chế độ desktop báo UA của Mac; nhận ra nhờ màn cảm ứng.
  const iPadDesktop = ua.includes("Macintosh") && navigator.maxTouchPoints > 1;
  const mobile = iPadDesktop || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const os =
    iPadDesktop || /iPhone|iPad|iPod/i.test(ua)
      ? "iOS"
      : /Android/i.test(ua)
        ? "Android"
        : /Mac OS X/i.test(ua)
          ? "macOS"
          : /Windows/i.test(ua)
            ? "Windows"
            : /Linux/i.test(ua)
              ? "Linux"
              : "other";
  const inApp = IN_APP.find(([needle]) => ua.includes(needle))?.[1] ?? null;
  const browser = inApp
    ? `${inApp} in-app`
    : /Edg\/|EdgiOS\//.test(ua)
      ? "Edge"
      : ua.includes("OPR/")
        ? "Opera"
        : /Firefox\/|FxiOS\//.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : ua.includes("Safari/")
              ? "Safari"
              : "other";
  const eth = (window as unknown as { ethereum?: Record<string, unknown> }).ethereum;
  return {
    device: mobile ? "mobile" : "desktop",
    os,
    browser,
    // App Android (TWA) hoặc đã cài như app: chạy ở chế độ standalone.
    standalone: window.matchMedia("(display-mode: standalone)").matches,
    width: window.innerWidth,
    lang: navigator.language,
    hasEthereum: eth !== undefined,
    ethereumFlags: eth === undefined ? [] : WALLET_FLAGS.filter((f) => eth[f] === true),
    ua: ua.slice(0, 300),
  };
}

/** Rút gọn lỗi ví (wagmi / viem / ví) thành tên + câu ngắn, không kèm dữ liệu khác. */
export function errorInfo(e: unknown): EventData {
  if (!(e instanceof Error)) return { reason: "unknown" };
  const short = (e as { shortMessage?: unknown }).shortMessage;
  const code = (e as { code?: unknown }).code;
  return {
    reason: e.name,
    message: (typeof short === "string" ? short : e.message).slice(0, 300),
    ...(typeof code === "string" || typeof code === "number" ? { code: String(code) } : {}),
  };
}

export const shortWallet = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Gửi một bước; không chờ, không ném lỗi. */
export function logConnectEvent(attemptId: string, type: ConnectEventType, data: EventData = {}) {
  void api("POST", "/api/v1/sodex/connect-events", z.null(), {
    body: { attemptId, type, data },
  }).catch(() => undefined);
}
