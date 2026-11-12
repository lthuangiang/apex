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
  /**
   * Runner của bot paper (DEC-105): engine gắn cờ này ở đúng một chỗ khi nạp bot. HttpGateway từ chối mọi lời gọi có
   * cờ này; PaperGateway chỉ nhận lời gọi có cờ này.
   */
  paper?: true;
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
  /** `message`: câu lỗi SoDEX trả về (không chứa secret), null khi SoDEX không gửi. */
  | { clOrdID: string; outcome: "rejected"; code: string; message: string | null }
  | { clOrdID: string; outcome: "not_sent"; code: NotSentCode }
  | { clOrdID: string; outcome: "unknown" };

/** Kết quả dời giá kích hoạt của stop loss gốc trên SoDEX (DEC-118). */
export type ModifyStopResult =
  | { outcome: "ok" }
  | { outcome: "rejected"; code: string }
  | { outcome: "not_sent"; code: NotSentCode }
  | { outcome: "unknown" };

export type LeverageResult =
  | { outcome: "ok" }
  | { outcome: "rejected"; code: string }
  | { outcome: "not_sent"; code: NotSentCode }
  | { outcome: "unknown" };

/**
 * Kết quả huỷ từng lệnh. `ok`: SoDEX xác nhận đã gỡ khỏi sổ, lệnh không khớp thêm được nữa. `rejected`: SoDEX
 * từ chối (thường vì lệnh đã khớp hết / đã huỷ). `unknown`: không rõ, chờ fill hoặc đối soát.
 */
export type CancelResult =
  | { clOrdID: string; outcome: "ok" }
  | { clOrdID: string; outcome: "rejected"; code: string }
  | { clOrdID: string; outcome: "unknown"; detail?: string };

export interface LeverageSetting {
  leverage: number;
  marginMode: "cross" | "isolated";
}

export interface OrderTrade {
  tradeId: bigint;
  price: string;
  quantity: string;
  fee: string;
  builderFee: string | null;
  isMaker: boolean;
  at: number;
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
    /** Builder fee của chiến lược (phần mười bp, DEC-94); thiếu thì dùng mức mặc định 0.01%. */
    builderFeeRate?: number,
  ): Promise<SubmitResult[]>;
  cancel(
    account: AccountRef,
    orders: readonly { clOrdID: string; market: string; engine: "spot" | "perps" }[],
    fence: Fence,
  ): Promise<CancelResult[]>;
  /** Dời giá kích hoạt của một stop loss gốc trên SoDEX (`modifyOrder`, chỉ Perps, DEC-118). */
  modifyStop(
    account: AccountRef,
    order: { clOrdID: string; market: string; stopPrice: string },
    fence: Fence,
  ): Promise<ModifyStopResult>;
  lookup(
    account: AccountRef,
    order: { clOrdID: string; market: string; engine: "spot" | "perps" },
  ): Promise<LookupResult>;
  /** Các lần khớp của một lệnh theo SoDEX: dùng khi user stream không còn mở lúc lệnh khớp (DEC-85). */
  tradesOf(
    account: AccountRef,
    order: { clOrdID: string; market: string; engine: "spot" | "perps" },
  ): Promise<OrderTrade[]>;
  /**
   * Các lần khớp gần đây của account trên một market (mọi lệnh, kèm clOrdID): Market Making đối soát lệnh đã
   * huỷ / thay mà tin khớp chưa tới (DEC-100). Một REST call.
   */
  recentTrades(
    account: AccountRef,
    q: { market: string; engine: "spot" | "perps" },
  ): Promise<(OrderTrade & { clOrdID: string })[]>;
  /** Vị thế Perps đang mở trên SoDEX: `size` có dấu (âm = short); null khi không có. Chỉ đọc. */
  readPosition(
    account: AccountRef,
    market: string,
  ): Promise<{ size: string; entryPrice: string } | null>;
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
