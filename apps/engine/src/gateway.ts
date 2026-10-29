import type { OrderIntent } from "@drift/strategies";

// Cổng ra SoDEX của engine. Bản thật (http-gateway.ts) ký qua signer và gửi bằng SignedWriteClient;
// test dùng bản giả. Không retry ghi (quy tắc 1.7): kết quả không rõ là `unknown`.

export interface AccountRef {
  /** id trong DB. */
  id: string;
  address: `0x${string}`;
  sodexAccountId: bigint;
  apiKeyId: string;
  apiKeyName: string;
}

/** Fencing token: signer từ chối ký nếu epoch không còn là epoch hiện tại của shard. */
export interface Fence {
  shard: number;
  epoch: number;
}

/**
 * Lỗi trước khi request rời DRIFT (signer không ký được, mạng tới signer…): SoDEX chưa nhận gì, khác `unknown`
 * (đã gửi mà không có kết quả). `key_unusable` = key DRIFT không giải mã được, cần người dùng ký lại.
 */
export type NotSentCode = "key_unusable" | "key_not_active" | "stale_epoch" | "signer_unavailable";

export type SubmitResult =
  | { clOrdID: string; outcome: "ok"; orderId: bigint }
  | { clOrdID: string; outcome: "rejected"; code: string }
  | { clOrdID: string; outcome: "not_sent"; code: NotSentCode }
  | { clOrdID: string; outcome: "unknown" };

export type LeverageResult =
  | { outcome: "ok" }
  | { outcome: "rejected"; code: string }
  | { outcome: "not_sent"; code: NotSentCode }
  | { outcome: "unknown" };

export interface LeverageSetting {
  leverage: number;
  marginMode: "cross" | "isolated";
}

export type LookupResult =
  | {
      status: "open" | "partially_filled" | "filled" | "cancelled" | "rejected";
      filledQty: string;
      avgPrice: string | null;
      orderId: bigint;
    }
  | { status: "not_found" };

export interface Gateway {
  submit(
    account: AccountRef,
    orders: readonly OrderIntent[],
    fence: Fence,
  ): Promise<SubmitResult[]>;
  cancel(
    account: AccountRef,
    orders: readonly { clOrdID: string; market: string; engine: "spot" | "perps" }[],
    fence: Fence,
  ): Promise<void>;
  lookup(
    account: AccountRef,
    order: { clOrdID: string; market: string; engine: "spot" | "perps" },
  ): Promise<LookupResult>;
  /**
   * Đặt đòn bẩy + margin mode của account cho một market Perps trên SoDEX. Phải gọi trước lệnh đầu tiên:
   * SoDEX áp thiết lập này cho mọi lệnh trên symbol, không gửi thì lệnh dùng thiết lập sẵn có của account.
   */
  setLeverage(
    account: AccountRef,
    input: { market: string; leverage: number; marginMode: "cross" | "isolated" },
    fence: Fence,
  ): Promise<LeverageResult>;
  /**
   * Thiết lập hiện tại trên SoDEX cho market (account state `S`) và thiết lập của vị thế đang mở (`P`, sz ≠ 0);
   * null khi không có. Chỉ đọc.
   */
  readLeverage(
    account: AccountRef,
    market: string,
  ): Promise<{ setting: LeverageSetting | null; position: LeverageSetting | null }>;
  /** Approval của DRIFT = 50 trên cả Spot và Perps (đọc lại từ SoDEX). */
  builderApproved(account: AccountRef): Promise<boolean>;
}
