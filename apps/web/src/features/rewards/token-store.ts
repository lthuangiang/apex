import { jwtExpiryMs } from "./jwt-exp";

// JWT đăng nhập rewards: ở localStorage của trình duyệt này tới khi `exp` hết hạn (DEC-401,
// đổi nơi lưu của DEC-397), khoá theo địa chỉ ví (chữ thường). Không cookie, không gửi về server DeskLabs ngoài
// `POST /api/v1/rewards/watch` (DEC-398), không log. Xoá khi SoDEX trả 401, khi đổi ví, khi bấm "Sign out of rewards",
// khi đăng xuất DeskLabs và khi đọc thấy `exp` đã qua. Các tab cùng trình duyệt đồng bộ qua sự kiện `storage`.
// Storage có thể bị chặn (private window…): mọi thao tác bọc try/catch, lỗi thì coi như chưa đăng nhập.

export const REWARDS_TOKEN_PREFIX = "desklabs.rewards.jwt.";

const keyOf = (address: string) => `${REWARDS_TOKEN_PREFIX}${address.toLowerCase()}`;

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

/** Tab khác ghi / xoá token rewards (hoặc xoá sạch localStorage) thì báo cho tab này. */
function onStorage(e: StorageEvent) {
  if (e.key === null || e.key.startsWith(REWARDS_TOKEN_PREFIX)) emit();
}

/** Cho `useSyncExternalStore`. */
export function subscribeRewardsTokens(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}

let legacyDropped = false;
/** Bản trước lưu ở sessionStorage (DEC-397): xoá một lần, không chuyển sang localStorage. */
function dropLegacySessionTokens() {
  if (legacyDropped) return;
  legacyDropped = true;
  try {
    const s = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(REWARDS_TOKEN_PREFIX) === true) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    // Bỏ qua.
  }
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    dropLegacySessionTokens();
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readRewardsToken(address: string | null | undefined): string | null {
  if (address == null || address === "") return null;
  try {
    const s = storage();
    const v = s?.getItem(keyOf(address)) ?? null;
    if (v === null || v === "") return null;
    const exp = jwtExpiryMs(v);
    if (exp !== null && exp <= Date.now()) {
      s?.removeItem(keyOf(address));
      // Có thể đang trong getSnapshot của React: báo sau, không báo ngay trong lúc render.
      queueMicrotask(emit);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export function saveRewardsToken(address: string, token: string): void {
  try {
    storage()?.setItem(keyOf(address), token);
  } catch {
    // Không lưu được thì chỉ mất tiện lợi: lần sau ký lại.
  }
  emit();
}

export function clearRewardsToken(address: string | null | undefined): void {
  if (address == null || address === "") return;
  try {
    storage()?.removeItem(keyOf(address));
  } catch {
    // Bỏ qua.
  }
  emit();
}

/** Xoá mọi token rewards của trình duyệt này, trừ ví `except` (nếu có). */
export function clearAllRewardsTokens(except?: string | null): void {
  const s = storage();
  if (s === null) return;
  const keep = except == null || except === "" ? null : keyOf(except);
  let changed = false;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(REWARDS_TOKEN_PREFIX) === true && k !== keep) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
    changed = keys.length > 0;
  } catch {
    // Bỏ qua.
  }
  if (changed) emit();
}
