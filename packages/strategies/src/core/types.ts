import type { ReasonCode } from "@drift/shared";

import type { WaitingInfo } from "../common/entry";

// Hợp đồng chung của mọi chiến lược (STRATEGIES.md "Quy ước chung"): hàm thuần
// `step(config, state, event, ctx) → { actions, state }`. Không I/O; tiền và giá là chuỗi thập phân.

export type Side = "buy" | "sell";
export type EngineKind = "spot" | "perps";

/** Quy tắc market đọc từ market info SoDEX (không hard-code). */
export interface MarketRules {
  tickSize: string;
  stepSize: string;
  minQuantity: string;
  minNotional: string;
  /** Phí maker / taker SoDEX của market (tỷ lệ thô) từ `/symbols`; không có thì dùng mức cơ bản (DEC-112). */
  makerFee?: string;
  takerFee?: string;
}

export interface OrderIntent {
  clOrdID: string;
  market: string;
  engine: EngineKind;
  side: Side;
  type: "limit" | "market";
  /** Bắt buộc với limit. */
  price?: string;
  quantity: string;
  timeInForce: "GTC" | "IOC" | "GTX";
  reduceOnly: boolean;
  /** Nhãn để chiến lược nhận ra lệnh khi khớp (ví dụ "grid:3:buy"). */
  tag: string;
  /**
   * Stop loss gốc của SoDEX trên vị thế (DEC-118, chỉ Perps): `type` market + IOC + reduce-only, kích hoạt theo
   * mark price ở `price`, đóng toàn bộ vị thế lúc kích hoạt (gửi không kèm quantity; `quantity` chỉ để ghi sổ).
   */
  stop?: { price: string };
}

export type StrategyEvent =
  | { type: "tick"; at: number; market: string; price: string }
  | { type: "fill"; at: number; clOrdID: string; price: string; quantity: string; fee: string }
  | { type: "orderAck"; at: number; clOrdID: string }
  | { type: "orderReject"; at: number; clOrdID: string; code: string }
  /**
   * Nhịp đồng hồ. Volume Farm nhận kèm dữ liệu thị trường (engine đọc `candles_1m` và orderbook REST, tối đa
   * mỗi 3 s): các chiến lược khác bỏ qua `market`.
   */
  | {
      type: "timer";
      at: number;
      market?: MarketSnapshot;
      /** Đỉnh sổ lệnh của mọi market chiến lược dùng (Rebalancing đặt IOC theo ask / bid); null khi đọc lỗi. */
      books?: Readonly<Record<string, BookTop | null>>;
    }
  | { type: "fundingPaid"; at: number; market: string; amount: string }
  /** Funding của market (engine lấy từ market_stats / marketdata). */
  | { type: "fundingRate"; at: number; market: string; current: string; avg7d: string | null }
  /** Margin ratio của account Perps (tỷ lệ thô). */
  | { type: "marginRatio"; at: number; ratio: string }
  /** Lệnh đã xong trên SoDEX (huỷ thành công hoặc hết hạn): không còn khớp thêm được. */
  | { type: "orderDone"; at: number; clOrdID: string }
  /**
   * Người dùng Resume sau khi bot bị pause (engine gửi khi xác nhận running, DEC-240). Chiến lược tự pause
   * (`halted`) thì chạy tiếp với sổ cái và vị thế giữ nguyên, dựng lại lệnh từ vị thế thật. Lúc pause engine không gửi
   * giá, nên `prices` mang giá mới nhất engine biết của từng market của bot (thiếu market nào là chưa có giá).
   */
  | { type: "resumed"; at: number; prices: Record<string, string> }
  /** Vị thế thật trên SoDEX (Volume Maker đối soát với ledger, DEC-100). `size` có dấu: âm là short. */
  | { type: "positionSync"; at: number; market: string; size: string; entryPrice: string }
  /**
   * Binance guard (Market Making): giá Binance đã lệch khỏi giá SoDEX nên báo giá phía đó đang cũ. `ask`: Binance cao
   * hơn (ask dễ bị khớp trước khi giá SoDEX tăng); `bid`: ngược lại. Engine gửi khi trạng thái đổi. `gapBp`: độ lệch đã
   * trừ chênh lệch nền; `binanceAt`: giờ Binance của lần cập nhật gây ra tín hiệu.
   */
  | {
      type: "guard";
      at: number;
      market: string;
      ask: boolean;
      bid: boolean;
      gapBp: number;
      binanceAt: number;
    }
  /**
   * Fill của ví leader (Copy Trade, DEC-161). `at` = lúc engine nhận, `leaderAt` = lúc leader khớp; `quantity` luôn
   * dương. `positionAfter` có dấu (âm là short): vị thế của leader trên market sau fill này, tính theo market SoDEX.
   */
  | {
      type: "leaderFill";
      at: number;
      leaderAt: number;
      market: string;
      side: Side;
      price: string;
      quantity: string;
      positionAfter: string;
      /**
       * Hạn mức notional (USD) bot được dùng để mở / tăng theo tín hiệu này, do marketdata phân bổ cho mọi bot copy
       * cùng leader × market (DEC-163 mục 9: ≤ 50% độ sâu sổ SoDEX). Không có = không giới hạn thêm.
       */
      allowance?: string;
      /** Vì sao hạn mức nhỏ hơn yêu cầu: thiếu thanh khoản, hoặc trader không còn đạt minHoldFilter (mục 5). */
      allowanceReason?: "liquidity" | "min_hold";
    }
  /** Vị thế của leader đọc lại định kỳ qua REST, để bù fill bị lỡ khi stream rớt. `size` có dấu. */
  | { type: "leaderPosition"; at: number; market: string; size: string };

