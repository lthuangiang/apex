import { hyperliquidCoinOf, hyperliquidMapKey, hyperliquidMapSchema } from "@drift/shared";

import type { LiquidationProvider } from "./service";

// Đọc bản đồ thanh lý do `marketdata` tính từ dữ liệu công khai của Hyperliquid (DEC-92). Api không gọi
// Hyperliquid: một leader quét để giữ đúng hạn mức theo IP.
export function hyperliquidProvider(redis: {
  get(key: string): Promise<string | null>;
}): LiquidationProvider {
  return {
    name: "Hyperliquid positions",
    async get(market) {
      const raw = await redis.get(hyperliquidMapKey(hyperliquidCoinOf(market)));
      return raw === null ? null : hyperliquidMapSchema.parse(JSON.parse(raw));
    },
  };
}
