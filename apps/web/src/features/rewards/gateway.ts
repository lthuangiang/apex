import { SODEX_REWARDS_DEFAULT_ORIGIN } from "@drift/shared";

// Gateway Rewards API của SoDEX (DEC-397). Biến public `NEXT_PUBLIC_SODEX_REWARDS_GATEWAY` (nhúng lúc build image web);
// trống hoặc sai thì dùng gateway mainnet mặc định. Chỉ nhận origin https; CSP `connect-src` (proxy.ts) mở đúng
// origin này.

export function rewardsGatewayOrigin(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return SODEX_REWARDS_DEFAULT_ORIGIN;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.origin : SODEX_REWARDS_DEFAULT_ORIGIN;
  } catch {
    return SODEX_REWARDS_DEFAULT_ORIGIN;
  }
}

export const REWARDS_GATEWAY_ORIGIN = rewardsGatewayOrigin(
  process.env.NEXT_PUBLIC_SODEX_REWARDS_GATEWAY,
);