/** Nến 1 phút đã đóng (cũ → mới), số thập phân dạng chuỗi như mọi giá khác. */
export interface MinuteCandle {
  /** Thời điểm mở nến (ms). */
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

/** Đỉnh sổ lệnh: giá tốt nhất và tổng notional của N mức mỗi phía. */
export interface BookTop {
  bid: string;
  ask: string;
  bidNotional: string;
  askNotional: string;
}

export interface MarketSnapshot {
  market: string;
  candles: readonly MinuteCandle[];
  book: BookTop | null;
}

export type StrategyAction =
  | { type: "place"; order: OrderIntent }
  | { type: "cancel"; clOrdID: string }
  /** Dời giá kích hoạt của stop loss gốc trên SoDEX (DEC-118); SoDEX từ chối thì engine báo `orderReject` cho lệnh đó. */
  | { type: "modifyStop"; clOrdID: string; stopPrice: string }
  | { type: "pause"; reason: ReasonCode }
  | { type: "stop"; reason: ReasonCode; close: boolean }
  | { type: "flag"; needsAttention: boolean }
  /** Một dòng "Decisions & actions" (bot_events). */
  | { type: "log"; decision: string; why: string };

export interface StepContext {
  botId: string;
  version: number;
  rules: Record<string, MarketRules>;
  /**
   * Phí một chiều trung bình (tỷ lệ thô, ví dụ "0.00017") = nửa phí khứ hồi maker của bot: SoDEX maker của market +
   * builder fee của chiến lược (Spot chỉ chiều bán; account builder bằng 0). Xem `oneWayFeeFraction` (DEC-112).
   */
  feeRate: string;
  /**
   * Như `feeRate` nhưng cho lệnh taker: SoDEX taker của market + builder fee (DEC-117). Thiếu thì chiến lược dùng
   * `feeRate`, tức tính như lệnh maker.
   */
  takerFeeRate?: string;
}

export interface StepResult<S> {
  actions: StrategyAction[];
  state: S;
}

export type StepFn<C, S> = (
  config: C,
  state: S,
  event: StrategyEvent,
  ctx: StepContext,
) => StepResult<S>;

export interface StrategyModule<C, S> {
  initialState: (config: C) => S;
  step: StepFn<C, S>;
  /** Bot đang chờ điều kiện vào ("Waiting for price", DEC-91); null là không chờ. Hàm thuần, chỉ để hiển thị. */
  waiting?: (config: C, state: S) => WaitingInfo | null;
}
