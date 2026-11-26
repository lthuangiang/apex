// JWT đăng nhập rewards (DEC-397): chỉ ở sessionStorage của tab này, khoá theo địa chỉ ví (chữ thường). Không
// localStorage, không cookie, không gửi về server DeskLabs, không log. Xoá khi SoDEX trả 401, khi đổi ví, khi bấm
// "Sign out of rewards" và khi đăng xuất DeskLabs. sessionStorage có thể bị chặn (private window…): mọi thao tác
// bọc try/catch, lỗi thì coi như chưa đăng nhập.

export const REWARDS_TOKEN_PREFIX = "desklabs.rewards.jwt.";

const keyOf = (address: string) => `${REWARDS_TOKEN_PREFIX}${address.toLowerCase()}`;

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

/** Cho `useSyncExternalStore`. */
export function subscribeRewardsTokens(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readRewardsToken(address: string | null | undefined): string | null {
  if (address == null || address === "") return null;
  try {
    const v = storage()?.getItem(keyOf(address)) ?? null;
    return v === "" ? null : v;
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

/** Xoá mọi token rewards của tab này, trừ ví `except` (nếu có). */
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
