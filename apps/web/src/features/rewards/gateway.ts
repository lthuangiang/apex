import { SODEX_LOTTERY_DEFAULT_ORIGIN, SODEX_REWARDS_DEFAULT_ORIGIN } from "@drift/shared";

// Gateway Rewards API của SoDEX (DEC-397). Biến public `NEXT_PUBLIC_SODEX_REWARDS_GATEWAY` (nhúng lúc build image web);
// trống hoặc sai thì dùng gateway mainnet mặc định. Chỉ nhận origin https; CSP `connect-src` (proxy.ts) mở đúng
// origin này.

export function rewardsGatewayOrigin(
  raw: string | undefined,
  fallback: string = SODEX_REWARDS_DEFAULT_ORIGIN,
): string {
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.origin : fallback;
  } catch {
    return fallback;
  }
}

export const REWARDS_GATEWAY_ORIGIN = rewardsGatewayOrigin(
  process.env.NEXT_PUBLIC_SODEX_REWARDS_GATEWAY,
);

/**
 * #601 / DEC-405: host lottery cho `lottery/progress` (không có trong tài liệu). Biến public
 * `NEXT_PUBLIC_SODEX_LOTTERY_GATEWAY` (nhúng lúc build); trống hoặc sai thì dùng host mainnet. CSP mở đúng origin này.
 */
export const LOTTERY_GATEWAY_ORIGIN = rewardsGatewayOrigin(
  process.env.NEXT_PUBLIC_SODEX_LOTTERY_GATEWAY,
  SODEX_LOTTERY_DEFAULT_ORIGIN,
);
