// #457: nhớ chế độ Paper / Mainnet và bot Mainnet đang chọn của trang Signal Research, cho từng người xem. Thứ tự khi vào
// trang: query `?bots=` (link chia sẻ thắng) → lựa chọn lần trước trong localStorage (`sr:mode`) → Paper. localStorage chỉ
// là tiện ích: mọi lần đọc / ghi bọc try/catch (trình duyệt chặn, private mode, SSR không có `window`), lỗi hoặc rỗng thì
// như chưa nhớ gì. Bot đã nhớ (`sr:mainnetBot`) không còn trong danh sách thì trang chọn bot đầu tiên như trước.

export type ResearchMode = "paper" | "mainnet";

export const MODE_KEY = "sr:mode";
export const BOT_KEY = "sr:mainnetBot";

const isMode = (v: string | null): v is ResearchMode => v === "paper" || v === "mainnet";

/** Đọc localStorage; null khi không có `window`, không có storage, bị chặn hoặc lỗi. */
export function readStored(key: string): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Ghi (hoặc xoá khi `value` là null) localStorage; lỗi thì bỏ qua, trang vẫn chạy. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage bị chặn / đầy: chỉ mất phần nhớ, không ảnh hưởng trang.
  }
}

/** Chế độ khi vào trang: query `bots` hợp lệ → giá trị đã nhớ hợp lệ → Paper. */
export function initialMode(search: string, stored: string | null): ResearchMode {
  const q = new URLSearchParams(search).get("bots");
  if (isMode(q)) return q;
  if (isMode(stored)) return stored;
  return "paper";
}

/** Chế độ khi vào trang, đọc từ URL và localStorage hiện tại (SSR: Paper). */
export function loadMode(): ResearchMode {
  if (typeof window === "undefined") return "paper";
  return initialMode(window.location.search, readStored(MODE_KEY));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * #470: link "Open in Signal Research" từ Trading Agent: `?bots=mainnet&bot=<id>&settings=1`. Trả bot cần chọn (uuid hợp
 * lệ, không thì null) và có mở Settings không. Bot không còn trong danh sách thì trang chọn bot đầu tiên như thường.
 */
export function linkTarget(search: string): { bot: string | null; settings: boolean } {
  const q = new URLSearchParams(search);
  const bot = q.get("bot");
  return { bot: bot !== null && UUID.test(bot) ? bot : null, settings: q.get("settings") === "1" };
}

/** Link tới bot Mainnet trong Signal Research, mở sẵn Settings (#470). */
export const signalResearchBotHref = (botId: string): string =>
  `/signal-research?bots=mainnet&bot=${botId}&settings=1`;

/** Bot sẽ hiện: bot đã chọn / đã nhớ nếu còn trong danh sách, không thì bot đầu tiên, danh sách rỗng thì null. */
export function pickBot<T extends { id: string }>(
  bots: readonly T[],
  wanted: string | null,
): T | null {
  return bots.find((b) => b.id === wanted) ?? bots[0] ?? null;
}
