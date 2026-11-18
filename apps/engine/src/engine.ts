import {
  apiKeys,
  botEvents,
  botRuntime,
  bots,
  botVersions,
  candles1m,
  equitySnapshots,
  fills,
  fundingRates,
  orders,
  outbox,
  riskLimits,
  shardEpochs,
  sodexAccounts,
  builderFeeOverridesOf,
  users,
  type Db,
} from "@drift/db";
import { Lease, LeaseSet, type LeaseLoss, type LeaseRedis } from "@drift/runtime";
import {
  applyEngineEvent,
  applyReason,
  assetOf,
  BotState,
  builderFeeRateFor,
  builderFeeRateOf,
  type BuilderFeeOverrides,
  isBuilderAccount,
  oneWayFeeFraction,
  oneWayTakerFeeFraction,
  dec,
  type Decimal,
  ENGINE_ACTIVE_STATES,
  EngineEvent,
  EXPERIMENTAL_STRATEGIES,
  type LeaderFillMessage,
  type LeaderPositionMessage,
  leverageSpecOf,
  type MmBookMessage,
  type MmFairMessage,
  leverageSpecsOf,
  type LeverageSpec,
  NORMAL_REJECT_CODES,
  REASON_CODE_META,
  ReasonCode,
  type ReasonCode as Reason,
  Strategy,
  sub,
  VOLUME_STRATEGIES,
  exceedsPerTrade,
  PLANNED_STOP_REASONS,
  STOPPED_BY_USER,
} from "@drift/shared";
import {
  mmOrderContextSchema,
  mmQuoteSnapshotSchema,
  type MmQuoteSnapshot,
} from "@drift/shared/mm-quote";
import { vbSignalSnapshotSchema, type VbSignalSnapshot } from "@drift/shared/vb-signal";
import { isInsufficientMarginReject } from "@drift/sodex";
import {
  applyFill,
  botCapitalOf,
  clOrdId,
  copyMarkets,
  copyPositions,
  fnv1a64,
  isMultiMarketCopyState,
  normalizeCopyState,
  STRATEGIES,
  type CopyTradeConfig,
  type DecisionPayload,
  type Ledger,
  type BookTop,
  type MarketRules,
  type MarketSnapshot,
  type StepContext,
  type StrategyAction,
  type StrategyEvent,
  type StrategyModule,
  type OrderIntent,
} from "@drift/strategies";
import { and, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Logger } from "pino";

import { withBotCallContext } from "./call-context";
import { openedAlerts, SkipGate, skipMarket, skippedAlert, skipReason } from "./copy-alerts";
import {
  MARKET_NOT_FOUND,
  type AccountRef,
  type CancelResult,
  type Gateway,
  type LookupResult,
  type NotSentCode,
  type OrderTrade,
} from "./gateway";
import type { PaperGateway } from "./paper-gateway";

// Engine (ARCHITECTURE.md mục 3.3–3.4, DEC-37). Mỗi account thuộc một shard ảo (64); mỗi shard có đúng
// một worker giữ lease Redis. Khi nhận shard, `epoch` của shard trong Postgres tăng 1; mọi lần ghi lệnh /
// state đều kiểm tra epoch trong cùng transaction (fencing), nên worker "zombie" không ghi được.
// Lệnh được ghi trước (status unknown) rồi mới gửi; clOrdID tất định + unique (account, clOrdID) nên chạy lại
// sau khi chuyển shard không tạo lệnh trùng.

export const ENGINE_SHARDS = 64;
/** Lệnh `unknown` lâu hơn mức này thì đối soát với SoDEX. */
export const RECONCILE_AFTER_MS = 5_000;
/** Không tìm thấy trên SoDEX sau mức này thì coi là chưa đặt (not_placed). */
export const NOT_FOUND_AFTER_MS = 30_000;
/** Mỗi lệnh `open` không còn ai theo dõi được đối chiếu với SoDEX tối đa một lần trong khoảng này. */
export const OPEN_CHECK_MS = 15_000;
/** Số lệnh đối chiếu tối đa mỗi vòng của một shard, để không tiêu hết hạn mức REST. */
const OPEN_CHECK_BATCH = 10;
/** Sau khi user stream đứt, đối soát lệnh Volume Farm trong khoảng này (đủ cho lệnh đang chờ khớp lúc đứt). */
export const STREAM_GAP_MS = 120_000;
/**
 * Lưới an toàn fill (DEC-303): lệnh kết thúc mà user stream chưa xác nhận (`unknown`, hoặc bot đã huỷ
 * mà chưa có tin CANCELED) và gửi trong khoảng này được so với lịch sử khớp của SoDEX, mỗi account + market tối đa
 * một lần mỗi `MAKER_BACKFILL_MS`.
 */
export const FILL_BACKFILL_WINDOW_MS = 120_000;
/**
 * Lệnh SoDEX đã nhận (có `sodexOrderId`) mà không tìm thấy, cũng không có trade: giữ `unknown` (quy tắc 1.7) và đối soát
 * lại mỗi `OPEN_CHECK_MS` trong khoảng này; quá thì ghi Needs attention + Decisions một lần và Stop không chờ nó nữa.
 */
export const UNKNOWN_CHECK_WINDOW_MS = 600_000;
/** Lệnh `unknown` SoDEX đã nhận: khoảng tra lại giãn dần từ OPEN_CHECK_MS, tối đa mức này. */
const UNKNOWN_RECHECK_MAX_MS = 60_000;
/**
 * Lưới an toàn fill chỉ coi trade là bị mất khi nó cũ hơn mức này: tin user stream của trade mới hơn có thể vẫn đang tới,
 * không được giành phần của stream (M5).
 */
export const BACKFILL_TRADE_GRACE_MS = 15_000;
/** Bot chờ user stream lâu hơn mức này thì log warn thay vì info. */
const STREAM_WAIT_WARN_MS = 120_000;
/**
 * Stop loss gốc trên SoDEX (DEC-118). Bảng `orders` không có cột riêng cho stop; chỉ Volume Farm đặt loại lệnh này và
 * luôn gắn tag `vf:<lượt>:sl` (market, IOC, reduce-only).
 */
export function isNativeStop(o: { type: string; tag: string; reduceOnly: boolean }): boolean {
  return o.type === "market" && o.reduceOnly && o.tag.endsWith(":sl");
}
/** Tiêu đề Decisions của lệnh `unknown` (chỉ để hiển thị; trạng thái bền nằm ở cột của `orders`). */
const UNKNOWN_DECISION = "Order result unknown";

/**
 * Lệnh làm tăng |vị thế| của bot (người dùng chốt, DEC-303): chỉ loại này phải chờ user stream.
 * - Perps reduce-only và Spot bán (Spot không mở được vị thế bán) không bao giờ là mở.
 * - Lệnh ngược chiều vị thế hiện tại là giảm, nếu cộng với các lệnh giảm đang chờ (`reducing`, lệnh đang mở trên sổ và
 *   lệnh trước nó trong cùng bước) vẫn không vượt |vị thế| (ví dụ lệnh bán của grid long, dù không reduce-only).
 * - Không biết vị thế (`null`): coi lệnh không reduce-only là mở.
 */
export function opensPosition(
  o: Pick<OrderIntent, "engine" | "side" | "reduceOnly" | "quantity">,
  position: string | null,
  reducing = "0",
): boolean {
  if (o.engine === "perps" && o.reduceOnly) return false;
  if (o.engine === "spot" && o.side === "sell") return false;
  if (position === null) return true;
  const pos = dec(position);
  const opposite = (o.side === "sell" && pos.gt(0)) || (o.side === "buy" && pos.lt(0));
  if (!opposite) return true;
  return dec(reducing).add(o.quantity).gt(pos.abs());
}

/** Vị thế (có dấu) của bot trên market / engine theo sổ cái trong state; null khi state không có sổ cái nhận ra được. */
function positionOf(state: unknown, market: string, engine: "spot" | "perps"): string | null {
  if (typeof state !== "object" || state === null) return null;
  if (isMultiMarketCopyState(state)) return state.markets[market]?.ledger.position ?? null;
  const s = state as { ledger?: Ledger; perp?: Ledger; spot?: Ledger };
  return (s.ledger ?? (engine === "perps" ? s.perp : s.spot))?.position ?? null;
}
/**
 * Chiến lược vẫn theo dõi lệnh sau khi lệnh kết thúc và nhận fill tới muộn (Volume Farm, DEC-87). Fill tìm thấy sau
 * khi đã báo `orderDone` chỉ được đưa cho các chiến lược này; chiến lược khác bị gắn Needs attention.
 */
const LATE_FILL_STRATEGIES: ReadonlySet<string> = new Set([Strategy.volumeFarm]);

/**
 * Kết quả của một lệnh suy từ các trade SoDEX của nó (lệnh không còn trong lệnh mở / lịch sử). `done`: được kết luận lệnh
 * đã xong chỉ khi khớp đủ, hoặc lệnh là market / IOC (không bao giờ nằm trên sổ). Lệnh limit khớp một phần có thể vẫn
 * nằm trên sổ: chỉ ghi fill, không kết thúc (quy tắc 1.7). Không có trade → null.
 */
function foundFromTrades(
  o: { size: string; type: string; timeInForce: string },
  trades: readonly OrderTrade[],
  orderId: bigint,
): { found: Extract<LookupResult, { filledQty: string }>; done: boolean } | null {
  const total = trades.reduce((a, t) => a.add(t.quantity), dec("0"));
  if (!total.gt(0)) return null;
  const value = trades.reduce((a, t) => a.add(dec(t.price).mul(t.quantity)), dec("0"));
  const full = total.gte(o.size);
  return {
    found: {
      status: full ? "filled" : "cancelled",
      filledQty: total.toString(),
      avgPrice: value.div(total).toString(),
      orderId,
    },
    done: full || o.type === "market" || o.timeInForce === "IOC",
  };
}

/**
 * Phí của phần khớp chưa được tính (`counted` đầu tiên theo thứ tự trade id đã tính rồi): cộng phí các trade sau phần đó,
 * trade nằm giữa tính theo tỷ lệ khối lượng. Không cộng lại phí của phần đã ghi.
 */
function feeBeyond(trades: readonly OrderTrade[], counted: string): Decimal {
  let left = dec(counted);
  let fee = dec("0");
  for (const t of [...trades].sort((a, b) => (a.tradeId < b.tradeId ? -1 : 1))) {
    const q = dec(t.quantity);
    if (left.gte(q)) {
      left = left.sub(q);
      continue;
    }
    fee = fee.add(left.gt(0) ? dec(t.fee).mul(q.sub(left)).div(q) : dec(t.fee));
    left = dec("0");
  }
  return fee;
}

/** Lệnh đã huỷ trong khoảng này mới cần xác nhận: lệnh Volume Farm chỉ sống vài chục giây. */
const UNCONFIRMED_CANCEL_MS = 600_000;
/**
 * Market Making (DEC-100): mỗi account + market đọc lịch sử khớp của SoDEX một lần mỗi chừng này ms, để bắt fill
 * của lệnh đã huỷ / thay mà tin khớp chưa tới (một REST call).
 */
export const MAKER_BACKFILL_MS = 10_000;
/** Chỉ đối soát lệnh gửi trong khoảng này (khớp `VM_KEEP_DONE_MS` của chiến lược). */
const MAKER_BACKFILL_WINDOW_MS = 600_000;
/**
 * Kiểm tra vị thế thật với sổ cái (DEC-306): mỗi account có bot thật trên Perps đọc account state
 * SoDEX MỘT lần mỗi chừng này ms (dùng chung cho Market Making, DEC-100: vị thế thật đưa vào chiến lược bằng
 * `positionSync`).
 */
export const POSITION_CHECK_MS = 30_000;
/** Bậc 1: cùng một độ lệch (vị thế thật và sổ cái không đổi) qua các lần kiểm tra liên tiếp kéo dài chừng này ms. */
export const POSITION_CONFIRM_MS = 60_000;
/** Bỏ cảnh báo lệch vị thế sau chừng này lần kiểm tra khớp liên tiếp. */
export const POSITION_CLEAR_CHECKS = 2;
/** Bậc 1 đọc lịch sử khớp cho tối đa chừng này lệnh gần nhất của bot trên market (chưa khớp đủ). */
const POSITION_BACKFILL_ORDERS = 200;
/** Áp version mới trong chừng này ms gần đây (sổ cái bắt đầu lại): lệch vị thế được ghi với nguyên nhân "version". */
export const POSITION_VERSION_WINDOW_MS = 600_000;
export const POSITION_MISMATCH_DECISION = "Position doesn't match";
export const POSITION_UNTRACKED_DECISION = "Position not tracked";
export const POSITION_MATCH_DECISION = "Position matches again";
export const positionMismatchWhy = (market: string, real: string, ledger: string): string =>
  `Your ${market} position on SoDEX is ${dec(real).toString()}; the bot tracked ${dec(ledger).toString()}. The bot won't start new trades that add to it until this is fixed. Check Positions on SoDEX.`;
export const positionUntrackedWhy = (market: string, real: string): string =>
  `Settings changed while your ${market} position (${dec(real).toString()}) was open, so the bot no longer tracks it. The bot won't start new trades that add to it, and a grid may wait to start until it's closed. Close or manage the position on SoDEX.`;
export const positionMatchWhy = (market: string, real: string): string =>
  `Your ${market} position on SoDEX (${dec(real).toString()}) matches the bot again. The bot trades normally.`;

/**
 * Vị thế thật hiệu dụng cho phần chặn (M2): vị thế thật lúc đọc + phần sổ cái đã đổi từ lúc đọc (fill ghi sau lần đọc).
 * Không có sổ cái thì dùng số đọc được.
 */
export function effectiveReal(
  realAtRead: string,
  ledgerAtRead: string,
  ledgerNow: string | null,
): string {
  return ledgerNow === null
    ? dec(realAtRead).toString()
    : dec(realAtRead).add(dec(ledgerNow).sub(ledgerAtRead)).toString();
}

/** Nguyên nhân lệch: trade bị mất (sau khi đã đọc lịch sử khớp) hoặc sổ cái bắt đầu lại khi áp version mới. */
type MismatchCause = "trades" | "version";
interface MismatchEntry {
  /** Vị thế thật và sổ cái ở lần đọc gần nhất (bền: lúc cảnh báo). */
  real: string;
  ledger: string;
  since: string;
  cause?: MismatchCause;
}

/** Một độ lệch vị thế đang theo dõi (trong bộ nhớ), theo `bot:market`. */
interface PositionWatch {
  /** Hiệu số thật − sổ cái (M5). */
  delta: string;
  /** Lần đầu thấy hiệu số này. */
  firstSeen: number;
  /** Đã đọc lịch sử khớp cho hiệu số này (bậc 1). */
  backfilledAt: number | null;
  /** Số lần khớp liên tiếp khi đã cảnh báo (bậc 2). */
  matches: number;
}
/**
 * Huỷ chưa xong (request không rời DRIFT vì signer lỗi, hoặc SoDEX không trả kết quả rõ): thử lại sau mỗi chừng này
 * ms cho tới khi SoDEX xác nhận. Không thử lại thì lệnh còn sống trên sổ và còn "open" trong DRIFT, chặn mọi lệnh
 * ngược chiều bằng kiểm tra self-trade (sự cố 2026-11-04, DEC-111).
 */
export const CANCEL_RETRY_MS = 5_000;
/**
 * SoDEX trả `OrderNotFound` cho lệnh huỷ gửi ngay sau khi lệnh đặt được nhận (DEC-250): lệnh chưa vào sổ, lát sau mới
 * vào và nằm đó như lệnh mồ côi. Lệnh nhận chưa quá `windowMs` thì huỷ lại sau `retryMs` thay vì `CANCEL_RETRY_MS`.
 */
export const CANCEL_NOT_BOOKED = { windowMs: 5_000, retryMs: 1_000 } as const;
/**
 * Lệnh huỷ tới khi lệnh đặt còn đang gửi (DEC-254): dòng lệnh chưa có hoặc còn `unknown` chưa được nhận. Giữ trong danh
 * sách chờ huỷ và huỷ ngay khi lệnh đặt được nhận (thử lại sau `CANCEL_NOT_BOOKED.retryMs` nếu không); dòng mãi không
 * xuất hiện thì bỏ sau `maxMs`. Trước đây lệnh huỷ bị bỏ, lệnh vào sổ và nằm tới lúc quét lệnh mồ côi (~25 s).
 */
export const CANCEL_INFLIGHT = { maxMs: 10_000 } as const;
/** Market Making: lệnh còn "open" lâu hơn mức này mà chiến lược không còn theo dõi thì engine huỷ (DEC-111). */
export const MAKER_ORPHAN_MS = 15_000;
/** Bot paper: ghi số dư giả mỗi phút (biểu đồ theo ngày ở trang Fake-money test, DEC-105). */
export const PAPER_SNAPSHOT_MS = 60_000;

export class FencedError extends Error {
  constructor(readonly shard: number) {
    super(`Shard ${String(shard)} is owned by another worker`);
  }
}

type OrderRow = typeof orders.$inferSelect;
type BotRow = typeof bots.$inferSelect;
type VersionRow = typeof botVersions.$inferSelect;

/**
 * Dữ liệu đọc MỘT lần mỗi vòng `tick` rồi chia theo shard trong bộ nhớ (DEC-301). Trước đây mỗi shard
 * tự đọc lại (account 2 lần, lệnh `unknown`, lệnh đang mở, version chờ theo từng bot), nên số truy vấn mỗi vòng tăng theo
 * số shard (64) và vòng chậm tới mức mất lease.
 */
interface TickSnapshot {
  /** Account đã kết nối + key active, theo shard (chỉ shard mình giữ). */
  accounts: Map<number, AccountRef[]>;
  /** Bot đang ở trạng thái engine chạy + version active, theo shard. */
  bots: Map<number, { bot: BotRow; version: VersionRow }[]>;
  /** Version `pending` mới nhất của mỗi bot trong `bots`. */
  pending: Map<string, VersionRow>;
  /** Builder fee riêng theo user của các bot trong `bots`. */
  fees: Map<string, BuilderFeeOverrides>;
  /** Lệnh `unknown` đủ tuổi để đối soát (mọi account). */
  unknown: OrderRow[];
  /** Lệnh bot thật `open` / `partially_filled` đủ tuổi, theo shard của account, theo `submittedAt`. */
  open: Map<number, OrderRow[]>;
  /** Lệnh Volume Farm đã huỷ chưa đối soát, theo shard của account. */
  unconfirmed: Map<number, OrderRow[]>;
  /** Ứng viên của lưới an toàn fill (#backfillFills), theo shard của account (DEC-303). */
  backfill: Map<number, OrderRow[]>;
  /**
   * Lệnh được tra ở vòng này (id), chọn cho cả worker trong ngân sách LOOKUP_BUDGET: lệnh nghi ngờ trước, luân phiên giữa
   * các account (DEC-310). Lệnh không có ở đây chờ vòng sau. null = không giới hạn (tra mọi lệnh tới hạn).
   */
  lookups: Set<string> | null;
}

const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
};

/**
 * Số shard chạy cùng lúc (DEC-308). Mỗi shard vẫn chạy các bước của mình tuần tự; một shard chờ
 * SoDEX chậm không làm các shard khác chờ theo. Giới hạn để không dồn quá nhiều kết nối DB / lời gọi SoDEX một lúc.
 */
export const SHARD_CONCURRENCY = 4;
/**
 * Số account cùng lúc trong một bước đọc SoDEX của một shard (đối soát, lịch sử khớp, vị thế). Trong một account các
 * lời gọi vẫn tuần tự, nên số lời gọi mỗi phút (bucket IP 1200 weight / phút) không đổi, chỉ không còn cộng dồn độ trễ.
 */
export const ACCOUNT_CONCURRENCY = 4;
/**
 * User stream của account còn mở chừng này sau khi runner cuối của account bị bỏ (Stop xong), để tin khớp của lệnh đóng
 * (market IOC) gửi ngay trước đó vẫn tới qua stream (DEC-308). Sau đó stream còn mở khi account còn
 * lệnh bot thật đang mở / `unknown` (snapshot của vòng).
 */
export const STREAM_HOLD_MS = 60_000;
/**
 * Ngân sách tra lệnh của cả worker (DEC-310): tối đa chừng này weight REST mỗi 60 s cho bước tra lệnh
 * (`#reconcile` + `#reconcileOpen`), = 50% bucket IP 1200 weight / phút của SoDEX. Một lần tra tính `LOOKUP_WEIGHT`
 * (lệnh đang mở 5 + lịch sử lệnh 20; lịch sử khớp dùng chung trong vòng nên không tính riêng).
 */
export const LOOKUP_BUDGET = { weight: 600, windowMs: 60_000 } as const;
export const LOOKUP_WEIGHT = 25;
/**
 * Một lần đọc lịch sử khớp (`getTrades`, weight 20). Mọi lần đọc thật (không trúng cache của vòng) đều được ghi vào cùng
 * cửa sổ ngân sách; kế hoạch tra tính mỗi lần tra tối đa LOOKUP_WEIGHT + TRADES_WEIGHT (lệnh không thấy thì đọc trade).
 */
export const TRADES_WEIGHT = 20;
/**
 * Huỷ bị SoDEX từ chối cả request lặp lại (key bị thu hồi, 400 nonce / chữ ký, 429): huỷ lại của account đó chờ 5 s →
 * 15 s → 60 s (giữ 60 s), warn một lần mỗi nấc (DEC-310). Có kết quả theo từng lệnh thì về 0.
 */
export const CANCEL_REQUEST_BACKOFF_MS = [5_000, 15_000, 60_000] as const;
/** `stop()` chờ shard đang chạy dở tối đa chừng này trước khi trả lease (stop_grace_period 30 s). */
const STOP_WAIT_MS = 20_000;

/** Chạy `work` cho từng phần tử, tối đa `limit` cùng lúc. Lỗi đầu tiên được ném lại sau khi mọi phần tử đang chạy xong. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async (): Promise<void> => {
    // Lỗi fencing: shard không còn của mình, mọi lần ghi sau đều bị từ chối, không lấy thêm việc.
    while (next < items.length && !errors.some((e) => e instanceof FencedError)) {
      const item = items[next] as T;
      next += 1;
      try {
        await work(item);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  const fenced = errors.find((e) => e instanceof FencedError);
  if (fenced !== undefined) throw fenced;
  if (errors.length > 0) throw errors[0];
}

/** Giới hạn số việc chạy cùng lúc (hàng đợi FIFO). */
class Limiter {
  #free: number;
  readonly #queue: (() => void)[] = [];
  constructor(size: number) {
    this.#free = size;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1;
    else
      await new Promise<void>((resolve) => {
        this.#queue.push(resolve);
      });
    try {
      return await work();
    } finally {
      const waiting = this.#queue.shift();
      if (waiting === undefined) this.#free += 1;
      else waiting();
    }
  }
}

/** Chờ mọi promise, tối đa `ms` (không hữu hạn = chờ hết). */
async function settleWithin(list: readonly Promise<unknown>[], ms: number): Promise<void> {
  if (list.length === 0) return;
  const all = Promise.allSettled(list);
  if (!Number.isFinite(ms)) {
    await all;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Lease của shard đã quá `validUntil` và gia hạn ngay không được (DEC-302): không gửi gì tới SoDEX.
 * Là một `FencedError` để mọi chỗ đang cho FencedError đi qua cũng cho lỗi này đi qua; vòng `tick` bỏ qua shard ở lượt
 * này chứ không bỏ shard (shard mất thật thì `LeaseSet` đã báo `onLost`).
 */
export class LeaseExpiredError extends FencedError {
  constructor(shard: number) {
    super(shard);
    this.message = `Shard ${String(shard)} lease is not confirmed`;
  }
}

/** Các bước của một shard trong một vòng `tick`, theo thứ tự (tên dùng trong log `tick slow`). */
const SHARD_PHASES = [
  "syncBots",
  "reconcile",
  "reconcileOpen",
  "retryCancels",
  "reconcileMaker",
  "backfillFills",
  "checkPositions",
  "checkFees",
  "clock",
] as const;
type ShardPhase = (typeof SHARD_PHASES)[number];

export interface EngineRedis extends LeaseRedis {
  set(key: string, value: string, px: "PX", ttl: number, nx?: "NX"): Promise<string | null>;
  keys(pattern: string): Promise<string[]>;
  del(key: string): Promise<number>;
}

export interface EngineDeps {
  db: Db;
  redis: EngineRedis;
  gateway: Gateway;
  workerId: string;
  log: Pick<Logger, "info" | "warn" | "error">;
  now?: () => number;
  leaseTtlMs?: number;
  shards?: number;
  rules: (market: string) => Promise<MarketRules | undefined>;
  /** Ghi đè phí một chiều cho mọi bot (chỉ dùng trong test); bình thường mỗi bot tự tính (DEC-112). */
  feeRate?: string;
  /** Account SoDEX của builder (DEC-47): bot của account này không chịu builder fee khi tính TP / hoà vốn. */
  builderId?: bigint;
  /** Account builder được miễn builder fee (DEC-47); false = tính builder fee như mọi account (DEC-124). */
  builderExempt?: boolean;
  /** Chu kỳ kiểm tra approval phí của mỗi account. */
  feeCheckMs?: number;
  /**
   * Đỉnh sổ lệnh (REST orderbook) cho Volume Farm / Market Making (Perps) và Rebalancing (Spot); null khi không đọc
   * được. Không truyền thì Volume Farm chỉ dùng nến (tín hiệu chạy chế độ chỉ-nến như apex).
   */
  orderbook?: (market: string, engine?: "spot" | "perps") => Promise<BookTop | null>;
  /** Cổng mô phỏng cho bot paper (DEC-105). Không truyền thì engine không nạp bot paper nào. */
  paper?: PaperGateway;
  /** Đồng hồ đơn điệu cho hạn lease (mặc định `performance.now`); khác `now` (giờ nghiệp vụ, test cố định). */
  monotonic?: () => number;
  /** Độ trễ event loop hiện tại (perf_hooks), ghi kèm log `tick slow`. */
  loopDelay?: () => { p99Ms: number; maxMs: number };
  /**
   * `tick()` chờ các shard tối đa chừng này (DEC-308). Shard chậm hơn (SoDEX chậm) chạy tiếp ngoài
   * vòng; vòng sau bỏ qua shard đó tới khi nó xong, các shard khác vẫn chạy đủ bước. Mặc định: chờ hết (như trước).
   */
  tickWaitMs?: number;
  /**
   * Weight REST tối đa của bước tra lệnh cho cả worker trong LOOKUP_BUDGET.windowMs (DEC-310).
   * `main.ts` đặt 600 (50% bucket IP); mặc định không giới hạn, chỉ còn thứ tự tra (nghi ngờ trước, luân phiên account).
   */
  lookupBudget?: number;
  /**
   * User stream SoDEX của các account (main.ts). Engine mở stream cho account ngay khi nạp bot thật. Lệnh mở / tăng vị
   * thế chỉ được gửi khi stream của engine (Spot / Perps) của lệnh đã được SoDEX nhận subscribe: SoDEX không gửi lại tin
   * khớp đã qua. Lệnh giảm vị thế, stop loss, lệnh đóng và Stop của người dùng luôn đi. Không truyền (test) thì coi như
   * luôn sẵn sàng.
   */
  userStreams?: UserStreams;
}

export interface UserStreams {
  /** Mở user stream của account trên engine này nếu chưa mở; không chờ. */
  open(account: AccountRef, engine: "spot" | "perps"): void;
  /** Stream của account trên engine này đã được SoDEX nhận subscribe (cả hai kênh) trên kết nối hiện tại. */
  ready(accountId: string, engine: "spot" | "perps"): boolean;
}

/** Lý do "Leverage set". Bot paper không gửi gì tới SoDEX (PaperGateway, DEC-105) nên không ghi "SoDEX confirmed". */
function leverageWhy(paper: boolean, what: string): string {
  return paper ? `Simulated ${what}. Nothing was sent to SoDEX.` : `SoDEX confirmed ${what}.`;
}

/** Engine (Spot / Perps) mà bot giao dịch, theo chiến lược và cấu hình. */
function engineOfBot(strategy: string, config: unknown): "spot" | "perps" {
  if (
    strategy.startsWith("futures") ||
    VOLUME.has(strategy) ||
    strategy === Strategy.adaptiveDca ||
    strategy === Strategy.copyTrade
  )
    return "perps";
  if (strategy === Strategy.twap)
    return (config as { engine?: string }).engine === "perps" ? "perps" : "spot";
  return "spot";
}

/**
 * `StepContext.feeRate` của một bot (DEC-112): nửa phí khứ hồi maker = SoDEX maker của market (`/symbols`, thiếu thì
 * mức cơ bản) + builder fee của chiến lược (Spot chỉ chiều bán). `builderAccount`: account của builder, không chịu
 * builder fee (DEC-47).
 */
export function botFeeRate(
  strategy: string,
  config: unknown,
  rules: MarketRules | undefined,
  builderAccount: boolean,
  builderRate = builderFeeRateOf(strategy),
): string {
  return oneWayFeeFraction({
    engine: engineOfBot(strategy, config),
    makerPct: rules?.makerFee === undefined ? null : dec(rules.makerFee).mul(100),
    builderRate: builderAccount ? 0 : builderRate,
  }).toString();
}

/** Như `botFeeRate` nhưng cho lệnh taker: SoDEX taker của market + builder fee (DEC-117). */
export function botTakerFeeRate(
  strategy: string,
  config: unknown,
  rules: MarketRules | undefined,
  builderAccount: boolean,
  builderRate = builderFeeRateOf(strategy),
): string {
  return oneWayTakerFeeFraction({
    engine: engineOfBot(strategy, config),
    takerPct: rules?.takerFee === undefined ? null : dec(rules.takerFee).mul(100),
    builderRate: builderAccount ? 0 : builderRate,
  }).toString();
}

/** Volume Farm nhận nến + sổ lệnh tối đa mỗi ngần này ms (một lần đọc REST mỗi market, weight 2). */
export const FARM_SNAPSHOT_MS = 3_000;
/** Số nến 1 phút gửi cho Volume Farm: đủ 5 phút × 15 cho regime (FarmMicro cần ≥ 15 nến 5 phút). */
export const FARM_CANDLES = 120;

interface Runner {
  botId: string;
  account: AccountRef;
  /** Bot paper: mọi lệnh qua `PaperGateway`, không bao giờ tới SoDEX (DEC-105). */
  paper: boolean;
  /** Cổng đặt lệnh của runner, chọn một lần ở `#gatewayFor` khi nạp bot. */
  gateway: Gateway;
  shard: number;
  epoch: number;
  versionId: string;
  version: number;
  strategy: string;
  /** Builder fee gắn vào lệnh (phần mười bp): mức riêng của user nếu team đặt (DEC-159), không thì mặc định. */
  builderRate: number;
  market: string;
  config: unknown;
  state: unknown;
  module: StrategyModule<unknown, unknown>;
  ctx: StepContext;
  /** Lệnh đầu tiên đã được ack (để xác nhận Running). */
  awaitingFirstAck: boolean;
  /** Đòn bẩy + margin mode của version đang chạy đã được SoDEX xác nhận (bot Perps). */
  leverageSet: boolean;
  /** Lần `updateLeverage` trước không rõ kết quả: phải đọc lại SoDEX trước khi gửi lại (quy tắc 1.7). */
  leverageUnknown: boolean;
  /** Market đã được SoDEX xác nhận đòn bẩy cho version này (CP-01): lần thử sau không đặt / ghi lại. */
  leverageDone: Set<string>;
  /**
   * Khoá đòn bẩy đã xác nhận cho version này TRƯỚC lần nạp lại runner (`bot_runtime.leverage_done`). Vẫn đọc lại SoDEX;
   * khớp thì không ghi lại "Leverage set". Khác (đổi từ bên ngoài, DEC-58) thì xử lý như thường.
   */
  leverageKnown: ReadonlySet<string>;
  /** Lần đặt đòn bẩy đang chạy: sự kiện tới cùng lúc chờ chung, không đặt song song (CP-01). */
  /** Lần đặt đòn bẩy đang chạy, gắn với version lúc bắt đầu (đổi version giữa chừng thì không dùng chung kết quả). */
  leverageRun: {
    versionId: string;
    p: Promise<"ok" | "rejected" | "unknown" | "not_sent">;
  } | null;
  /** Request chưa rời DRIFT (signer lỗi): chờ backoff tới `nextAt`; quá hạn thì pause (UI_REVIEW H1). */
  blocked: { since: number; attempts: number; nextAt: number; code: NotSentCode } | null;
  /** Số lệnh market reduce-only bị SoDEX từ chối liên tiếp (vị thế trong sổ bot có thể lệch SoDEX). */
  reduceRejects: number;
  /** Tương tự cho lệnh limit / post-only: bị từ chối thường chỉ vì giá chạy, nên có ngưỡng riêng cao hơn. */
  makerReduceRejects: number;
  /** Số lệnh bị SoDEX từ chối vì thiếu margin liên tiếp; một lần SoDEX nhận lệnh (ack) thì về 0. */
  marginRejects: number;
  /** Thời điểm các lần bị từ chối vì thiếu margin trong `MARGIN_REJECT_WINDOW_MS` gần nhất (ack không xoá). */
  marginRejectTimes: number[];
  /** Lần SoDEX từ chối lệnh vì lý do thật gần đây, theo lý do: để ghi Decisions tối đa một dòng mỗi phút mỗi lý do. */
  rejectLog: Map<string, { times: number[]; loggedAt: number | null }>;
  /** Giới hạn tin `copy_bot_skipped` của bot copy (DEC-212), trong bộ nhớ. */
  skipGate: SkipGate;
  /** Engine SoDEX bot giao dịch (`bots.engine`): Resume chờ user stream của đúng các engine này. */
  engines: readonly ("spot" | "perps")[];
  /** Lệnh đóng của Stop chưa gửi được: nấc thử lại và các lý do đã ghi Decisions (#sendCloses). */
  closeRetry: { since: number; attempts: number; nextAt: number; reasons: Set<string> } | null;
  /**
   * Market Perps mà vị thế thật lệch sổ cái sau khi đã đối soát trade (`bots.position_mismatch`,
   * DEC-306): `real` cập nhật mỗi lần kiểm tra. Chỉ được gửi lệnh không làm tăng |real|.
   */
  positionMismatch: Map<string, MismatchEntry>;
  /** Đã log "giữ bước vì lệch vị thế" trong đợt lệch này (một lần mỗi đợt). */
  mismatchWaitLogged: boolean;
  /** Sự kiện `resumed` bị giữ vì lệch vị thế: gửi lại ở sự kiện thị trường kế tiếp không còn bị giữ. */
  resumeOwed: boolean;
  /** Lúc version đang chạy được áp (null = không rõ). */
  appliedAt: number | null;
  /**
   * Lần áp version gần nhất (bằng `initialState`) bỏ một sổ cái còn vị thế ở market Perps nào đó: chỉ khi đó lệch vị thế
   * mới được coi là do đổi version (N2). Chỉ nhớ trong bộ nhớ; nạp lại thì đi theo các bậc thường.
   */
  resetDroppedPosition: boolean;
}

/**
 * Lệnh market reduce-only bị từ chối liên tiếp chừng này lần thì pause bot, không gửi lại mãi (quy tắc 1.7).
 * Chỉ đếm market: post-only bị từ chối là bình thường khi giá chạy nhanh, pause lúc đó bỏ mặc vị thế đang mở
 * đúng lúc cần thoát, trước cả khi chiến lược kịp chuyển sang market (DEC-89).
 */
export const MAX_REDUCE_ONLY_REJECTS = 3;
/** Ngưỡng cho bot không dùng market (tắt `allowTaker`): không có bước leo thang thì vẫn phải có điểm dừng. */
export const MAX_MAKER_REDUCE_REJECTS = 30;

/**
 * Lệnh bị SoDEX từ chối vì thiếu margin (`code -1` + "insufficient margin", `isInsufficientMarginReject`): gửi lại chỉ
 * bị từ chối tiếp và đốt hạn mức request của IP / ví dùng chung với bot khác. Pause `ORDER_REJECTED` khi bị từ chối
 * `MAX_MARGIN_REJECTS` lần liên tiếp (một lần ack đặt lại), hoặc `MARGIN_REJECTS_IN_WINDOW` lần trong
 * `MARGIN_REJECT_WINDOW_MS` dù xen giữa có lệnh được nhận (sự cố 2026-11-15: Market Making bị từ chối 21 438 lần
 * trong 15 giờ mà không pause). Áp cho mọi chiến lược đặt lệnh qua engine; post-only bị từ chối không tính.
 */
export const MAX_MARGIN_REJECTS = 3;
export const MARGIN_REJECTS_IN_WINDOW = 5;
export const MARGIN_REJECT_WINDOW_MS = 60_000;
/** Câu trong Decisions khi pause vì thiếu margin (câu chữ đã duyệt). */
export const MARGIN_PAUSE_WHY =
  "Paused: not enough margin on SoDEX. Add funds or lower the order size or leverage, then resume.";

/**
 * Lệnh bị SoDEX từ chối vì lý do thật (không phải post-only / chặn tự khớp, `NORMAL_REJECT_CODES`) được ghi Decisions,
 * tối đa một dòng mỗi lý do trong `REJECT_LOG_WINDOW_MS`, kèm số lần trong cửa sổ đó. Sự cố 2026-11-15: 21 438 lần
 * "insufficient margin" trong 15 giờ không có dòng nào trong Decisions (DEC-291).
 */
export const REJECT_LOG_WINDOW_MS = 60_000;
/** Câu Decisions cho lệnh bị SoDEX từ chối (câu chữ đã duyệt). */
export const rejectLogText = (reason: string, n: number): string =>
  `Order refused by SoDEX: ${reason} (${String(n)} in the last minute).`;

/**
 * Lệnh đóng của Stop chưa rời DeskLabs: thử lại sau 5 s → 15 s → 60 s (rồi giữ 60 s); vẫn chưa gửi được sau 10 phút thì
 * kết thúc Stop với vị thế còn mở và báo người dùng (DEC-302).
 */
export const CLOSE_RETRY = { backoffMs: [5_000, 15_000, 60_000], giveUpMs: 600_000 } as const;

/** Backoff khi request chưa rời DRIFT: 2 s → 4 s → … tối đa 60 s; quá 5 lần hoặc 5 phút thì pause bot. */
export const NOT_SENT_BACKOFF = {
  firstMs: 2_000,
  maxMs: 60_000,
  maxAttempts: 5,
  maxMs_total: 300_000,
};

/** Đòn bẩy + margin mode bot Perps cần trên SoDEX (dùng chung với check của api, DEC-58). */
export const leverageSpec = leverageSpecOf;

/** Chiến lược cần `timer` để hành động (các chiến lược còn lại chỉ phản ứng với giá / funding). */
const CLOCKED: ReadonlySet<string> = new Set([
  Strategy.recurringBuy,
  Strategy.twap,
  Strategy.rebalancing,
  Strategy.volumeMaker,
  Strategy.volumeFarm,
  Strategy.adaptiveDca,
  // Copy Trade: đặt lại lệnh giảm vị thế còn thiếu ở nhịp đồng hồ (DEC-161).
  Strategy.copyTrade,
]);

/**
 * Chiến lược nhận kèm nến 1 phút với `timer` và chu kỳ gửi: Volume Farm mỗi 3 s; AI Adaptive DCA dùng nến 5 phút nên
 * mỗi phút là đủ (DEC-107), đỡ một lần đọc sổ lệnh REST mỗi 3 s.
 */
const SNAPSHOT_EVERY_MS: Readonly<Record<string, number>> = {
  [Strategy.volumeFarm]: 3_000,
  // Market Making báo giá theo sổ lệnh (DEC-135); dùng chung bản đọc với Volume Farm cùng market.
  [Strategy.volumeMaker]: 3_000,
  [Strategy.adaptiveDca]: 60_000,
};

/** Chiến lược nhận kèm đỉnh sổ lệnh của mọi market nó dùng với `timer`, và chu kỳ gửi (Rebalancing: IOC theo ask / bid). */
const BOOKS_EVERY_MS: Readonly<Record<string, number>> = {
  [Strategy.rebalancing]: 60_000,
};
/** Đỉnh sổ lệnh đọc gần đây được dùng chung cho mọi bot cùng market trong chừng này. */
const BOOK_CACHE_MS = 3_000;

const VOLUME: ReadonlySet<string> = new Set(VOLUME_STRATEGIES);
/** Trạng thái chuyển tiếp mà engine phải xác nhận: đọc lại dòng bot ngay trước khi xử lý (snapshot của vòng có thể cũ). */
const TRANSITIONAL: ReadonlySet<string> = new Set<string>([
  BotState.pausing,
  BotState.resuming,
  BotState.stopping,
]);
/** Trạng thái mà cờ theo tài khoản (volume bots, Adaptive DCA, AI Desk) chặn nạp: bot đang muốn chạy. */
const FLAG_GATED_STATES: ReadonlySet<string> = new Set<string>([
  BotState.starting,
  BotState.running,
  BotState.resuming,
]);

/** Giờ UTC tới mili giây (HH:MM:SS.mmm) cho Decisions khi rút lệnh theo giá Binance. */
export const clockTime = (ms: number): string => new Date(ms).toISOString().slice(11, 23);

/**
 * State sau khi ghi version mới (DEC-304). `after` = `applyVersion` đọc lại trên state hiện tại,
 * `written` = state đã ghi cùng transaction. Fill tới trong lúc ghi: `after` null (bot lại có vị thế) → giữ state hiện
 * tại; hoặc `after` khác bản đã ghi. Cả hai trường hợp phải ghi lại ngay với version mới, để engine nạp lại không rơi về
 * `initialState` và quên vị thế.
 */
export function settleAppliedState(
  after: unknown,
  current: unknown,
  written: unknown,
): { state: unknown; save: boolean } {
  if (after === null) return { state: current, save: true };
  return { state: after, save: JSON.stringify(after) !== JSON.stringify(written) };
}

export function shardOf(accountId: string, shards = ENGINE_SHARDS): number {
  return Number(fnv1a64(accountId) % BigInt(shards));
}

export class Engine {
  readonly #d: Required<
    Omit<EngineDeps, "feeRate" | "paper" | "builderId" | "monotonic" | "loopDelay" | "userStreams">
  > & {
    feeRate: string | undefined;
    builderId: bigint | undefined;
    paper: PaperGateway | undefined;
    loopDelay: EngineDeps["loopDelay"];
    userStreams: UserStreams | undefined;
  };
  readonly #leases = new Map<number, { lease: Lease; epoch: number }>();
  /** Gia hạn lease shard + heartbeat worker bằng timer riêng, không theo vòng `tick` (DEC-302). */
  readonly #leaseSet: LeaseSet<number>;
  readonly #clockMono: () => number;
  readonly #runners = new Map<string, Runner>();
  readonly #lastFeeCheck = new Map<string, number>();
  readonly #snapshots = new Map<string, { at: number; snap: MarketSnapshot }>();
  readonly #snapshotFed = new Map<string, number>();
  /** Lần gần nhất gửi đỉnh sổ lệnh cho bot (`BOOKS_EVERY_MS`). */
  readonly #booksFed = new Map<string, number>();
  readonly #books = new Map<string, { at: number; book: BookTop | null }>();
  readonly #openChecks = new Map<string, number>();
  /** Lần cuối user stream của account có thể đã mất tin (đứt kết nối, engine vừa nạp bot). */
  readonly #streamGaps = new Map<string, number>();
  /** Account + engine vừa có khoảng trống user stream (STREAM_GAP_MS). */
  #inGap(accountId: string, engine: "spot" | "perps", now: number): boolean {
    return (
      now - (this.#streamGaps.get(`${accountId}:${engine}`) ?? Number.NEGATIVE_INFINITY) <
      STREAM_GAP_MS
    );
  }
  readonly #fillQueues = new Map<string, Promise<void>>();
  /** Lần cuối đọc trade / vị thế cho Market Making, theo `account:market` (DEC-100). */
  readonly #makerBackfill = new Map<string, number>();
  /** Lần cuối kiểm tra vị thế thật của account (POSITION_CHECK_MS). */
  readonly #positionCheckAt = new Map<string, number>();
  /** Độ lệch vị thế đang theo dõi, theo `bot:market`. */
  readonly #positionWatch = new Map<string, PositionWatch>();
  /** Lần cuối so lịch sử khớp cho lưới an toàn fill, theo `account:engine:market`. */
  readonly #fillBackfill = new Map<string, number>();
  /** Lệnh `unknown` SoDEX đã nhận: số lần tra, lần tra gần nhất, số lần tra thành công mà vẫn không thấy. */
  readonly #unknownChecks = new Map<string, { n: number; at: number }>();
  /** Lần đầu đối soát thấy lệnh `open` không còn trên SoDEX (thời gian chờ tính từ đây, không từ lúc gửi). */
  readonly #missingSince = new Map<string, number>();
  /** Lịch sử khớp của account trên market, đọc tối đa một lần mỗi vòng tick (`account:engine:market`). */
  #tradesCache = new Map<
    string,
    { seq: number; p: Promise<(OrderTrade & { clOrdID: string })[]> }
  >();
  /** Thứ tự đọc (lịch sử khớp, tra lệnh) trong tiến trình: biết bản lịch sử khớp đang giữ cũ hơn một lần tra hay không. */
  #readSeq = 0;
  /** Khoảng trống user stream đã được so lịch sử khớp (một lần mỗi khoảng trống), theo `account:engine:market`. */
  readonly #gapBackfilled = new Map<string, number>();
  /** Khoảng trống (theo `account:engine`, giá trị = lúc bắt đầu) đã được đọc ứng viên lưới an toàn. */
  readonly #gapCandidatesRead = new Map<string, number>();
  /** Lần cuối đọc ứng viên của lưới an toàn fill (#backfillCandidates). */
  #backfillReadAt = Number.NEGATIVE_INFINITY;
  /** Lần cuối ghi log "chờ user stream" và lúc bắt đầu chờ, theo `account:engine`. */
  readonly #streamWaitLog = new Map<string, number>();
  readonly #streamWaitSince = new Map<string, number>();
  /** Khoá theo bot: nạp runner và ghi fill khi chưa có runner không chạy chồng (sổ cái đã lưu không bị đọc cũ). */
  readonly #botLocks = new Map<string, Promise<void>>();
  /** Lệnh đang chờ huỷ lại theo bot (huỷ trước đó chưa được SoDEX xác nhận), và lần thử gần nhất. */
  readonly #pendingCancels = new Map<string, Set<string>>();
  readonly #cancelRetryAt = new Map<string, number>();
  /**
   * Lệnh SoDEX trả `OrderNotFound` khi huỷ mà không còn mới (DEC-308), theo bot: vẫn trong
   * `#pendingCancels` (để #reconcileOpen đối soát như lệnh đã gửi huỷ) nhưng không gửi huỷ lại.
   */
  readonly #cancelGone = new Map<string, Set<string>>();
  /** Lần huỷ gần nhất của lệnh trong `#cancelGone` (huỷ lại chậm mỗi OPEN_CHECK_MS tới khi có kết quả, review #216 M3). */
  readonly #goneCancelAt = new Map<string, number>();
  /** Lệnh huỷ đang chờ lệnh đặt được nhận (DEC-254): clOrdID → lúc bắt đầu chờ. */
  readonly #inflightCancels = new Map<string, number>();
  /** Lần cuối ghi số dư giả của bot paper. */
  readonly #paperSnapAt = new Map<string, number>();
  #stopped = false;
  /** Account vừa bỏ runner cuối (Stop): giữ user stream tới `until` (STREAM_HOLD_MS). */
  readonly #streamHolds = new Map<
    string,
    { account: AccountRef; engines: Set<"spot" | "perps">; until: number }
  >();
  /** Account có lệnh bot thật còn mở / `unknown` theo snapshot gần nhất: giữ user stream (fill vẫn có thể tới). */
  #orderStreams = new Map<string, { account: AccountRef; engines: Set<"spot" | "perps"> }>();
  /** Các lần tra lệnh trong LOOKUP_BUDGET.windowMs gần nhất (lúc tra, weight), của cả worker. */
  #lookupLog: { at: number; weight: number }[] = [];
  /** Huỷ bị từ chối cả request liên tiếp, theo account: số lần, huỷ lại sớm nhất lúc, nấc đã warn. */
  readonly #cancelBackoff = new Map<string, { n: number; until: number; warned: number }>();
  /** Shard đang chạy các bước của một vòng (có thể kéo dài qua vòng sau khi SoDEX chậm). */
  readonly #lanes = new Map<number, Promise<void>>();
  readonly #shardLimit = new Limiter(SHARD_CONCURRENCY);
  /** Lần gia hạn lease do một làn shard gọi, dùng chung cho các làn khác cần cùng lúc. */
  #renewing: Promise<void> | null = null;

  constructor(deps: EngineDeps) {
    this.#d = {
      now: () => Date.now(),
      leaseTtlMs: 15_000,
      shards: ENGINE_SHARDS,
      feeCheckMs: 60_000,
      orderbook: () => Promise.resolve(null),
      tickWaitMs: Number.POSITIVE_INFINITY,
      lookupBudget: Number.POSITIVE_INFINITY,
      ...deps,
      builderExempt: deps.builderExempt ?? true,
      feeRate: deps.feeRate,
      builderId: deps.builderId,
      paper: deps.paper,
      loopDelay: deps.loopDelay,
      userStreams: deps.userStreams,
    };
    this.#clockMono = deps.monotonic ?? (() => performance.now());
    this.#leaseSet = new LeaseSet<number>({
      redis: this.#d.redis,
      ttlMs: this.#d.leaseTtlMs,
      clock: this.#clockMono,
      heartbeat: { key: `engine:worker:${this.#d.workerId}`, value: () => String(this.#d.now()) },
      verify: (shard) => this.#stillOurs(shard),
      onLost: (shard, reason) => {
        this.#shardLost(shard, reason);
      },
      onReacquired: (shard) => {
        this.#d.log.warn(
          { shard, epoch: this.#leases.get(shard)?.epoch, worker: this.#d.workerId },
          "shard lease re-acquired; epoch and bots kept",
        );
      },
      onError: (error) => {
        this.#d.log.warn({ err: error }, "shard lease renew failed");
      },
    });
  }

  get ownedShards(): number[] {
    return [...this.#leases.keys()].sort((a, b) => a - b);
  }

  epochOf(shard: number): number | undefined {
    return this.#leases.get(shard)?.epoch;
  }

  /**
   * Một vòng: nhận / trả shard, xử lý lệnh bot, đối soát, kiểm tra phí. Lease được gia hạn bằng timer riêng
   * (`LeaseSet`), nên một vòng chậm không làm mất shard; trước mỗi bước của shard kiểm tra lease còn hiệu lực.
   */
  async tick(): Promise<void> {
    if (this.#stopped) return;
    // Lịch sử khớp đọc trong vòng trước đã cũ.
    this.#tradesCache.clear();
    for (const [id, h] of this.#streamHolds)
      if (h.until <= this.#d.now()) this.#streamHolds.delete(id);
    const started = this.#clockMono();
    await this.#manageShards();
    const managed = this.#clockMono();
    let snap: TickSnapshot;
    try {
      snap = await this.#tickSnapshot();
    } catch (error) {
      // Đọc DB đầu vòng lỗi: bỏ phần việc của shard ở vòng này nhưng vẫn trả về bình thường, để vòng ngoài (main.ts)
      // vẫn đồng bộ user stream; vòng sau đọc lại.
      this.#d.log.error({ err: error }, "tick snapshot failed; skipping shard work this tick");
      this.#logSlowTick(started, {
        manageShards: managed - started,
        snapshot: this.#clockMono() - managed,
      });
      return;
    }
    const phases: Record<string, number> = {
      manageShards: managed - started,
      snapshot: this.#clockMono() - managed,
    };
    const steps: Record<ShardPhase, (shard: number) => Promise<void>> = {
      // Mở user stream ngay sau khi nạp bot, trong cùng bước (DEC-303).
      syncBots: async (n) => {
        await this.#syncBots(n, snap);
        this.#openStreams(n);
      },
      reconcile: (n) => this.#reconcile(n, snap),
      reconcileOpen: (n) => this.#reconcileOpen(n, snap),
      retryCancels: (n) => this.#retryCancels(n),
      reconcileMaker: (n) => this.#reconcileMaker(n),
      backfillFills: (n) => this.#backfillFills(n, snap),
      checkPositions: (n) => this.#checkPositions(n),
      checkFees: (n) => this.#checkFees(n, snap.accounts.get(n) ?? []),
      clock: (n) => this.#clock(n),
    };
    // Mỗi shard một làn: các shard chạy song song (tối đa SHARD_CONCURRENCY), trong một shard các bước vẫn tuần tự. Vòng
    // chờ tối đa `tickWaitMs`; shard còn chạy (SoDEX chậm) chạy tiếp ngoài vòng và vòng sau bỏ qua nó tới khi xong, nên một
    // account chờ SoDEX không làm chậm bước / đồng hồ của account ở shard khác (DEC-308).
    const counts = { skipped: 0, busy: 0 };
    const lanes: Promise<void>[] = [];
    let waiting = true;
    snap.lookups = this.#planLookups(
      snap,
      this.ownedShards.filter((x) => !this.#lanes.has(x)),
      this.#d.now(),
    );
    for (const shard of this.ownedShards) {
      // Shard không có account nào và không có runner nào: không có việc gì (không truy vấn, không gọi SoDEX).
      const accounts = snap.accounts.get(shard) ?? [];
      if (accounts.length === 0 && !this.#hasRunners(shard)) continue;
      if (this.#lanes.has(shard)) {
        counts.busy += 1;
        continue;
      }
      const lane = this.#shardLimit
        .run(() => this.#runShard(shard, steps))
        .then((done) => {
          if (waiting) {
            counts.skipped += done.skipped;
            for (const [k, v] of Object.entries(done.phases)) phases[k] = (phases[k] ?? 0) + v;
          }
        })
        .catch((error: unknown) => {
          this.#d.log.error({ err: error, shard }, "shard loop failed");
        })
        .finally(() => {
          this.#lanes.delete(shard);
        });
      this.#lanes.set(shard, lane);
      lanes.push(lane);
    }
    await settleWithin(lanes, this.#d.tickWaitMs);
    waiting = false;
    const running = lanes.length === 0 ? [] : this.ownedShards.filter((x) => this.#lanes.has(x));
    if (running.length > 0)
      this.#d.log.warn(
        { shards: running, waitMs: this.#d.tickWaitMs },
        "shards still waiting on SoDEX after the tick; other shards go on",
      );
    this.#logSlowTick(started, phases, counts.skipped, counts.busy);
  }

  /** Các bước của một shard trong một vòng, tuần tự. Shard chậm (> TTL/2) ghi `shard slow` kèm thời gian từng bước. */
  async #runShard(
    shard: number,
    steps: Record<ShardPhase, (shard: number) => Promise<void>>,
  ): Promise<{ skipped: number; phases: Record<string, number> }> {
    const phases: Record<string, number> = {};
    const started = this.#clockMono();
    let skipped = 0;
    // Epoch lúc làn bắt đầu: lease mất rồi nhận lại (epoch mới) trong lúc làn chạy dở thì làn cũ dừng, không chạy tiếp bằng
    // lease mới trên snapshot cũ (review #216 M1).
    const laneEpoch = this.#leases.get(shard)?.epoch;
    const current = () => laneEpoch !== undefined && this.#leases.get(shard)?.epoch === laneEpoch;
    try {
      for (const phase of SHARD_PHASES) {
        // Engine đang dừng (review #216 M2) hoặc lease đã đổi: không bước nào nữa, kể cả làn đang xếp hàng.
        if (this.#stopped || !current()) break;
        if (!(await this.#leaseConfirmed(shard))) {
          skipped += 1;
          break;
        }
        const at = this.#clockMono();
        await steps[phase](shard);
        phases[phase] = (phases[phase] ?? 0) + this.#clockMono() - at;
      }
    } catch (error) {
      if (error instanceof LeaseExpiredError)
        this.#d.log.warn({ shard }, "shard skipped this tick: lease not confirmed");
      else if (error instanceof FencedError) {
        // Chỉ bỏ shard khi lease đang giữ vẫn là lease của làn này: lease mới (epoch khác) nhận trong lúc làn chạy không bị
        // bỏ vì lỗi fencing của lease cũ.
        if (current()) {
          this.#d.log.warn({ shard, reason: "fenced", worker: this.#d.workerId }, "shard lost");
          this.#dropShard(shard);
        } else
          this.#d.log.warn({ shard, epoch: laneEpoch }, "old shard lane fenced; lease changed");
      } else this.#d.log.error({ err: error, shard }, "shard loop failed");
    }
    const ms = this.#clockMono() - started;
    if (ms > this.#d.leaseTtlMs / 2)
      this.#d.log.warn(
        {
          shard,
          ms: Math.round(ms),
          phases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, Math.round(v)])),
        },
        "shard slow",
      );
    return { skipped, phases };
  }

  /**
   * Log `tick slow` khi một vòng lâu hơn TTL/2, kèm thời gian từng bước (tổng các shard xong trong vòng). `busy` = shard
   * bỏ qua vì lượt trước của nó còn chạy.
   */
  #logSlowTick(started: number, phases: Record<string, number>, skipped = 0, busy = 0): void {
    const ms = this.#clockMono() - started;
    if (ms > this.#d.leaseTtlMs / 2)
      this.#d.log.warn(
        {
          ms: Math.round(ms),
          shards: this.#leases.size,
          skipped,
          busy,
          phases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, Math.round(v)])),
          loopDelay: this.#d.loopDelay?.(),
        },
        "tick slow",
      );
  }

  /** Lease của shard còn hiệu lực; hết thì gia hạn ngay một lần rồi xem lại. */
  async #leaseConfirmed(shard: number): Promise<boolean> {
    // Engine đang dừng: không bước nào gửi gì nữa (review #216 M2).
    if (this.#stopped) return false;
    if (this.#leaseSet.valid(shard)) return true;
    if (!this.#leaseSet.has(shard)) return false;
    // Không chờ khi đã có lần gia hạn đang chạy hoặc vừa lỗi (Redis đang sự cố): mỗi bước của shard không treo tới hạn chờ.
    // Các shard chạy song song (DEC-308): mọi làn đang cần gia hạn chờ chung MỘT lần gọi, không phải
    // làn thứ hai thấy "đang gia hạn" rồi bỏ lượt.
    this.#renewing ??= this.#leaseSet.renewIfIdle().finally(() => {
      this.#renewing = null;
    });
    await this.#renewing;
    return this.#leaseSet.valid(shard);
  }

  /**
   * Hoàn tác một bước chiến lược chưa có tác dụng phụ nào (đầu `#execute`): chỉ đưa state về như trước (bộ nhớ + DB).
   * Không đụng dòng lệnh hay danh sách chờ huỷ: dòng `unknown` cùng clOrdID (nếu có) thuộc một lần gửi trước, có thể
   * đang sống trên SoDEX (quy tắc 1.7).
   */
  async #restoreState(r: Runner, rollback: unknown): Promise<void> {
    r.state = rollback;
    await this.#fenced(r, (tx) =>
      tx
        .update(botRuntime)
        .set({ state: r.state, updatedAt: new Date() })
        .where(eq(botRuntime.botId, r.botId)),
    );
  }

  /**
   * Gia hạn lease thất bại nhưng `SET NX` lại được: chỉ giữ epoch và runner khi DB cho thấy shard vẫn của mình với đúng
   * epoch đang giữ (không ai nhận shard trong lúc lease hết hạn).
   */
  async #stillOurs(shard: number): Promise<boolean> {
    const held = this.#leases.get(shard);
    if (held === undefined) return false;
    const rows = await this.#d.db
      .update(shardEpochs)
      .set({ acquiredAt: new Date(this.#d.now()) })
      .where(
        and(
          eq(shardEpochs.shard, shard),
          eq(shardEpochs.owner, this.#d.workerId),
          eq(shardEpochs.epoch, held.epoch),
        ),
      )
      .returning({ epoch: shardEpochs.epoch });
    return rows.length === 1;
  }

  #shardLost(shard: number, reason: LeaseLoss): void {
    this.#d.log.warn(
      { shard, reason, epoch: this.#leases.get(shard)?.epoch, worker: this.#d.workerId },
      "shard lost",
    );
    this.#dropShard(shard);
  }

  /**
   * Nhịp đồng hồ cho chiến lược chạy theo thời gian (DEC-61): mỗi vòng engine gửi `timer`; chiến lược tự kiểm
   * tra đã tới hạn chưa (lịch Recurring Buy, lát TWAP, lịch / ngưỡng Rebalancing, refresh Volume Maker).
   */
  async #clock(shard: number): Promise<void> {
    const at = this.#d.now();
    const paper = this.#d.paper;
    if (paper !== undefined)
      for (const r of [...this.#runners.values()].filter((x) => x.shard === shard && x.paper)) {
        if (at - (this.#paperSnapAt.get(r.botId) ?? 0) < PAPER_SNAPSHOT_MS) continue;
        this.#paperSnapAt.set(r.botId, at);
        await paper.snapshot(r.botId, at);
      }
    for (const r of [...this.#runners.values()].filter(
      (x) => x.shard === shard && CLOCKED.has(x.strategy),
    )) {
      const every = SNAPSHOT_EVERY_MS[r.strategy];
      if (every !== undefined) {
        // Nhịp dữ liệu tính theo từng bot: nhiều bot (kể cả của khách khác) cùng market đều nhận được.
        const due = at - (this.#snapshotFed.get(r.botId) ?? 0) >= every;
        const market = due ? await this.#snapshot(r.market, at) : null;
        if (due) this.#snapshotFed.set(r.botId, at);
        await this.#feed(
          r,
          market === null ? { type: "timer", at } : { type: "timer", at, market },
        );
      } else {
        const booksEvery = BOOKS_EVERY_MS[r.strategy];
        const due =
          booksEvery !== undefined && at - (this.#booksFed.get(r.botId) ?? 0) >= booksEvery;
        if (!due) {
          await this.#feed(r, { type: "timer", at });
          continue;
        }
        this.#booksFed.set(r.botId, at);
        const books: Record<string, BookTop | null> = {};
        // Rebalancing chỉ có market Spot.
        for (const m of this.#marketsOf(r.market, r.config))
          books[m] = await this.#bookTop(m, at, "spot");
        await this.#feed(r, { type: "timer", at, books });
      }
    }
  }

  /** Đỉnh sổ lệnh của một market, dùng chung giữa các bot trong `BOOK_CACHE_MS`; đọc lỗi → null. */
  async #bookTop(market: string, at: number, engine: "spot" | "perps"): Promise<BookTop | null> {
    const key = `${engine}:${market}`;
    const hit = this.#books.get(key);
    if (hit !== undefined && at - hit.at < BOOK_CACHE_MS) return hit.book;
    const book = await this.#d.orderbook(market, engine).catch(() => null);
    this.#books.set(key, { at, book });
    return book;
  }

  /**
   * Nến 1 phút đã đóng (`candles_1m`, marketdata ghi) + đỉnh sổ lệnh cho Volume Farm. Mỗi market đọc SoDEX tối đa
   * mỗi `FARM_SNAPSHOT_MS`; các bot khác cùng market dùng chung bản đã đọc.
   */
  async #snapshot(market: string, at: number): Promise<MarketSnapshot> {
    const hit = this.#snapshots.get(market);
    if (hit !== undefined && at - hit.at < FARM_SNAPSHOT_MS) return hit.snap;
    const rows = await this.#d.db
      .select()
      .from(candles1m)
      .where(eq(candles1m.market, market))
      .orderBy(desc(candles1m.ts))
      .limit(FARM_CANDLES);
    const book = await this.#d.orderbook(market).catch(() => null);
    const snap: MarketSnapshot = {
      market,
      candles: rows.reverse().map((k) => ({
        t: k.ts.getTime(),
        o: k.open,
        h: k.high,
        l: k.low,
        c: k.close,
        v: k.volume,
      })),
      book,
      bookAt: at,
    };
    this.#snapshots.set(market, { at, snap });
    return snap;
  }

  /**
   * Giá tốt nhất SoDEX mới nhất của mỗi market cho Volume Farm (DEC-298), chỉ trong bộ nhớ: `at` = lúc NATS
   * giao tin. Không bước chiến lược hay ghi DB cho từng tin; `#feed` đưa giá này vào bot ngay trước mỗi bước.
   */
  readonly #farmBooks = new Map<string, { bid: string; ask: string; at: number }>();
  /** `at` của giá sổ lệnh đã đưa vào state của từng runner (runner nạp lại từ DB thì nhận lại giá mới nhất). */
  readonly #farmBookFed = new WeakMap<Runner, number>();

  /** Giá tốt nhất SoDEX (WS) cho Volume Farm, cả tin `refresh`: chỉ lưu bản mới nhất của market (đồng bộ, không I/O). */
  onFarmBook(msg: MmBookMessage, recvAt: number): void {
    const prev = this.#farmBooks.get(msg.s);
    if (prev !== undefined && prev.at > recvAt) return;
    this.#farmBooks.set(msg.s, { bid: msg.b, ask: msg.a, at: recvAt });
  }

  /** Giá mới từ marketdata (NATS `md.<market>.price`). */
  readonly #lastPrice = new Map<string, string>();

  /**
   * Giá Binance quy đổi (`md.<market>.fair`): đưa cho bot Market Making bật Smart quoting trên market đó. Bot không đặt
   * lệnh mở thêm vị thế vượt giá này và rút lệnh mở mà giá đã chạy qua.
   */
  async onMmFair(msg: MmFairMessage, recvAt: number): Promise<void> {
    for (const r of [...this.#runners.values()].filter(
      (x) =>
        x.strategy === Strategy.volumeMaker &&
        x.market === msg.s &&
        (x.config as { smartQuoting?: boolean }).smartQuoting === true,
    ))
      await this.#feed(r, {
        type: "fair",
        at: recvAt,
        market: msg.s,
        fair: msg.fair,
        binanceAt: msg.T,
      });
  }

  /** Giá tốt nhất SoDEX (WS, DEC-248) cho bot Market Making bật Smart quoting; tin `refresh` không tới bot MM. */
  async onMmBook(msg: MmBookMessage, recvAt: number): Promise<void> {
    if (msg.refresh === true) return;
    for (const r of [...this.#runners.values()].filter(
      (x) =>
        x.strategy === Strategy.volumeMaker &&
        x.market === msg.s &&
        (x.config as { smartQuoting?: boolean }).smartQuoting === true,
    ))
      await this.#feed(r, { type: "book", at: recvAt, market: msg.s, bid: msg.b, ask: msg.a });
  }

  async onPrice(market: string, price: string, at: number): Promise<void> {
    this.#lastPrice.set(market, price);
    // Bot paper: giá thật đi xuyên qua lệnh giả → fill mô phỏng, đưa vào sổ cái như fill thật (DEC-105).
    const paper = this.#d.paper;
    if (paper !== undefined) {
      paper.setPrice(market, price);
      const ids = [...this.#runners.values()]
        .filter((x) => x.paper && (x.market === market || this.#watches(x, market)))
        .map((x) => x.botId);
      if (ids.length > 0)
        for (const f of await paper.onPrice(market, price, at, ids))
          await this.onFill(f.accountId, f.clOrdID, f.totalFilled, f.avgPrice, f.fee, at);
    }
    for (const r of [...this.#runners.values()].filter(
      (x) => x.market === market || this.#watches(x, market),
    )) {
      await this.#feed(r, { type: "tick", at, market, price });
    }
  }

  /**
   * Một kỳ funding vừa chốt (NATS `md.<market>.funding`, tỷ lệ thô của SoDEX). Chiến lược nhận `fundingRate`
   * tính bằng % mỗi kỳ, kèm trung bình 7 ngày từ `funding_rates` (null khi chưa có dữ liệu).
   */
  async onFunding(market: string, rate: string, at: number): Promise<void> {
    const targets = [...this.#runners.values()].filter(
      (x) => x.market === market || this.#watches(x, market),
    );
    if (targets.length === 0) return;
    const [row] = await this.#d.db
      .select({ avg: sql<string | null>`avg(${fundingRates.rate})::text` })
      .from(fundingRates)
      .where(
        and(
          eq(fundingRates.market, market),
          gt(fundingRates.fundingTime, new Date(at - 7 * 86_400_000)),
          lte(fundingRates.fundingTime, new Date(at)),
        ),
      );
    const avg7d = row?.avg == null ? null : dec(row.avg).mul(100).toString();
    const current = dec(rate).mul(100).toString();
    for (const r of targets) {
      await this.#feed(r, { type: "fundingRate", at, market, current, avg7d });
      // Bot paper: trả / nhận funding trên vị thế giả; bot thật nhận `fundingPaid` từ SoDEX.
      if (r.paper && this.#d.paper !== undefined) {
        const amount = await this.#d.paper.applyFunding(r.botId, market, rate, at);
        if (!dec(amount).isZero()) await this.#feed(r, { type: "fundingPaid", at, market, amount });
      }
    }
  }

  /** Bot copy đang theo ví leader này (Copy Trade, DEC-161). */
  #copiers(source: string, address: string): Runner[] {
    const addr = address.toLowerCase();
    return [...this.#runners.values()].filter((r) => {
      if (r.strategy !== Strategy.copyTrade) return false;
      const c = r.config as { leaderSource?: string; leaderAddress?: string };
      return c.leaderSource === source && c.leaderAddress === addr;
    });
  }

  /** Fill của ví leader (NATS `leader.<source>.<address>.fill`). `receivedAt` = lúc engine nhận. */
  async onLeaderFill(m: LeaderFillMessage, receivedAt: number): Promise<void> {
    // Mọi bot theo ví này, kể cả bot không có market của fill: chiến lược ghi "Skipped · market_off" và không bao giờ mở
    // lệnh ở market đó (DEC-226).
    for (const r of this.#copiers(m.source, m.address)) {
      // Hạn mức do marketdata phân bổ (DEC-163 mục 9); có map mà thiếu bot này thì 0.
      const allowance = m.allowances === undefined ? undefined : (m.allowances[r.botId] ?? "0");
      await this.#feed(r, {
        type: "leaderFill",
        at: receivedAt,
        leaderAt: m.at,
        market: m.market,
        side: m.side,
        price: m.price,
        quantity: m.quantity,
        positionAfter: m.positionAfter,
        ...(allowance === undefined ? {} : { allowance }),
        ...(m.allowanceReason === undefined ? {} : { allowanceReason: m.allowanceReason }),
      });
    }
  }

  /** Vị thế ví leader đọc lại định kỳ (NATS `leader.<source>.<address>.position`). */
  async onLeaderPosition(m: LeaderPositionMessage, receivedAt: number): Promise<void> {
    for (const r of this.#copiers(m.source, m.address))
      for (const market of copyMarkets(r.config as Record<string, unknown>))
        await this.#feed(r, {
          type: "leaderPosition",
          at: receivedAt,
          market,
          size: m.positions[market] ?? "0",
        });
  }

  /**
   * Trade của SoDEX (user stream `accountTrade`): ghi `fills` cho lệnh của DRIFT, kèm builder fee (`bf`, đã nằm
   * trong `f`). Idempotent theo trade id. Dùng cho Orders, phí của bot và đối soát builder revenue.
   */
  async onTrade(
    accountId: string,
    t: {
      tradeId: bigint;
      clOrdID: string;
      price: string;
      quantity: string;
      fee: string;
      builderFee: string | null;
      isMaker: boolean;
      at: number;
    },
  ): Promise<void> {
    const [o] = await this.#d.db
      .select({ id: orders.id, mode: bots.mode })
      .from(orders)
      .innerJoin(bots, eq(bots.id, orders.botId))
      .where(and(eq(orders.sodexAccountId, accountId), eq(orders.clOrdId, t.clOrdID)))
      .limit(1);
    // Lệnh paper không bao giờ có trade thật; không ghi vào `fills` dù dữ liệu tới từ đâu (DEC-105).
    if (o?.mode !== "live") return;
    await this.#d.db
      .insert(fills)
      .values({
        orderId: o.id,
        sodexTradeId: t.tradeId,
        price: t.price,
        size: t.quantity,
        fee: t.fee,
        builderFee: t.builderFee,
        isMaker: t.isMaker,
        filledAt: new Date(t.at),
      })
      .onConflictDoNothing();
  }

  /**
   * Fill từ user stream hoặc từ đối soát; chỉ phần khối lượng mới được báo cho chiến lược. Các update của cùng một
   * lệnh chạy lần lượt: chạy song song thì cùng đọc `filledSize` cũ và cộng trùng khối lượng (DEC-87).
   */
  async onFill(
    accountId: string,
    clOrdID: string,
    totalFilled: string,
    avgPrice: string,
    fee: string,
    at: number,
  ): Promise<void> {
    await this.#inOrderQueue(accountId, clOrdID, () =>
      this.#applyOrderFill(accountId, clOrdID, totalFilled, avgPrice, fee, at),
    );
  }

  /**
   * Lệnh đã kết thúc trên SoDEX (FILLED / CANCELED / EXPIRED / REJECTED), từ user stream hoặc đối soát. Báo chiến lược
   * đúng một lần mỗi lệnh (`orders.done_fed_at`): `orderReject` khi bị từ chối mà chưa khớp gì, còn lại `orderDone`,
   * kể cả khi đã khớp một phần rồi hết hạn / bị huỷ (trước đây chỉ báo khi chưa khớp gì nên chiến lược đợi mãi phần
   * còn lại). Chạy chung hàng đợi với fill của lệnh đó nên fill luôn tới chiến lược trước. Lệnh chưa khớp gì thì cập
   * nhật trạng thái luôn, không để kẹt "open" (DEC-122).
   */
  async onOrderClosed(
    accountId: string,
    clOrdID: string,
    state: "rejected" | "cancelled" | "filled",
    at: number,
    reason: string | null = null,
  ): Promise<void> {
    await this.#inOrderQueue(accountId, clOrdID, () =>
      this.#finishOrder(accountId, clOrdID, state, at, reason),
    );
  }

  async #finishOrder(
    accountId: string,
    clOrdID: string,
    state: "rejected" | "cancelled" | "filled",
    at: number,
    reason: string | null,
  ): Promise<void> {
    const [o] = await this.#d.db
      .select()
      .from(orders)
      .where(and(eq(orders.sodexAccountId, accountId), eq(orders.clOrdId, clOrdID)))
      .limit(1);
    if (o?.doneFedAt !== null) return;
    const r = this.#runners.get(o.botId);
    if (r === undefined || r.paper) return;
    const nothing = !dec(o.filledSize).gt(0);
    const open = ["open", "partially_filled", "unknown"].includes(o.status);
    const rejected = state === "rejected" && nothing;
    const status = rejected
      ? "rejected"
      : dec(o.filledSize).gte(o.size)
        ? "filled"
        : open
          ? "cancelled"
          : o.status;
    const fed = await this.#markDone(r, o.id, {
      ...(open ? { status, reconciledAt: new Date(at) } : {}),
      ...(rejected && open ? { rejectCode: reason ?? "REJECTED" } : {}),
    });
    if (!fed) return;
    this.#pendingCancels.get(o.botId)?.delete(clOrdID);
    this.#inflightCancels.delete(clOrdID);
    this.#openChecks.delete(o.id);
    // Bị từ chối sau khi đã được nhận (user stream / đối soát). Lệnh bị từ chối ngay lúc gửi đã ghi ở #execute.
    if (rejected && open)
      await this.#logReject(r, o.rejectCode ?? reason ?? "REJECTED", null, o, at);
    await this.#feed(
      r,
      rejected
        ? { type: "orderReject", at, clOrdID, code: o.rejectCode ?? reason ?? "REJECTED" }
        : { type: "orderDone", at, clOrdID },
    );
  }

  /** Đánh dấu đã báo kết thúc (chỉ lần đầu thắng); `true` khi lần gọi này là lần đánh dấu. */
  async #markDone(
    fence: { shard: number; epoch: number },
    orderId: string,
    set: Partial<typeof orders.$inferInsert> = {},
  ): Promise<boolean> {
    const rows = await this.#fenced(fence, (tx) =>
      tx
        .update(orders)
        .set({ ...set, doneFedAt: new Date(this.#d.now()) })
        .where(and(eq(orders.id, orderId), isNull(orders.doneFedAt)))
        .returning({ id: orders.id }),
    );
    return rows.length > 0;
  }

  /**
   * Việc của cùng một bot cần loại trừ nhau (nạp runner / ghi fill khi chưa có runner) chạy lần lượt. KHÔNG re-entrant:
   * việc đang giữ khoá của một bot không được gọi lại vào khoá của chính bot đó (kể cả gián tiếp qua `onFill` khi bot chưa
   * có runner), nếu không sẽ tự chờ mình mãi. Thứ tự khoá: hàng đợi lệnh (#inOrderQueue) rồi mới tới khoá bot, không bao
   * giờ ngược lại.
   */
  async #withBotLock<T>(botId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.#botLocks.get(botId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(run);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.#botLocks.set(botId, tail);
    try {
      return await next;
    } finally {
      if (this.#botLocks.get(botId) === tail) this.#botLocks.delete(botId);
    }
  }

  /** Các việc của cùng một lệnh (fill, kết thúc) chạy lần lượt theo thứ tự tới. */
  async #inOrderQueue(accountId: string, clOrdID: string, run: () => Promise<void>): Promise<void> {
    const key = `${accountId}:${clOrdID}`;
    const next = (this.#fillQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    this.#fillQueues.set(key, next);
    try {
      await next;
    } finally {
      if (this.#fillQueues.get(key) === next) this.#fillQueues.delete(key);
    }
  }

  /** User stream có thể đã mất tin: đối soát lệnh Volume Farm của account trong ít phút tới (DEC-87). */
  onStreamGap(accountId: string, engine?: "spot" | "perps"): void {
    const at = this.#d.now();
    for (const e of engine === undefined ? (["spot", "perps"] as const) : [engine])
      this.#streamGaps.set(`${accountId}:${e}`, at);
  }

  async #applyOrderFill(
    accountId: string,
    clOrdID: string,
    totalFilled: string,
    avgPrice: string,
    fee: string,
    at: number,
  ): Promise<void> {
    const [o] = await this.#d.db
      .select()
      .from(orders)
      .where(and(eq(orders.sodexAccountId, accountId), eq(orders.clOrdId, clOrdID)))
      .limit(1);
    if (o === undefined) return;
    const r = this.#runners.get(o.botId);
    if (r === undefined) {
      // Chờ nếu bot đang được nạp: có runner rồi thì fill đi qua chiến lược như thường, không thì ghi sổ cái đã lưu.
      await this.#withBotLock(o.botId, async () => {
        const loaded = this.#runners.get(o.botId);
        const [cur] = await this.#d.db.select().from(orders).where(eq(orders.id, o.id)).limit(1);
        if (cur === undefined) return;
        if (loaded === undefined)
          await this.#fillWithoutRunner(cur, totalFilled, avgPrice, fee, at);
        else await this.#feedOrderFill(loaded, cur, totalFilled, avgPrice, fee, at);
      });
      return;
    }
    await this.#feedOrderFill(r, o, totalFilled, avgPrice, fee, at);
  }

  async #feedOrderFill(
    r: Runner,
    o: typeof orders.$inferSelect,
    totalFilled: string,
    avgPrice: string,
    fee: string,
    at: number,
  ): Promise<void> {
    const clOrdID = o.clOrdId;
    const delta = sub(totalFilled, o.filledSize);
    if (!delta.gt(0)) return;
    // Lệnh đã huỷ mà khớp một phần trước lúc huỷ vẫn là `cancelled`, không quay về trạng thái đang mở.
    const status = dec(totalFilled).gte(o.size)
      ? "filled"
      : o.status === "cancelled"
        ? "cancelled"
        : "partially_filled";
    await this.#fenced(r, async (tx) => {
      await tx
        .update(orders)
        .set({ filledSize: totalFilled, avgPrice, status })
        .where(eq(orders.id, o.id));
    });
    // SoDEX báo giá trung bình luỹ kế; phần mới khớp có giá riêng.
    const before = dec(o.avgPrice ?? "0").mul(o.filledSize);
    const price = dec(avgPrice).mul(totalFilled).sub(before).div(delta);
    await this.#feed(r, {
      type: "fill",
      at,
      clOrdID,
      price: (price.gt(0) ? price : dec(avgPrice)).toString(),
      quantity: delta.toString(),
      fee,
    });
  }

  /**
   * Fill của lệnh mà bot không có runner (đang pause / đã dừng / chưa nạp): ghi vào lệnh và sổ cái đã lưu của bot, như
   * đối soát làm (DEC-85), thay vì bỏ. Runner nạp sau đọc sổ cái này; đối soát sau thấy `filledSize` đã đủ nên không
   * cộng lại. Chỉ shard mình giữ, chỉ bot thật.
   */
  async #fillWithoutRunner(
    o: typeof orders.$inferSelect,
    totalFilled: string,
    avgPrice: string,
    fee: string,
    at: number,
  ): Promise<void> {
    const held = this.#leases.get(shardOf(o.sodexAccountId, this.#d.shards));
    if (held === undefined) return;
    const [b] = await this.#d.db
      .select({ mode: bots.mode })
      .from(bots)
      .where(eq(bots.id, o.botId))
      .limit(1);
    if (b?.mode !== "live") return;
    const shard = shardOf(o.sodexAccountId, this.#d.shards);
    const recorded = await this.#fenced({ shard, epoch: held.epoch }, async (tx) => {
      const [cur] = await tx.select().from(orders).where(eq(orders.id, o.id)).for("update");
      if (cur === undefined) return null;
      const delta = sub(totalFilled, cur.filledSize);
      if (!delta.gt(0)) return null;
      const status = dec(totalFilled).gte(cur.size)
        ? "filled"
        : ["open", "partially_filled", "unknown"].includes(cur.status)
          ? "partially_filled"
          : cur.status;
      await tx
        .update(orders)
        .set({ filledSize: totalFilled, avgPrice, status })
        .where(eq(orders.id, o.id));
      const before = dec(cur.avgPrice ?? "0").mul(cur.filledSize);
      const price = dec(avgPrice).mul(totalFilled).sub(before).div(delta);
      await this.#applyToSavedLedger(
        tx,
        cur,
        price.gt(0) ? price.toString() : avgPrice,
        delta,
        dec(fee),
        at,
      );
      return delta;
    });
    if (recorded !== null)
      this.#d.log.info(
        { botId: o.botId, clOrdID: o.clOrdId, quantity: recorded.toString() },
        "fill recorded for a bot without a runner",
      );
  }

  /** Bot không có runner: cộng fill thẳng vào sổ cái đã lưu (`bot_runtime`) để PnL đúng (DEC-85). */
  async #applyToSavedLedger(
    tx: Db,
    o: typeof orders.$inferSelect,
    price: string,
    delta: Decimal,
    fee: Decimal,
    now: number,
  ): Promise<void> {
    const [rt] = await tx
      .select({ state: botRuntime.state })
      .from(botRuntime)
      .where(eq(botRuntime.botId, o.botId))
      .limit(1);
    const state = rt?.state as
      (Record<string, unknown> & { ledger?: Ledger; perp?: Ledger; spot?: Ledger }) | undefined;
    if (state === undefined) return;
    if (isMultiMarketCopyState(state)) {
      // Copy Trade nhiều market (DEC-163): sổ cái nằm trong `markets[market]`.
      const slot = state.markets[o.market];
      if (slot === undefined) return;
      await tx
        .update(botRuntime)
        .set({
          state: {
            ...state,
            markets: {
              ...state.markets,
              [o.market]: { ...slot, ledger: applyFill(slot.ledger, o.side, price, delta, fee) },
            },
          },
          updatedAt: new Date(now),
        })
        .where(eq(botRuntime.botId, o.botId));
      return;
    }
    const key = state.ledger !== undefined ? "ledger" : o.engine === "perps" ? "perp" : "spot";
    const ledger = state[key];
    if (ledger === undefined) return;
    await tx
      .update(botRuntime)
      .set({
        state: {
          ...state,
          [key]: applyFill(ledger, o.side, price, delta, fee),
          // Khối lượng tính cả lệnh mở và lệnh đóng: lệnh đóng khi Stop cũng vào volume của phiên.
          ...(typeof state.volume === "string"
            ? { volume: dec(state.volume).add(delta.mul(price)).toString() }
            : {}),
        },
        updatedAt: new Date(now),
      })
      .where(eq(botRuntime.botId, o.botId));
  }

  /**
   * Account + các engine cần user stream (main.ts chỉ mở stream cho đúng các engine này, đóng phần còn lại): engine mà bot
   * thật của account giao dịch khi bot còn runner (starting / running / pausing / resuming / stopping, kể cả paused), cộng
   * account vừa Stop xong (STREAM_HOLD_MS) và account còn lệnh bot thật đang mở / `unknown` (DEC-308).
   */
  activeStreams(): Promise<{ account: AccountRef; engines: Set<"spot" | "perps"> }[]> {
    const seen = new Map<string, { account: AccountRef; engines: Set<"spot" | "perps"> }>();
    const add = (account: AccountRef, engines: Iterable<"spot" | "perps">) => {
      const cur = seen.get(account.id);
      seen.set(account.id, {
        // Runner giữ key mới nhất của account (Renew key, DEC-59): ưu tiên bản của runner.
        account: cur?.account ?? account,
        engines: new Set([...(cur?.engines ?? []), ...engines]),
      });
    };
    for (const r of this.#runners.values()) if (!r.paper) add(r.account, r.engines);
    const now = this.#d.now();
    for (const [id, h] of this.#streamHolds)
      if (h.until <= now) this.#streamHolds.delete(id);
      else add(h.account, h.engines);
    for (const o of this.#orderStreams.values()) add(o.account, o.engines);
    return Promise.resolve([...seen.values()]);
  }

  activeAccounts(): Promise<AccountRef[]> {
    const seen = new Map<string, AccountRef>();
    // Bot paper không cần user stream của SoDEX.
    for (const r of this.#runners.values()) if (!r.paper) seen.set(r.account.id, r.account);
    return Promise.resolve([...seen.values()]);
  }

  /** Mở user stream cho account của mọi bot thật trong shard, ngay trong vòng nạp bot (không đợi hết vòng). */
  #openStreams(shard: number): void {
    const streams = this.#d.userStreams;
    if (streams === undefined) return;
    for (const r of this.#runners.values())
      if (r.shard === shard && !r.paper) for (const e of r.engines) streams.open(r.account, e);
  }

  /**
   * User stream của account trên `engine` đã subscribe xong (bot paper / không có userStreams: luôn sẵn sàng). Fill của lệnh
   * gửi trước lúc đó không bao giờ tới (SoDEX không gửi lại), và lệnh IOC khớp ngay.
   */
  #streamReady(r: Runner, engine: "spot" | "perps"): boolean {
    const streams = this.#d.userStreams;
    if (r.paper || streams === undefined || streams.ready(r.account.id, engine)) {
      this.#streamWaitSince.delete(`${r.account.id}:${engine}`);
      return true;
    }
    const key = `${r.account.id}:${engine}`;
    const now = this.#d.now();
    const since = this.#streamWaitSince.get(key) ?? now;
    this.#streamWaitSince.set(key, since);
    if (now - (this.#streamWaitLog.get(key) ?? Number.NEGATIVE_INFINITY) >= 30_000) {
      this.#streamWaitLog.set(key, now);
      const fields = { accountId: r.account.id, botId: r.botId, engine, waitedMs: now - since };
      // Chờ lâu (subscribe bị từ chối lặp lại, SoDEX WS lỗi): cảnh báo thật, không chỉ info.
      if (now - since >= STREAM_WAIT_WARN_MS)
        this.#d.log.warn(
          fields,
          "bot still waits for its account's user stream before opening positions",
        );
      else
        this.#d.log.info(
          fields,
          "bot waits for its account's user stream before opening positions",
        );
    }
    return false;
  }

  /**
   * Bước chiến lược có lệnh làm tăng |vị thế| (`opensPosition`, theo sổ cái trong state trước bước và lệnh giảm đang chờ)
   * trên engine mà user stream chưa sẵn sàng (người dùng chốt, DEC-303). Không bao giờ giữ: `resumed`
   * (chỉ gửi một lần sau khi trạng thái đã commit, DEC-240) và bước có pause / stop.
   */
  #opensBeforeStream(
    r: Runner,
    event: StrategyEvent,
    actions: readonly StrategyAction[],
    pending: ReadonlyMap<string, Decimal>,
  ): boolean {
    if (event.type === "resumed") return false;
    if (actions.some((a) => a.type === "pause" || a.type === "stop")) return false;
    const reducing = new Map(pending);
    for (const a of actions) {
      if (a.type !== "place") continue;
      const o = a.order;
      const key = `${o.market}:${o.side}`;
      const before = (reducing.get(key) ?? dec("0")).toString();
      if (
        !this.#streamReady(r, o.engine) &&
        opensPosition(o, positionOf(r.state, o.market, o.engine), before)
      )
        return true;
      reducing.set(key, dec(before).add(o.quantity));
    }
    return false;
  }

  /** Khối lượng còn chờ (chưa khớp) của lệnh bot đang mở trên sổ, theo `market:chiều`. */
  async #pendingReducing(r: Runner): Promise<Map<string, Decimal>> {
    const out = new Map<string, Decimal>();
    const open = await this.#d.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.botId, r.botId),
          inArray(orders.status, ["open", "partially_filled", "unknown"]),
        ),
      );
    for (const o of open) {
      const key = `${o.market}:${o.side}`;
      out.set(key, (out.get(key) ?? dec("0")).add(dec(o.size).sub(o.filledSize)));
    }
    return out;
  }

  /** Dừng có trật tự: trả lease (C10). */
  async stop(): Promise<void> {
    this.#stopped = true;
    // Shard đang chạy dở: chờ xong (bước sau trong shard tự dừng vì `#stopped`), có giới hạn, rồi mới trả lease.
    await settleWithin([...this.#lanes.values()], STOP_WAIT_MS);
    this.#leaseSet.stop();
    for (const [shard, l] of this.#leases) {
      await l.lease.release();
      this.#dropShard(shard);
    }
    // Dừng êm: xoá key worker để worker kế tiếp nhận đủ phần shard ngay, không chia đôi với worker đã dừng tới khi key
    // hết hạn (`leaseTtlMs`).
    await this.#d.redis.del(`engine:worker:${this.#d.workerId}`);
  }

  /** Test: mô phỏng worker chết (không trả lease, không làm gì nữa). */
  kill(): void {
    this.#stopped = true;
    this.#leaseSet.stop();
  }

  // ---------- shards ----------

  async #manageShards(): Promise<void> {
    const { redis, workerId, leaseTtlMs, shards } = this.#d;
    await redis.set(`engine:worker:${workerId}`, String(this.#d.now()), "PX", leaseTtlMs);
    // Gia hạn lease đã giữ do timer của `LeaseSet` lo (mỗi ttl / 3, một round trip), không làm ở đây.
    this.#leaseSet.start();
    const workers = Math.max(1, (await redis.keys("engine:worker:*")).length);
    const target = Math.ceil(shards / workers);
    // Giữ quá phần của mình (sau khi có worker mới) thì trả bớt.
    while (this.#leases.size > target) {
      // Shard đang chạy dở (chờ SoDEX) không trả ở vòng này: trả khi nó xong.
      const shard = this.ownedShards.filter((x) => !this.#lanes.has(x)).at(-1);
      if (shard === undefined) break;
      await this.#leases.get(shard)?.lease.release();
      this.#dropShard(shard);
    }
    for (let shard = 0; shard < shards && this.#leases.size < target; shard += 1) {
      // Làn cũ của shard còn chạy (lease vừa mất): nhận lại khi làn đó xong (review #216 M1).
      if (this.#leases.has(shard) || this.#lanes.has(shard)) continue;
      const lease = new Lease(redis, `lease:shard:${String(shard)}`, leaseTtlMs);
      const sentAt = this.#clockMono();
      if (!(await lease.tick())) continue;
      const [row] = await this.#d.db
        .insert(shardEpochs)
        .values({ shard, epoch: 1, owner: workerId, acquiredAt: new Date(this.#d.now()) })
        .onConflictDoUpdate({
          target: shardEpochs.shard,
          set: {
            epoch: sql`${shardEpochs.epoch} + 1`,
            owner: workerId,
            acquiredAt: new Date(this.#d.now()),
          },
        })
        .returning({ epoch: shardEpochs.epoch });
      this.#leases.set(shard, { lease, epoch: row?.epoch ?? 0 });
      this.#leaseSet.add(shard, lease, sentAt);
      this.#d.log.info({ shard, epoch: row?.epoch, worker: workerId }, "shard acquired");
    }
  }

  #dropShard(shard: number): void {
    this.#leases.delete(shard);
    this.#leaseSet.delete(shard);
    for (const [id, r] of this.#runners) if (r.shard === shard) this.#runners.delete(id);
  }

  /** Transaction có fencing: epoch trong DB phải đúng epoch mình giữ. */
  async #fenced<T>(f: Pick<Runner, "shard" | "epoch">, work: (tx: Db) => Promise<T>): Promise<T> {
    return this.#d.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ epoch: shardEpochs.epoch })
        .from(shardEpochs)
        .where(eq(shardEpochs.shard, f.shard))
        .for("share");
      if (row?.epoch !== f.epoch) throw new FencedError(f.shard);
      return work(tx);
    });
  }

  // ---------- bots ----------

  #hasRunners(shard: number): boolean {
    for (const r of this.#runners.values()) if (r.shard === shard) return true;
    return false;
  }

  /**
   * Đọc một lần cho cả vòng (DEC-301): account, bot + version, version chờ, builder fee, lệnh `unknown`,
   * lệnh đang mở và lệnh Volume Farm huỷ chưa xác nhận; rồi chia theo shard. Số truy vấn không phụ thuộc số shard.
   */
  async #tickSnapshot(): Promise<TickSnapshot> {
    const { db, shards } = this.#d;
    const now = this.#d.now();
    const owned = new Set(this.#leases.keys());
    const snap: TickSnapshot = {
      accounts: new Map(),
      bots: new Map(),
      pending: new Map(),
      fees: new Map(),
      unknown: [],
      open: new Map(),
      unconfirmed: new Map(),
      backfill: new Map(),
      lookups: null,
    };
    if (owned.size === 0) return snap;
    const accountRows = await db
      .select({ account: sodexAccounts, key: apiKeys })
      .from(sodexAccounts)
      .innerJoin(
        apiKeys,
        and(eq(apiKeys.sodexAccountId, sodexAccounts.id), eq(apiKeys.status, "active")),
      )
      .where(eq(sodexAccounts.status, "connected"));
    const shardOfAccount = new Map<string, number>();
    for (const r of accountRows) {
      const shard = shardOf(r.account.id, shards);
      if (!owned.has(shard)) continue;
      shardOfAccount.set(r.account.id, shard);
      pushTo(snap.accounts, shard, {
        id: r.account.id,
        address: r.account.address as `0x${string}`,
        sodexAccountId: r.account.sodexAccountId,
        apiKeyId: r.key.id,
        apiKeyName: r.key.name,
      });
    }
    if (shardOfAccount.size > 0) {
      const list = await db
        .select({ bot: bots, version: botVersions })
        .from(bots)
        .innerJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
        .where(
          and(
            inArray(bots.sodexAccountId, [...shardOfAccount.keys()]),
            inArray(bots.state, [...ENGINE_ACTIVE_STATES]),
          ),
        );
      for (const x of list) {
        const shard = shardOfAccount.get(x.bot.sodexAccountId);
        if (shard !== undefined) pushTo(snap.bots, shard, x);
      }
      if (list.length > 0) {
        snap.fees = await this.#builderFeesOf(list.map((x) => x.bot.userId));
        // Version `pending` mới nhất của mỗi bot (DOMAIN.md mục 7.4): một truy vấn cho mọi bot, thay vì một truy vấn mỗi bot.
        const pending = await db
          .select()
          .from(botVersions)
          .where(
            and(
              inArray(
                botVersions.botId,
                list.map((x) => x.bot.id),
              ),
              eq(botVersions.status, "pending"),
            ),
          )
          .orderBy(desc(botVersions.version));
        for (const v of pending) if (!snap.pending.has(v.botId)) snap.pending.set(v.botId, v);
      }
    }
    // Lệnh SoDEX đã nhận mà đã được ghi cho người dùng (#unknownGaveUp, Decisions bền) thì không đọc lại mỗi vòng (danh
    // sách không lớn dần mãi). Không bỏ theo tuổi: lệnh chưa được ghi thì vẫn được tra tiếp, kể cả sau khởi động lại.
    snap.unknown = (
      await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.status, "unknown"),
            lt(orders.submittedAt, new Date(now - RECONCILE_AFTER_MS)),
            or(isNull(orders.sodexOrderId), isNull(orders.unknownGaveUpAt)),
          ),
        )
    ).filter((o) => owned.has(shardOf(o.sodexAccountId, shards)));
    // Chỉ lệnh của bot thật: lệnh paper không bao giờ được đối soát với SoDEX (DEC-105).
    const open = await db
      .select({ order: orders })
      .from(orders)
      .innerJoin(bots, eq(bots.id, orders.botId))
      .where(
        and(
          eq(bots.mode, "live"),
          inArray(orders.status, ["open", "partially_filled"]),
          lt(orders.submittedAt, new Date(now - RECONCILE_AFTER_MS)),
        ),
      )
      .orderBy(orders.submittedAt);
    for (const { order } of open) {
      const shard = shardOf(order.sodexAccountId, shards);
      if (owned.has(shard)) pushTo(snap.open, shard, order);
    }
    // Lệnh Volume Farm DRIFT tự huỷ nhưng chưa xác nhận: có thể đã khớp ngay trước lúc huỷ.
    const unconfirmed = await db
      .select({ order: orders })
      .from(orders)
      .innerJoin(bots, eq(bots.id, orders.botId))
      .where(
        and(
          eq(orders.status, "cancelled"),
          eq(bots.mode, "live"),
          eq(bots.strategy, Strategy.volumeFarm),
          isNull(orders.reconciledAt),
          gt(orders.submittedAt, new Date(now - UNCONFIRMED_CANCEL_MS)),
        ),
      );
    for (const { order } of unconfirmed) {
      const shard = shardOf(order.sodexAccountId, shards);
      if (owned.has(shard)) pushTo(snap.unconfirmed, shard, order);
    }
    // Đọc ứng viên lưới an toàn tối đa mỗi MAKER_BACKFILL_MS (nhịp đọc lịch sử khớp của lệnh nghi ngờ), trừ khi có khoảng
    // trống stream đã qua thời gian chờ (đọc một lần mỗi khoảng trống).
    // Khoảng trống đã đọc ứng viên một lần thì thôi (không đọc lại mỗi vòng trong suốt khoảng trống).
    const gapsDue = [...this.#streamGaps].filter(
      ([key, at]) =>
        now - at >= BACKFILL_TRADE_GRACE_MS &&
        now - at < STREAM_GAP_MS &&
        this.#gapCandidatesRead.get(key) !== at,
    );
    if (gapsDue.length > 0 || now - this.#backfillReadAt >= MAKER_BACKFILL_MS) {
      this.#backfillReadAt = now;
      for (const [key, at] of gapsDue) this.#gapCandidatesRead.set(key, at);
      for (const order of await this.#backfillCandidates(now))
        pushTo(snap.backfill, shardOf(order.sodexAccountId, shards), order);
    }
    // Account còn lệnh bot thật mở / `unknown`: user stream giữ mở dù bot không còn runner (đã Stop).
    const refs = new Map([...snap.accounts.values()].flat().map((a) => [a.id, a]));
    const streams = new Map<string, { account: AccountRef; engines: Set<"spot" | "perps"> }>();
    for (const o of [...[...snap.open.values()].flat(), ...snap.unknown]) {
      const account = refs.get(o.sodexAccountId);
      if (account === undefined) continue;
      const cur = streams.get(account.id) ?? { account, engines: new Set() };
      cur.engines.add(o.engine);
      streams.set(account.id, cur);
    }
    this.#orderStreams = streams;
    return snap;
  }

  /**
   * Đọc lại các dòng lệnh của snapshot ngay trước khi xử lý (một truy vấn): giữ dòng mới nhất, bỏ dòng đã đổi trạng thái
   * từ lúc chụp (user stream / bước khác đã cập nhật) để không xử lý theo số cũ.
   */
  async #fresh(list: readonly OrderRow[]): Promise<OrderRow[]> {
    if (list.length === 0) return [];
    const rows = await this.#d.db
      .select()
      .from(orders)
      .where(
        inArray(
          orders.id,
          list.map((o) => o.id),
        ),
      );
    const byId = new Map(rows.map((o) => [o.id, o]));
    return list.flatMap((o) => {
      const f = byId.get(o.id);
      return f?.status === o.status ? [f] : [];
    });
  }

  async #syncBots(shard: number, snap: TickSnapshot): Promise<void> {
    const held = this.#leases.get(shard);
    if (held === undefined) return;
    const accounts = snap.accounts.get(shard) ?? [];
    if (accounts.length === 0) return;
    const list = snap.bots.get(shard) ?? [];
    const fees = snap.fees;
    for (const { bot: snapped, version } of list) {
      // Trạng thái chuyển tiếp (pausing / resuming / stopping) có thể đã đổi từ lúc chụp: đọc lại dòng bot đó.
      const bot = TRANSITIONAL.has(snapped.state) ? await this.#botRow(snapped.id) : snapped;
      if (bot === undefined || !ENGINE_ACTIVE_STATES.includes(bot.state)) continue;
      const account = accounts.find((a) => a.id === bot.sodexAccountId);
      if (account === undefined) continue;
      let r = this.#runners.get(bot.id);
      if (r === undefined) {
        // Cùng khoá với fill tới khi chưa có runner: fill đó không ghi sổ cái đã lưu trong lúc #load đang đọc nó, mà chờ
        // runner rồi đi qua chiến lược (DEC-303).
        r = await this.#withBotLock(bot.id, async () => {
          const loaded = await this.#load(bot, version, account, shard, held.epoch);
          // Lease mất / đổi epoch trong lúc nạp: không thêm runner mang epoch cũ (review #216 M1).
          if (this.#leases.get(shard)?.epoch !== held.epoch) return undefined;
          if (loaded !== undefined) this.#runners.set(bot.id, loaded);
          return loaded;
        });
        if (r === undefined) continue;
      }
      // Team đổi builder fee của user (DEC-159): lệnh mới dùng mức mới ngay, chiến lược tính phí theo mức mới.
      const rate = builderFeeRateFor(bot.strategy, fees.get(bot.userId));
      if (rate !== r.builderRate) {
        r.builderRate = rate;
        if (this.#d.feeRate === undefined) {
          const route = { account: r.account, paper: r.paper };
          r.ctx = {
            ...r.ctx,
            feeRate: this.#feeRateOf(bot, r.config, r.ctx.rules, route, rate),
            takerFeeRate: this.#feeRateOf(bot, r.config, r.ctx.rules, route, rate, true),
          };
        }
      }
      // Key `active` mới nhất của account (Renew key, DEC-59): runner dùng key mới ngay, không cần nạp lại bot. Key mới thì
      // bỏ nấc chờ huỷ của key cũ (DEC-310).
      if (r.account.apiKeyId !== account.apiKeyId) {
        this.#cancelBackoff.delete(account.id);
        this.#cancelRetryAt.delete(r.botId);
      }
      r.account = r.paper ? { ...account, paper: true } : account;
      await this.#applyPendingVersion(r, snap.pending.get(r.botId), bot.state);
      if (bot.state === BotState.pausing)
        await this.#transition(r, EngineEvent.confirmedPaused, null);
      else if (bot.state === BotState.resuming && r.engines.every((x) => this.#streamReady(r, x))) {
        // Resume chờ user stream của các engine bot giao dịch (bot có thể là bot duy nhất của account, stream vừa mở): bot
        // dựng lại lệnh ngay khi chạy lại.
        // Lease chưa xác nhận: chưa xác nhận Running (bot giữ `resuming`, vòng sau thử lại), để `resumed` không bị bỏ sau
        // khi trạng thái đã commit.
        if (!(await this.#leaseConfirmed(shard))) continue;
        await this.#transition(r, EngineEvent.confirmedRunning, null);
        // Chiến lược tự pause (halted) chạy tiếp từ sổ cái và vị thế thật, dựng lại lệnh (DEC-240).
        const prices = Object.fromEntries(
          this.#marketsOf(r.market, r.config).flatMap((m) => {
            const p = this.#lastPrice.get(m);
            return p === undefined ? [] : [[m, p] as const];
          }),
        );
        await this.#feed(r, { type: "resumed", at: this.#d.now(), prices });
      }
      // Stop của người dùng: đóng vị thế của bot nếu họ chọn ở hộp thoại Stop (DEC-81).
      else if (bot.state === BotState.stopping) await this.#stopBot(r, null, bot.closeOnStop);
    }
  }

  /**
   * Chỗ DUY NHẤT chọn cổng đặt lệnh theo `mode` của bot (DEC-105). Bot paper nhận PaperGateway và account có cờ
   * `paper`, nên kể cả khi bị gọi nhầm, HttpGateway cũng từ chối. Thiếu PaperGateway thì không chạy bot paper.
   */
  #gatewayFor(
    mode: string,
    account: AccountRef,
  ): { gateway: Gateway; account: AccountRef; paper: boolean } | null {
    if (mode === "live") return { gateway: this.#d.gateway, account, paper: false };
    if (mode === "paper" && this.#d.paper !== undefined)
      return { gateway: this.#d.paper, account: { ...account, paper: true }, paper: true };
    return null;
  }

  async #load(
    bot: typeof bots.$inferSelect,
    version: typeof botVersions.$inferSelect,
    account: AccountRef,
    shard: number,
    epoch: number,
  ): Promise<Runner | undefined> {
    const entry = (
      STRATEGIES as Record<
        string,
        | { schema: { parse: (v: unknown) => unknown }; module: StrategyModule<unknown, unknown> }
        | undefined
      >
    )[bot.strategy];
    if (entry === undefined) {
      this.#d.log.warn({ botId: bot.id, strategy: bot.strategy }, "unknown strategy");
      return undefined;
    }
    const route = this.#gatewayFor(bot.mode, account);
    if (route === null) {
      this.#d.log.warn({ botId: bot.id, mode: bot.mode }, "no gateway for bot mode");
      return undefined;
    }
    // Cờ theo tài khoản chỉ chặn bot đang muốn CHẠY (starting / running / resuming). Bot đang pausing / stopping vẫn
    // nạp để runner hoàn tất Pause / Stop như thường (Pause giữ lệnh đang mở, DOMAIN.md mục 7.2); không thì bot kẹt
    // Pausing mãi (review #71, DEC-218). Paused / stopped không có trong ENGINE_ACTIVE_STATES.
    const wantsToRun = FLAG_GATED_STATES.has(bot.state);
    // Bot khối lượng chỉ chạy khi admin bật cho chủ tài khoản (DEC-80).
    if (wantsToRun && VOLUME.has(bot.strategy) && !(await this.#volumeBotsOn(bot.userId))) {
      this.#d.log.warn({ botId: bot.id }, "volume bots are not enabled for this user");
      return undefined;
    }
    // Chiến lược thử nghiệm: AI Adaptive DCA (DEC-107) theo cờ riêng; Copy Trade (DEC-161) theo cờ AI Desk
    // (DEC-192).
    if (
      wantsToRun &&
      (EXPERIMENTAL_STRATEGIES as readonly string[]).includes(bot.strategy) &&
      !(await (bot.strategy === Strategy.adaptiveDca
        ? this.#flagOn(bot.userId, "adaptiveDca")
        : this.#flagOn(bot.userId, "aiDesk")))
    ) {
      this.#d.log.warn({ botId: bot.id }, "experimental strategies are not enabled for this user");
      return undefined;
    }
    const config = entry.schema.parse(version.config);
    // Engine vừa nạp bot (khởi động lại, chuyển shard): tin khớp lúc không có stream đã mất.
    if (bot.strategy === Strategy.volumeFarm) this.onStreamGap(account.id, "perps");
    const [saved] = await this.#d.db
      .select()
      .from(botRuntime)
      .where(eq(botRuntime.botId, bot.id))
      .limit(1);
    const builderRate = builderFeeRateFor(bot.strategy, await this.#builderFees(bot.userId));
    const markets = this.#marketsOf(bot.market, config);
    const rules: Record<string, MarketRules> = {};
    for (const m of markets) {
      const rr = await this.#d.rules(m);
      if (rr !== undefined) rules[m] = rr;
    }
    // Đòn bẩy đã được SoDEX xác nhận cho đúng version này trước lần nạp lại: đọc lại SoDEX, khớp thì không ghi lại.
    const leverageKnown =
      saved?.leverageDone?.versionId === version.id
        ? new Set(saved.leverageDone.keys)
        : new Set<string>();
    return {
      botId: bot.id,
      account: route.account,
      paper: route.paper,
      // Bot thật: lời gọi SoDEX mang botId / accountId / traceId cho SoDEX Debugger (DEC-309).
      gateway: route.paper ? route.gateway : withBotCallContext(route.gateway, bot.id, account.id),
      shard,
      epoch,
      versionId: version.id,
      version: version.version,
      strategy: bot.strategy,
      builderRate,
      market: bot.market,
      config,
      state: saved?.versionId === version.id ? saved.state : entry.module.initialState(config),
      module: entry.module,
      ctx: {
        botId: bot.id,
        version: version.version,
        rules,
        feeRate: this.#d.feeRate ?? this.#feeRateOf(bot, config, rules, route, builderRate),
        // Engine ghi quyết định vào bot_events: chiến lược gắn dữ liệu kèm (snapshot tín hiệu Volume Farm, #221).
        decisionPayload: true,
        ...(this.#d.feeRate === undefined
          ? { takerFeeRate: this.#feeRateOf(bot, config, rules, route, builderRate, true) }
          : {}),
      },
      awaitingFirstAck: bot.state === BotState.starting,
      leverageSet: false,
      leverageUnknown: false,
      leverageDone: new Set(),
      leverageKnown,
      leverageRun: null,
      blocked: null,
      reduceRejects: 0,
      makerReduceRejects: 0,
      marginRejects: 0,
      marginRejectTimes: [],
      rejectLog: new Map(),
      skipGate: new SkipGate(),
      engines: bot.engine === "spot+perps" ? ["spot", "perps"] : [bot.engine],
      closeRetry: null,
      // Cảnh báo đã ghi trước lần nạp lại (khởi động lại, chuyển shard): giữ chặn, không ghi lại Decisions.
      positionMismatch: new Map(Object.entries(bot.positionMismatch ?? {})),
      mismatchWaitLogged: false,
      // `resumed` bị giữ vì lệch vị thế chỉ nhớ trong bộ nhớ: nạp lại một bot đang chạy, đang lệch mà chiến lược còn tự
      // dừng (halted) thì coi như còn nợ `resumed` (N1). Không áp cho bot không lệch: chiến lược vừa halted mà bot chưa
      // kịp sang pausing không được chạy lại.
      resumeOwed:
        bot.state === BotState.running &&
        Object.keys(bot.positionMismatch ?? {}).length > 0 &&
        saved?.versionId === version.id &&
        (saved.state as { phase?: unknown } | null)?.phase === "halted",
      appliedAt: version.appliedAt?.getTime() ?? null,
      resetDroppedPosition: false,
    };
  }

  /**
   * Version mới (`pending`, do api tạo khi sửa bot): huỷ lệnh đang mở, khởi tạo lại chiến lược với cấu hình
   * mới, đánh dấu version cũ superseded (DOMAIN.md mục 7.4, DEC-38). Lệnh mới đặt ở tick kế tiếp.
   * Chiến lược có `applyVersion` (Volume Farm) có thể hoãn: còn vị thế / lệnh vào / thoát đang chạy thì không huỷ
   * lệnh nào (stop trên SoDEX còn nguyên), version cũ chạy tiếp, ghi "Applying vN" một lần và thử lại mỗi vòng
   * (DEC-304).
   */
  async #applyPendingVersion(
    r: Runner,
    pending: VersionRow | undefined,
    botState: BotState,
  ): Promise<void> {
    // Không còn version chờ (đã áp / bị thay): bỏ cờ chặn lượt mới.
    if (pending === undefined || pending.version <= r.version) {
      if (r.ctx.versionPending !== undefined) delete r.ctx.versionPending;
      return;
    }
    const entry = (
      STRATEGIES as Record<
        string,
        | { schema: { parse: (v: unknown) => unknown }; module: StrategyModule<unknown, unknown> }
        | undefined
      >
    )[r.strategy];
    if (entry === undefined) return;
    const config = entry.schema.parse(pending.config);
    // Đọc lại mỗi lần: fill có thể tới trong lúc chờ DB / SoDEX bên dưới.
    const apply = (): unknown =>
      entry.module.applyVersion === undefined
        ? entry.module.initialState(config)
        : entry.module.applyVersion(config, r.state, r.ctx);
    if (apply() === null) {
      if (r.ctx.versionPending !== pending.version) {
        r.ctx = { ...r.ctx, versionPending: pending.version };
        const decision = `Applying v${String(pending.version)}`;
        // Một dòng cho mỗi version chờ, kể cả khi runner được nạp lại (khởi động lại, đổi shard); bot đang dừng thì
        // không ghi (nó không chờ lượt nào đóng nữa).
        const [last] = await this.#d.db
          .select({ decision: botEvents.decision })
          .from(botEvents)
          .where(and(eq(botEvents.botId, r.botId), eq(botEvents.type, "version")))
          .orderBy(desc(botEvents.occurredAt))
          .limit(1);
        if (botState !== BotState.stopping && last?.decision !== decision)
          await this.#event(
            r,
            "version",
            decision,
            `Waits until the open trade closes; v${String(r.version)} keeps managing it. No orders were cancelled.`,
            this.#d.now(),
          );
      }
      return;
    }
    const open = await this.#d.db
      .select({ clOrdId: orders.clOrdId })
      .from(orders)
      .where(and(eq(orders.botId, r.botId), inArray(orders.status, ["open", "partially_filled"])));
    await this.#cancel(
      r,
      open.map((o) => o.clOrdId),
    );
    // Fill tới trong lúc huỷ mở lại vị thế: chưa áp, vòng sau thử lại (lệnh vừa huỷ là lệnh của lúc bot còn phẳng).
    const fresh = apply();
    if (fresh === null) return;
    await this.#fenced(r, async (tx) => {
      // State mới ghi cùng lần đổi version: engine nạp lại ngay sau đó vẫn có danh sách lệnh v1 (fill đến muộn vẫn vào
      // sổ cái), không rơi về `initialState`.
      await tx
        .insert(botRuntime)
        .values({ botId: r.botId, versionId: pending.id, state: fresh, epoch: r.epoch })
        .onConflictDoUpdate({
          target: botRuntime.botId,
          set: { state: fresh, versionId: pending.id, epoch: r.epoch, updatedAt: new Date() },
        });
      await tx
        .update(botVersions)
        .set({ status: "superseded" })
        .where(and(eq(botVersions.botId, r.botId), eq(botVersions.status, "active")));
      // Version chờ cũ hơn (sửa lần nữa trong lúc chờ): không bao giờ được áp.
      await tx
        .update(botVersions)
        .set({ status: "superseded" })
        .where(
          and(
            eq(botVersions.botId, r.botId),
            eq(botVersions.status, "pending"),
            lt(botVersions.version, pending.version),
          ),
        );
      await tx
        .update(botVersions)
        .set({ status: "active", appliedAt: new Date(this.#d.now()) })
        .where(eq(botVersions.id, pending.id));
      await tx.update(bots).set({ activeVersionId: pending.id }).where(eq(bots.id, r.botId));
      await tx.insert(outbox).values({
        topic: `user.${r.account.id}.bot`,
        payload: { botId: r.botId, version: pending.version },
      });
    });
    // Sổ cái cũ còn vị thế Perps mà version mới bắt đầu lại từ `initialState` (N2).
    r.resetDroppedPosition =
      entry.module.applyVersion === undefined &&
      this.#perpMarketsOf(
        r.strategy,
        r.market,
        r.engines.includes("perps") ? "perps" : "spot",
        r.config,
      ).some((m) => {
        const p = positionOf(r.state, m, "perps");
        return p !== null && !dec(p).isZero();
      });
    r.versionId = pending.id;
    r.version = pending.version;
    r.appliedAt = this.#d.now();
    r.config = config;
    // Version đã ghi: fill tới ngay lúc ghi thì giữ state hiện tại (còn vị thế) và ghi lại ngay với version mới, không
    // bao giờ quên vị thế kể cả khi engine nạp lại.
    const settled = settleAppliedState(apply(), r.state, fresh);
    r.state = settled.state;
    if (settled.save)
      await this.#fenced(r, async (tx) => {
        await tx
          .update(botRuntime)
          .set({ state: r.state, versionId: pending.id, epoch: r.epoch, updatedAt: new Date() })
          .where(eq(botRuntime.botId, r.botId));
      });
    r.ctx = { ...r.ctx, version: pending.version };
    delete r.ctx.versionPending;
    r.leverageSet = false;
    r.leverageDone = new Set();
    r.leverageKnown = new Set();
    await this.#event(
      r,
      "version",
      `Applied v${String(pending.version)}`,
      `Cancelled ${String(open.length)} orders; new orders follow on the next price.`,
      this.#d.now(),
    );
  }

  /** Market mà bot cần giá (Funding Arb / Rebalancing dùng nhiều market). */
  #marketsOf(market: string, config: unknown): string[] {
    const c = config as {
      spotMarket?: string;
      perpMarket?: string;
      assets?: { market?: string }[];
    };
    const out = new Set<string>([market]);
    // Copy Trade nhiều market (DEC-163).
    for (const m of copyMarkets(config as Record<string, unknown>)) out.add(m);
    if (c.spotMarket !== undefined) out.add(c.spotMarket);
    if (c.perpMarket !== undefined) out.add(c.perpMarket);
    for (const a of c.assets ?? []) if (a.market !== undefined) out.add(a.market);
    return [...out];
  }

  #watches(r: Runner, market: string): boolean {
    return Object.prototype.hasOwnProperty.call(r.ctx.rules, market);
  }

  async #flagOn(userId: string, flag: "aiDesk" | "adaptiveDca"): Promise<boolean> {
    const [u] = await this.#d.db
      .select({ on: flag === "aiDesk" ? users.aiDesk : users.adaptiveDca })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return u?.on === true;
  }

  async #volumeBotsOn(userId: string): Promise<boolean> {
    const [u] = await this.#d.db
      .select({ on: users.volumeBots })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return u?.on === true;
  }

  async #botRow(botId: string): Promise<BotRow | undefined> {
    const [b] = await this.#d.db.select().from(bots).where(eq(bots.id, botId)).limit(1);
    return b;
  }

  async #currentState(botId: string): Promise<BotState | undefined> {
    const [b] = await this.#d.db
      .select({ state: bots.state })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);
    return b?.state;
  }

  /** Đưa event cho chiến lược (chỉ khi bot đang chạy), lưu state, thực hiện hành động. */
  async #feed(r: Runner, incoming: StrategyEvent): Promise<void> {
    let event = incoming;
    const state = await this.#currentState(r.botId);
    const live =
      state === BotState.starting || state === BotState.running || state === BotState.resuming;
    // Fill / ack vẫn được ghi khi đang pause để sổ cái đúng; giá mới và nhịp đồng hồ thì không xử lý.
    // Tín hiệu leader cũng vậy: bot copy chạy lại thì `leaderPosition` kế tiếp bù phần đã đóng / giảm (DEC-161).
    if (
      !live &&
      (event.type === "tick" ||
        event.type === "timer" ||
        event.type === "leaderFill" ||
        event.type === "leaderPosition" ||
        // Giá Binance cũng vậy: bot đang pause giữ nguyên lệnh đang mở (DOMAIN 7.2).
        event.type === "fair" ||
        event.type === "book")
    )
      return;
    // Bot Perps: đặt đòn bẩy + margin mode trên SoDEX trước khi chiến lược phản ứng với thị trường. Fill / ack /
    // reject vẫn đi qua để sổ cái đúng; nếu chúng sinh lệnh mới thì #execute chặn lần nữa.
    const accounting =
      event.type === "fill" ||
      event.type === "orderAck" ||
      event.type === "orderReject" ||
      event.type === "orderDone" ||
      event.type === "positionSync";
    // Lease của shard chưa xác nhận lại được, hoặc shard không còn là của mình (runner zombie, engine đã dừng)
    // (DEC-302): chưa phản ứng với thị trường, sự kiện sau thử lại. Fill / ack vẫn ghi (fencing epoch
    // ở DB chặn nếu shard đã sang worker khác). `resumed` đi sau một chuyển trạng thái đã commit nên không bỏ ở đây
    // (#syncBots kiểm tra lease trước khi chuyển).
    if (!accounting && event.type !== "resumed" && !(await this.#leaseConfirmed(r.shard))) return;
    // Đang backoff vì request trước chưa rời DRIFT: chưa phản ứng với thị trường (fill / ack vẫn ghi).
    if (!accounting && r.blocked !== null && event.at < r.blocked.nextAt) return;
    if (live && !accounting && !r.leverageSet) {
      const lev = await this.#ensureLeverage(r, event.at);
      if (lev === "rejected") await this.#pauseBot(r, ReasonCode.orderRejected);
      if (lev !== "ok") return;
    }
    // User stream của một engine bot giao dịch chưa sẵn sàng: đọc lệnh giảm đang chờ TRƯỚC bước chiến lược, để giữa bước
    // và lúc gán `r.state` không có await nào (fill tới cùng lúc không bị ghi đè, review #208 R1).
    const reducing =
      !accounting && event.type !== "resumed" && r.engines.some((e) => !this.#streamReady(r, e))
        ? await this.#pendingReducing(r)
        : null;
    // `resumed` bị giữ vì lệch vị thế (DEC-306): sự kiện thị trường kế tiếp chạy lại `resumed` (giá
    // mới nhất) thay cho chính nó, để chiến lược tự pause dựng lại lệnh khi bước không còn bị giữ.
    if (r.resumeOwed && live && !accounting && event.type !== "resumed") {
      const prices = Object.fromEntries(
        this.#marketsOf(r.market, r.config).flatMap((m) => {
          const p = this.#lastPrice.get(m);
          return p === undefined ? [] : [[m, p] as const];
        }),
      );
      event = { type: "resumed", at: event.at, prices };
    }
    // Vị thế thật lệch sổ cái (DEC-306): lệnh giảm đang chờ đọc TRƯỚC bước (như cổng stream).
    const mismatchReducing =
      !accounting && r.positionMismatch.size > 0
        ? (reducing ?? (await this.#pendingReducing(r)))
        : null;
    // Volume Farm: giá tốt nhất SoDEX mới nhất (bộ nhớ) vào state trước bước này, giữ đúng giờ nhận để tuổi sổ là tuổi
    // thật. Chỉ đổi state trong bộ nhớ; được ghi DB cùng bước này nếu bước có gì để ghi (DEC-298).
    if (r.strategy === Strategy.volumeFarm && !accounting) {
      const live = this.#farmBooks.get(r.market);
      if (live !== undefined && live.at > (this.#farmBookFed.get(r) ?? -Infinity)) {
        this.#farmBookFed.set(r, live.at);
        r.state = r.module.step(
          r.config,
          r.state,
          { type: "book", at: live.at, market: r.market, bid: live.bid, ask: live.ask },
          r.ctx,
        ).state;
      }
    }
    const prev = r.state;
    const result = r.module.step(r.config, r.state, event, r.ctx);
    // Nhịp đồng hồ chưa tới hạn: chiến lược trả lại đúng state cũ, không có gì để ghi.
    if (event.type === "timer" && result.state === prev && result.actions.length === 0) return;
    // Sự kiện thị trường muốn mở / tăng vị thế khi user stream của engine đó chưa subscribe xong: bỏ cả bước (state không
    // đổi), nhịp sau chiến lược quyết lại. Bước chỉ giảm vị thế / đóng / stop vẫn đi (DEC-303).
    if (reducing !== null && this.#opensBeforeStream(r, event, result.actions, reducing)) return;
    // Lệch vị thế (DEC-306): bước theo thị trường (hoặc `resumed`) có lệnh làm tăng |vị thế thật| bị
    // bỏ CẢ bước, state không đổi (không bao giờ gửi một phần bước, ví dụ một chân của Funding Arb), nhịp sau chiến lược
    // quyết lại. Không báo gì cho chiến lược (không `orderReject` → không pause, không `orderDone` → không lặp vòng / không
    // lệnh "ma"). Fill / ack và bước chỉ giảm / đóng / stop luôn đi.
    if (mismatchReducing !== null && this.#opensBeyondReal(r, result.actions, mismatchReducing)) {
      if (event.type === "resumed") r.resumeOwed = true;
      if (!r.mismatchWaitLogged) {
        r.mismatchWaitLogged = true;
        this.#d.log.info(
          { botId: r.botId, markets: [...r.positionMismatch.keys()], event: event.type },
          "strategy step held: it would add to a position that does not match the ledger; waiting",
        );
      }
      return;
    }
    if (event.type === "resumed") r.resumeOwed = false;
    r.state = result.state;
    // Bot copy tiền thật: lệnh mở vừa khớp → thêm outbox trong CÙNG transaction (DEC-212).
    const opened = this.#copyAlerts(r, () =>
      openedAlerts(r.botId, r.config, prev, result.state, event),
    );
    await this.#fenced(r, async (tx) => {
      for (const data of opened)
        await tx.insert(outbox).values({
          topic: "jobs.notify",
          payload: {
            sodexAccountId: r.account.id,
            type: "copy_bot_opened",
            data,
            dedupeKey: `copy_bot_opened:${data.botId}:${data.clOrdID}`,
          },
        });
      await tx
        .insert(botRuntime)
        .values({
          botId: r.botId,
          versionId: r.versionId,
          state: r.state,
          epoch: r.epoch,
        })
        .onConflictDoUpdate({
          target: botRuntime.botId,
          set: {
            state: r.state,
            versionId: r.versionId,
            epoch: r.epoch,
            updatedAt: new Date(),
          },
        });
    });
    // Bot đang start mà tick đầu không đặt lệnh nào (ví dụ chờ trigger): không có gì để SoDEX ack.
    if (
      r.awaitingFirstAck &&
      event.type === "tick" &&
      !result.actions.some((x) => x.type === "place")
    ) {
      await this.#ack(r, event.at);
    }
    // Sự kiện thị trường: nếu lệnh chưa rời DRIFT thì hoàn tác bước này (state cũ, xoá dòng lệnh tạm) để thử lại.
    await this.#execute(r, result.actions, event.at, accounting ? null : prev, {
      event,
      prev,
      produced: result.state,
    });
  }

  /**
   * Bot Spot hoặc SoDEX đã xác nhận → "ok". Đọc thiết lập hiện tại trước (account state `S`): đã đúng thì
   * không ghi. Bị từ chối → "rejected" (caller pause `ORDER_REJECTED`). Lần ghi trước không rõ kết quả →
   * chỉ gửi lại khi đọc được SoDEX và thấy chưa áp dụng (quy tắc 1.7). Chưa rời DRIFT → "not_sent" + backoff.
   */
  async #ensureLeverage(
    r: Runner,
    at: number,
  ): Promise<"ok" | "rejected" | "unknown" | "not_sent"> {
    // Sự kiện tới cùng lúc (giá, Binance, nhịp) chờ chung một lần đặt (CP-01: trước đây BTC-USD ghi 7 lần trong 2 s).
    const prev = r.leverageRun;
    if (prev?.versionId === r.versionId) return prev.p;
    // Lượt của version cũ còn đang gửi: chờ nó xong (bỏ qua kết quả) rồi mới đặt cho version mới. Nếu chạy chồng, SoDEX có
    // thể áp lệnh mới trước, lệnh cũ sau: account ở đòn bẩy cũ mà engine tưởng là mới. Không tốn thêm request.
    const p =
      prev === null
        ? this.#ensureLeverageAll(r, at)
        : prev.p.catch(() => undefined).then(() => this.#ensureLeverageAll(r, at));
    const run = { versionId: r.versionId, p };
    r.leverageRun = run;
    try {
      return await run.p;
    } finally {
      if (r.leverageRun === run) r.leverageRun = null;
    }
  }

  async #ensureLeverageAll(
    r: Runner,
    at: number,
  ): Promise<"ok" | "rejected" | "unknown" | "not_sent"> {
    // Copy Trade đặt cùng đòn bẩy cho mọi market (DEC-163); chiến lược khác có tối đa một symbol. Market đã xác nhận thì
    // bỏ qua; Decisions ghi một dòng gộp cho các market vừa xác nhận (CP-01).
    // Version đổi giữa chừng (áp version mới reset leverageSet / leverageDone): kết quả của lần này thuộc version cũ,
    // không được đánh dấu xong cho version mới; nhịp sau đặt lại theo cấu hình mới.
    const versionId = r.versionId;
    const done = r.leverageDone;
    const specs = leverageSpecsOf(r.strategy, r.market, r.config);
    const confirmed: LeverageSpec[] = [];
    const log = async () => {
      const first = confirmed[0];
      if (first === undefined) return;
      const what = `${String(first.leverage)}× ${first.marginMode} on ${confirmed.map((x) => x.market).join(", ")}`;
      await this.#event(r, "decision", "Leverage set", leverageWhy(r.paper, what), at);
      // Lưu lại để lần nạp lại runner (chuyển shard, khởi động lại) cùng version không đặt / ghi lại. Chỉ khi version
      // chưa đổi giữa chừng (version mới bắt đầu lại từ tập rỗng).
      if (r.versionId === versionId) await this.#saveLeverageDone(r, versionId, done);
    };
    for (const spec of specs) {
      const key = `${spec.market}:${String(spec.leverage)}:${spec.marginMode}`;
      if (done.has(key)) continue;
      const read = { matched: false };
      const res = await this.#ensureLeverageOne(r, spec, at, read);
      if (r.versionId !== versionId) {
        await log();
        return "not_sent";
      }
      if (res !== "ok") {
        await log();
        r.leverageSet = false;
        return res;
      }
      done.add(key);
      // Đã xác nhận trước lần nạp lại và SoDEX vẫn đúng như vậy: không ghi thêm dòng "Leverage set".
      if (!(read.matched && r.leverageKnown.has(key))) confirmed.push(spec);
    }
    await log();
    if (r.versionId !== versionId) return "not_sent";
    r.leverageSet = true;
    return "ok";
  }

  /** Ghi tập đòn bẩy đã xác nhận của version vào `bot_runtime` (tạo dòng với state hiện tại nếu chưa có). */
  async #saveLeverageDone(r: Runner, versionId: string, done: ReadonlySet<string>): Promise<void> {
    const leverageDone = { versionId, keys: [...done] };
    await this.#fenced(r, (tx) =>
      tx
        .insert(botRuntime)
        .values({ botId: r.botId, versionId, state: r.state, epoch: r.epoch, leverageDone })
        .onConflictDoUpdate({ target: botRuntime.botId, set: { leverageDone } }),
    );
  }

  async #ensureLeverageOne(
    r: Runner,
    spec: LeverageSpec,
    at: number,
    /** `matched` = SoDEX đã đúng thiết lập này, không gửi gì. */
    read: { matched: boolean } = { matched: false },
  ): Promise<"ok" | "rejected" | "unknown" | "not_sent"> {
    const what = `${String(spec.leverage)}× ${spec.marginMode} on ${spec.market}`;
    let current: { leverage: number; marginMode: string } | null | undefined;
    let position: { leverage: number; marginMode: string } | null = null;
    try {
      const read = await r.gateway.readLeverage(r.account, spec.market);
      current = read.setting;
      position = read.position;
    } catch {
      current = undefined;
    }
    if (current?.leverage === spec.leverage && current.marginMode === spec.marginMode) {
      r.leverageUnknown = false;
      read.matched = true;
      return "ok";
    }
    // Vị thế đang mở trên symbol với thiết lập khác: không đổi đòn bẩy của cả account (DEC-58), không retry.
    if (
      position !== null &&
      (position.leverage !== spec.leverage || position.marginMode !== spec.marginMode)
    ) {
      await this.#event(
        r,
        "error",
        "Leverage not changed",
        `Open ${spec.market} position at ${String(position.leverage)}× ${position.marginMode}.`,
        at,
      );
      return "rejected";
    }
    if (r.leverageUnknown && current === undefined) {
      this.#d.log.warn({ botId: r.botId }, "leverage result unknown and SoDEX unreadable; waiting");
      return "unknown";
    }
    const res = await r.gateway.setLeverage(r.account, spec, {
      shard: r.shard,
      epoch: r.epoch,
    });
    r.leverageUnknown = res.outcome === "unknown";
    if (res.outcome === "ok") {
      r.blocked = null;
    } else if (res.outcome === "rejected") {
      await this.#event(
        r,
        "error",
        "Leverage not set",
        `SoDEX rejected ${what} (code ${res.code}). No orders were sent.`,
        at,
      );
    } else if (res.outcome === "not_sent") {
      await this.#notSent(r, res.code, at);
    } else {
      this.#d.log.warn({ botId: r.botId }, "leverage update result unknown; reconciling next");
    }
    return res.outcome;
  }

  /**
   * Request chưa rời DRIFT. Key không dùng được → pause mọi bot của account (`API_KEY_UNUSABLE`). Lỗi tạm
   * (signer / Vault) → backoff; quá 5 lần hoặc 5 phút thì pause bot với event lỗi kèm mã.
   */
  async #notSent(r: Runner, code: NotSentCode, at: number): Promise<void> {
    if (code === "key_unusable" || code === "key_not_active") {
      r.blocked = null;
      await this.#event(
        r,
        "error",
        "Can't sign with your API key",
        `DeskLabs can't sign with your API key (${code}). Nothing was sent to SoDEX. Renew it in Settings › SoDEX access.`,
        at,
      );
      await this.pauseAccount(r.account.id, ReasonCode.apiKeyUnusable);
      return;
    }
    const b = r.blocked ?? { since: at, attempts: 0, nextAt: at, code };
    const attempts = b.attempts + 1;
    if (attempts > NOT_SENT_BACKOFF.maxAttempts || at - b.since >= NOT_SENT_BACKOFF.maxMs_total) {
      r.blocked = null;
      await this.#event(
        r,
        "error",
        code === "market_info_unavailable"
          ? "Paused: could not read SoDEX market info"
          : "Paused: could not reach the signer",
        `Nothing was sent to SoDEX after ${String(attempts)} attempts (${code}).`,
        at,
      );
      await this.#pauseBot(r, ReasonCode.orderRejected);
      return;
    }
    const wait = Math.min(NOT_SENT_BACKOFF.firstMs * 2 ** (attempts - 1), NOT_SENT_BACKOFF.maxMs);
    r.blocked = { since: b.since, attempts, nextAt: at + wait, code };
    this.#d.log.warn(
      { botId: r.botId, code, attempts, waitMs: wait },
      "request not sent; backing off",
    );
  }

  async #execute(
    r: Runner,
    actions: readonly StrategyAction[],
    at: number,
    /** State trước bước chiến lược, để hoàn tác khi lệnh chưa rời DRIFT (sự kiện thị trường); null = không hoàn tác. */
    rollback: unknown = null,
    /**
     * Sự kiện và state trước bước chiến lược (để biết market của tin `copy_bot_skipped`), và state bước này sinh ra
     * (`produced`): chỉ hoàn tác khi `r.state` vẫn đúng là state đó.
     */
    source: { event: StrategyEvent; prev: unknown; produced: unknown } | null = null,
  ): Promise<void> {
    let places = actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
    // Một lần kiểm tra lease, TRƯỚC mọi tác dụng phụ (DEC-302). Bước chiến lược theo thị trường (có
    // `rollback`) mà lease không xác nhận được: hoàn tác bước (state cũ trong bộ nhớ và DB), không ghi / gửi / huỷ gì; sự
    // kiện sau sinh lại đúng các lệnh này (clOrdID tất định). Fill / ack (rollback null) và lệnh engine tự dựng (Stop,
    // #stopBot tự kiểm tra trước) không chặn ở đây: fencing epoch ở DB và signer bảo vệ.
    // Trong lúc chờ gia hạn (tối đa vài giây), fill / ack có thể đã được xử lý và đổi state: khi đó không hoàn tác (sẽ ghi
    // đè sổ cái), đi tiếp và dựa vào fencing epoch như với fill / ack.
    if (
      rollback !== null &&
      actions.length > 0 &&
      source?.event.type !== "resumed" &&
      !(await this.#leaseConfirmed(r.shard))
    ) {
      if (r.state === source?.produced) {
        await this.#restoreState(r, rollback);
        throw new LeaseExpiredError(r.shard);
      }
      this.#d.log.warn(
        { botId: r.botId, shard: r.shard },
        "lease not confirmed but state moved on; sending under epoch fencing",
      );
    }
    const cancels = actions.flatMap((a) => (a.type === "cancel" ? [a.clOrdID] : []));
    // BD-02: quyết định ghi cùng bước với lệnh đặt mang clOrdID của các lệnh đó, để Decisions hiện kết quả (Filled /
    // Cancelled / Rejected / Open) theo trạng thái lệnh thật.
    const placed = places.length === 0 ? undefined : { orders: places.map((o) => o.clOrdID) };
    for (const a of actions) {
      if (a.type === "log") {
        // Bot copy tiền thật bỏ qua tín hiệu: thêm outbox trong CÙNG transaction ghi bot_events
        // (DEC-212). Tối đa 1 tin / bot / market / 10 phút.
        // market_off (trader giao dịch ở market không có trong bot): chỉ ghi nhật ký, không gửi tin (PM chốt 4b).
        const skipped =
          a.decision === "Skipped" && source !== null && skipReason(a.why) !== "market_off"
            ? this.#copyAlerts(r, () => {
                const market = skipMarket(r.config, source.prev, source.event);
                return r.skipGate.allow(market, at)
                  ? [skippedAlert(r.botId, market, a.why, at)]
                  : [];
              })
            : [];
        await this.#event(
          r,
          "decision",
          a.decision,
          a.why,
          at,
          async (tx) => {
            for (const data of skipped)
              await tx.insert(outbox).values({
                topic: "jobs.notify",
                payload: {
                  sodexAccountId: r.account.id,
                  type: "copy_bot_skipped",
                  data,
                  dedupeKey: `copy_bot_skipped:${data.botId}:${data.market ?? "*"}:${String(data.at)}`,
                },
              });
          },
          this.#decisionPayload(r, placed, a.payload),
        );
      }
      if (a.type === "flag")
        await this.#fenced(r, (tx) =>
          tx.update(bots).set({ needsAttention: a.needsAttention }).where(eq(bots.id, r.botId)),
        );
    }
    // Rút lệnh vì giá Binance đã chạy qua: ghi Decisions lúc SoDEX xác nhận, kèm giờ Binance của chính lần cập nhật này.
    const binanceAt = source?.event.type === "fair" ? source.event.binanceAt : undefined;
    if (cancels.length > 0) await this.#cancel(r, cancels, binanceAt);
    for (const a of actions) if (a.type === "modifyStop") await this.#modifyStop(r, a, at);
    // Chốt cứng: lệnh Perps mở vị thế không bao giờ được gửi khi SoDEX chưa xác nhận đòn bẩy của bot.
    if (!r.leverageSet && places.some((o) => o.engine === "perps" && !o.reduceOnly)) {
      const lev = await this.#ensureLeverage(r, at);
      if (lev !== "ok") {
        if (lev !== "not_sent") await this.#pauseBot(r, ReasonCode.orderRejected);
        return;
      }
    }
    // Bot vừa được yêu cầu dừng trong lúc bước chiến lược này chạy (DEC-255): đọc lại trạng thái ngay trước khi gửi, không
    // gửi lệnh mở vị thế của chiến lược. Trước đây chỉ kiểm tra ở đầu sự kiện: một sự kiện giá bắt đầu trước lúc Stop vẫn
    // đặt được lệnh mua sau lúc Stop, khớp khi bot đã dừng và vị thế nằm lại không ai đóng. Chỉ áp cho bước chiến lược
    // (`source`): lệnh đóng do engine dựng khi Stop (`#stopBot`, Spot không reduce-only) luôn đi. Chỉ khi đang dừng / đã
    // dừng; bot pause giữ hành vi cũ.
    if (source !== null && places.some((o) => !o.reduceOnly)) {
      const st = await this.#currentState(r.botId);
      if (st === BotState.stopping || st === BotState.stopped) {
        const dropped = places.filter((o) => !o.reduceOnly);
        places = places.filter((o) => o.reduceOnly);
        this.#d.log.info(
          { botId: r.botId, state: st, dropped: dropped.length },
          "opening orders not sent: bot is stopping",
        );
        // Báo chiến lược để nó không coi các lệnh này là đang sống. Không báo tiếp nếu chính bước này là phản hồi của một
        // lần báo như vậy (không lặp); bot đang dừng nên lệnh pause của chiến lược (nếu có) không đổi trạng thái.
        const echo = source.event.type === "orderReject" && source.event.code === "BOT_NOT_RUNNING";
        if (!echo)
          for (const o of dropped)
            await this.#feed(r, {
              type: "orderReject",
              at,
              clOrdID: o.clOrdID,
              code: "BOT_NOT_RUNNING",
            });
      }
    }
    if (places.length > 0) {
      // Bối cảnh lúc đặt (#233) dựng trước, ghi cùng dòng `unknown` (không thêm lần ghi, không đổi lệnh gửi đi).
      const contexts = this.#orderContexts(r, actions);
      // Ghi trước (unknown) rồi mới gửi; đã có (chạy lại sau chuyển shard) thì không gửi lại.
      const fresh = await this.#fenced(r, async (tx) => {
        const inserted = await tx
          .insert(orders)
          .values(
            places.map((o) => ({
              botId: r.botId,
              sodexAccountId: r.account.id,
              clOrdId: o.clOrdID,
              market: o.market,
              engine: o.engine,
              side: o.side,
              type: o.type,
              timeInForce: o.timeInForce,
              price: o.price ?? null,
              size: o.quantity,
              status: "unknown" as const,
              reduceOnly: o.reduceOnly,
              tag: o.tag,
              epoch: r.epoch,
              submittedAt: new Date(at),
              context: contexts.get(o.clOrdID) ?? null,
            })),
          )
          .onConflictDoNothing()
          .returning({ clOrdId: orders.clOrdId });
        return new Set(inserted.map((x) => x.clOrdId));
      });
      // Giới hạn per-trade (Risk Center, server chặn) và chống self-trade: bị chặn thì không tới SoDEX.
      const candidates = places.filter((o) => fresh.has(o.clOrdID));
      const perTrade = await this.#perTradeBlocked(r, candidates);
      const selfTrade = await this.#selfTradeBlocked(
        r,
        candidates.filter((o) => !perTrade.includes(o)),
      );
      const blocked = [...perTrade, ...selfTrade];
      for (const o of blocked) {
        const self = selfTrade.includes(o);
        const code = self ? "SELF_TRADE_BLOCKED" : "RISK_PER_TRADE";
        await this.#fenced(r, (tx) =>
          tx
            .update(orders)
            .set({ status: "rejected", rejectCode: code })
            .where(and(eq(orders.sodexAccountId, r.account.id), eq(orders.clOrdId, o.clOrdID))),
        );
        await this.#event(
          r,
          "risk",
          `Blocked ${o.side} ${o.quantity} ${o.market}`,
          self
            ? "It would have traded with your own open order (SELF_TRADE_BLOCKED)."
            : "Order is larger than the per-trade risk limit.",
          at,
        );
        await this.#feed(r, { type: "orderReject", at, clOrdID: o.clOrdID, code });
      }
      const toSend = places.filter((o) => fresh.has(o.clOrdID) && !blocked.includes(o));
      if (toSend.length > 0) {
        const results = await r.gateway.submit(
          r.account,
          toSend,
          { shard: r.shard, epoch: r.epoch },
          r.builderRate,
        );
        const notSent = results.filter(
          (x): x is Extract<typeof x, { outcome: "not_sent" }> => x.outcome === "not_sent",
        );
        const firstNotSent = notSent[0];
        if (
          firstNotSent !== undefined &&
          rollback !== null &&
          notSent.length === results.length &&
          // Fill / ack đã đổi state trong lúc gửi: không hoàn tác (sẽ ghi đè sổ cái); xử lý như từng lệnh not_sent.
          r.state === source?.produced
        ) {
          // Không lệnh nào rời DRIFT (signer lỗi): hoàn tác bước chiến lược và xoá dòng lệnh tạm. clOrdID tất
          // định nên lần thử sau (sau backoff) sinh lại đúng các lệnh này.
          const ids = toSend.map((o) => o.clOrdID);
          r.state = rollback;
          // clOrdID tất định: lần đặt lại sau backoff không được bị một lệnh huỷ cũ đang chờ huỷ mất (DEC-254).
          for (const id of ids) {
            this.#pendingCancels.get(r.botId)?.delete(id);
            this.#inflightCancels.delete(id);
          }
          await this.#fenced(r, async (tx) => {
            await tx
              .delete(orders)
              .where(
                and(
                  eq(orders.sodexAccountId, r.account.id),
                  inArray(orders.clOrdId, ids),
                  eq(orders.status, "unknown"),
                ),
              );
            await tx
              .update(botRuntime)
              .set({ state: r.state, updatedAt: new Date() })
              .where(eq(botRuntime.botId, r.botId));
          });
          await this.#notSent(r, firstNotSent.code, at);
          return;
        }
        if (notSent.length < results.length) r.blocked = null;
        // Báo lý do trước (vd `API_KEY_UNUSABLE` cho cả account), rồi mới đưa orderReject cho chiến lược.
        // Lệnh đóng của Stop (`source` null) có đường thử lại riêng (#sendCloses): không backoff / pause / ghi lỗi ở đây.
        if (firstNotSent !== undefined && source !== null)
          await this.#notSent(r, firstNotSent.code, at);
        let reduceRejected: {
          o: OrderIntent;
          res: { code: string; message: string | null };
        } | null = null;
        let marginRejected: { o: OrderIntent | undefined; message: string | null } | null = null;
        for (const res of results) {
          if (res.outcome === "ok") {
            r.marginRejects = 0;
            const sentOk = toSend.find((o) => o.clOrdID === res.clOrdID);
            if (sentOk?.reduceOnly === true && sentOk.stop === undefined) {
              r.reduceRejects = 0;
              r.makerReduceRejects = 0;
            }
            await this.#fenced(r, async (tx) => {
              const where = and(
                eq(orders.sodexAccountId, r.account.id),
                eq(orders.clOrdId, res.clOrdID),
              );
              await tx
                .update(orders)
                .set({ sodexOrderId: res.orderId, ackedAt: new Date(at) })
                .where(where);
              // User stream có thể đã báo khớp / bị từ chối trước response này: không ghi đè về "open" (DEC-122).
              await tx
                .update(orders)
                .set({ status: "open" })
                .where(and(where, eq(orders.status, "unknown")));
            });
            await this.#ack(r, at);
            await this.#feed(r, { type: "orderAck", at, clOrdID: res.clOrdID });
            // Chiến lược đã rút lệnh này lúc nó còn đang gửi (DEC-254): huỷ ngay khi SoDEX nhận.
            if (this.#pendingCancels.get(r.botId)?.has(res.clOrdID) === true)
              try {
                await this.#cancel(r, [res.clOrdID]);
              } catch (error) {
                // Lệnh vẫn trong danh sách chờ huỷ, vòng sau thử lại; các kết quả còn lại của lô vẫn phải được ghi.
                if (error instanceof FencedError && !(error instanceof LeaseExpiredError))
                  throw error;
                this.#d.log.warn({ err: error, botId: r.botId }, "cancel after ack failed");
              }
          } else if (res.outcome === "not_sent") {
            // Chưa rời DRIFT: không phải `unknown`, không cần đối soát. Ghi not_placed để sổ lệnh đúng.
            await this.#fenced(r, (tx) =>
              tx
                .update(orders)
                .set({ status: "not_placed", rejectCode: res.code })
                .where(
                  and(eq(orders.sodexAccountId, r.account.id), eq(orders.clOrdId, res.clOrdID)),
                ),
            );
            await this.#feed(r, { type: "orderReject", at, clOrdID: res.clOrdID, code: res.code });
          } else if (res.outcome === "rejected") {
            await this.#fenced(r, (tx) =>
              tx
                .update(orders)
                .set({ status: "rejected", rejectCode: res.code, rejectMessage: res.message })
                .where(
                  and(eq(orders.sodexAccountId, r.account.id), eq(orders.clOrdId, res.clOrdID)),
                ),
            );
            const sent = toSend.find((o) => o.clOrdID === res.clOrdID);
            this.#d.log.warn(
              { botId: r.botId, clOrdID: res.clOrdID, code: res.code, message: res.message },
              r.paper ? "paper order rejected (simulated)" : "order rejected by SoDEX",
            );
            if (!r.paper) await this.#logReject(r, res.code, res.message, sent, at);
            // Đếm trước khi báo chiến lược: bước chiến lược có thể gửi tiếp lệnh mới trong cùng lượt.
            const margin = isInsufficientMarginReject(res.code, res.message);
            if (margin) {
              r.marginRejects += 1;
              r.marginRejectTimes.push(this.#d.now());
              marginRejected = { o: sent, message: res.message };
            }
            await this.#feed(r, {
              type: "orderReject",
              at,
              clOrdID: res.clOrdID,
              code: res.code,
              ...(margin ? { insufficientMargin: true } : {}),
              ...(res.message == null || res.message.trim() === ""
                ? {}
                : { message: res.message.trim() }),
            });
            // Stop loss gốc bị từ chối (DEC-118) không phải lệnh đóng thật: chiến lược tự giữ SL, không pause.
            if (sent?.reduceOnly === true && sent.stop === undefined)
              reduceRejected = { o: sent, res };
          } else
            await this.#fenced(r, (tx) =>
              tx.insert(outbox).values({
                topic: "jobs.notify",
                payload: {
                  sodexAccountId: r.account.id,
                  type: "unknown_order",
                  data: { botId: r.botId, clOrdID: res.clOrdID },
                },
              }),
            );
          // unknown: giữ nguyên, #reconcile sẽ đối soát; không gửi lại (quy tắc 1.7).
        }
        if (marginRejected !== null && (await this.#marginRejected(r, marginRejected, at))) return;
        if (
          reduceRejected !== null &&
          (await this.#reduceOnlyRejected(r, reduceRejected.o, reduceRejected.res, at))
        )
          return;
      }
    }
    const halt = actions.find(
      (a): a is Extract<StrategyAction, { type: "pause" | "stop" }> =>
        a.type === "pause" || a.type === "stop",
    );
    if (halt?.type === "pause") await this.#pauseBot(r, halt.reason);
    if (halt?.type === "stop") await this.#stopBot(r, halt.reason, halt.close);
  }

  readonly #riskCache = new Map<
    string,
    { at: number; equity: string | null; perTradePct: string | null }
  >();

  /**
   * Chống self-trade (VOLUME_MAKER.md mục 17.3.1; SoDEX không có STP): lệnh limit mua phải thấp hơn ask thấp nhất,
   * lệnh bán phải cao hơn bid cao nhất trong các lệnh đang mở của **cả account** trên market đó (mọi bot) và của
   * chính batch này. Mỗi account chỉ có một writer (shard lease) nên không có race.
   */
  async #selfTradeBlocked(r: Runner, list: readonly OrderIntent[]): Promise<OrderIntent[]> {
    const limits = list.filter((o) => o.type === "limit" && o.price !== undefined);
    if (limits.length === 0) return [];
    const batch = new Set(list.map((o) => o.clOrdID));
    const markets = [...new Set(limits.map((o) => o.market))];
    const open = (
      await this.#d.db
        .select({
          clOrdId: orders.clOrdId,
          market: orders.market,
          side: orders.side,
          price: orders.price,
        })
        .from(orders)
        .innerJoin(bots, eq(bots.id, orders.botId))
        .where(
          and(
            eq(orders.sodexAccountId, r.account.id),
            // Lệnh paper không nằm trên sổ SoDEX: bot thật chỉ so với lệnh thật, bot paper chỉ so với lệnh của chính nó.
            r.paper ? eq(orders.botId, r.botId) : eq(bots.mode, "live"),
            inArray(orders.market, markets),
            inArray(orders.status, ["open", "partially_filled", "unknown"]),
          ),
        )
    ).filter((x) => !batch.has(x.clOrdId) && x.price !== null);
    const blocked: OrderIntent[] = [];
    for (const o of limits) {
      const price = dec(o.price ?? "0");
      const others = [
        ...open
          .filter((x) => x.market === o.market)
          .map((x) => ({ side: x.side, price: x.price ?? "0" })),
        ...limits
          .filter((x) => x !== o && x.market === o.market && !blocked.includes(x))
          .map((x) => ({ side: x.side, price: x.price ?? "0" })),
      ];
      const crosses = others.some((x) =>
        o.side === "buy"
          ? x.side === "sell" && price.gte(x.price)
          : x.side === "buy" && price.lte(x.price),
      );
      if (crosses) blocked.push(o);
    }
    return blocked;
  }

  async #perTradeBlocked(r: Runner, list: readonly OrderIntent[]): Promise<OrderIntent[]> {
    if (list.length === 0) return [];
    const now = this.#d.now();
    let c = this.#riskCache.get(r.account.id);
    if (c === undefined || now - c.at > 30_000) {
      const [limits] = await this.#d.db
        .select({ perTradePct: riskLimits.perTradePct })
        .from(riskLimits)
        .where(eq(riskLimits.sodexAccountId, r.account.id))
        .limit(1);
      const [snap] = await this.#d.db
        .select({ equity: equitySnapshots.equity })
        .from(equitySnapshots)
        .where(eq(equitySnapshots.sodexAccountId, r.account.id))
        .orderBy(desc(equitySnapshots.at))
        .limit(1);
      c = { at: now, equity: snap?.equity ?? null, perTradePct: limits?.perTradePct ?? null };
      this.#riskCache.set(r.account.id, c);
    }
    if (c.equity === null || c.perTradePct === null) return [];
    const { equity, perTradePct } = c;
    return list.filter((o) => {
      const price = o.price ?? this.#lastPrice.get(o.market);
      return (
        price !== undefined &&
        exceedsPerTrade(dec(price).mul(o.quantity).toString(), equity, perTradePct)
      );
    });
  }

  /**
   * Lệnh reduce-only bị từ chối: thường do vị thế trên SoDEX đã đóng hoặc nhỏ hơn sổ của bot. Quá
   * `MAX_REDUCE_ONLY_REJECTS` lần liên tiếp thì pause `ORDER_REJECTED` kèm câu lỗi SoDEX. Trả true khi đã pause.
   */
  async #reduceOnlyRejected(
    r: Runner,
    o: OrderIntent,
    res: { code: string; message: string | null },
    at: number,
  ): Promise<boolean> {
    // Lệnh đóng khi Stop chỉ gửi một lần và bot đang dừng: không pause, câu lỗi đã lưu trên dòng lệnh.
    if (o.tag === "close") return false;
    const market = o.type === "market";
    if (market) r.reduceRejects += 1;
    else r.makerReduceRejects += 1;
    const limit = market ? MAX_REDUCE_ONLY_REJECTS : MAX_MAKER_REDUCE_REJECTS;
    if ((market ? r.reduceRejects : r.makerReduceRejects) < limit) return false;
    r.reduceRejects = 0;
    r.makerReduceRejects = 0;
    const sodex =
      res.message === null ? `SoDEX code ${res.code}` : `SoDEX code ${res.code}: ${res.message}`;
    await this.#event(
      r,
      "error",
      `Paused: SoDEX rejected ${String(limit)} reduce-only orders in a row`,
      `Last: ${o.side} ${o.quantity} ${o.market} (${sodex}). Your ${o.market} position on SoDEX may already be closed or smaller than the bot expects. Check Positions on SoDEX before you resume.`,
      at,
    );
    await this.#pauseBot(r, ReasonCode.orderRejected);
    return true;
  }

  /**
   * Lệnh bị SoDEX từ chối vì thiếu margin: đủ `MAX_MARGIN_REJECTS` lần liên tiếp hoặc `MARGIN_REJECTS_IN_WINDOW` lần
   * trong `MARGIN_REJECT_WINDOW_MS` thì pause `ORDER_REJECTED` (thông báo + Needs you như mọi pause), không gửi lại mãi
   * (quy tắc 1.7). Lệnh đang mở được giữ (DOMAIN.md 7.2); Resume chạy tiếp như các pause khác. Trả true khi đã pause.
   */
  async #marginRejected(
    r: Runner,
    last: { o: OrderIntent | undefined; message: string | null },
    at: number,
  ): Promise<boolean> {
    const since = this.#d.now() - MARGIN_REJECT_WINDOW_MS;
    r.marginRejectTimes = r.marginRejectTimes.filter((t) => t > since);
    if (
      r.marginRejects < MAX_MARGIN_REJECTS &&
      r.marginRejectTimes.length < MARGIN_REJECTS_IN_WINDOW
    )
      return false;
    const n = Math.max(r.marginRejects, r.marginRejectTimes.length);
    r.marginRejects = 0;
    r.marginRejectTimes = [];
    // Bot đã pause / đang dừng (vd một bước lồng nhau đã pause): không ghi trùng, để phần còn lại của #execute chạy như cũ.
    const st = await this.#currentState(r.botId);
    if (st === undefined || applyReason(st, ReasonCode.orderRejected) === null) return false;
    this.#d.log.warn(
      { botId: r.botId, rejects: n, message: last.message },
      "pausing bot: SoDEX rejected orders for insufficient margin",
    );
    const what =
      last.o === undefined ? "" : ` Last: ${last.o.side} ${last.o.quantity} ${last.o.market}.`;
    await this.#event(
      r,
      "error",
      MARGIN_PAUSE_WHY,
      `SoDEX rejected ${String(n)} orders for insufficient margin (SoDEX code -1: ${last.message ?? "insufficient margin"}).${what}`,
      at,
    );
    await this.#pauseBot(r, ReasonCode.orderRejected);
    return true;
  }

  /**
   * Ghi Decisions khi SoDEX từ chối lệnh vì lý do thật (mọi mã trừ `NORMAL_REJECT_CODES`), tối đa một dòng mỗi lý do
   * trong `REJECT_LOG_WINDOW_MS`, kèm số lần trong cửa sổ đó: một cơn từ chối liên tục không làm ngập Decisions.
   * Loại `error` nên cũng hiện trong "Recent errors"; số đếm "Refused by SoDEX" (BD-05) vẫn đọc từ bảng `orders`.
   */
  async #logReject(
    r: Runner,
    code: string,
    message: string | null,
    o: { side: string; quantity?: string; size?: string; market: string } | undefined,
    at: number,
  ): Promise<void> {
    const normal: readonly string[] = Object.values(NORMAL_REJECT_CODES);
    if (normal.includes(code)) return;
    const text = message?.trim() ?? "";
    const reason = text === "" ? code : text;
    const key = `${code}|${reason}`;
    const now = this.#d.now();
    const entry = r.rejectLog.get(key) ?? { times: [], loggedAt: null };
    entry.times = entry.times.filter((t) => t > now - REJECT_LOG_WINDOW_MS);
    entry.times.push(now);
    r.rejectLog.set(key, entry);
    if (entry.loggedAt !== null && now - entry.loggedAt < REJECT_LOG_WINDOW_MS) return;
    entry.loggedAt = now;
    const qty = o?.quantity ?? o?.size;
    const last = o === undefined || qty === undefined ? "" : ` Last: ${o.side} ${qty} ${o.market}.`;
    // DeskLabs tự từ chối (market không có trên SoDEX): không nói là SoDEX từ chối, không có mã SoDEX.
    if (code === MARKET_NOT_FOUND) {
      await this.#event(
        r,
        "error",
        `DeskLabs didn't send the order: ${o?.market ?? r.market} is not listed on SoDEX.`,
        last.trim(),
        at,
      );
      return;
    }
    await this.#event(
      r,
      "error",
      rejectLogText(reason, entry.times.length),
      `SoDEX code ${code}.${last}`,
      at,
    );
  }

  async #ack(r: Runner, at: number): Promise<void> {
    if (!r.awaitingFirstAck) return;
    r.awaitingFirstAck = false;
    await this.#transition(
      r,
      EngineEvent.confirmedRunning,
      null,
      // Bot paper không gửi gì lên SoDEX: không được ghi là SoDEX đã xác nhận (DEC-105).
      r.paper
        ? "Simulated orders placed. Nothing was sent to SoDEX."
        : "SoDEX acknowledged the first orders.",
      at,
    );
  }

  /**
   * Dời giá kích hoạt của stop loss gốc trên SoDEX (DEC-118). Chỉ gửi khi lệnh còn mở trong sổ của DRIFT. SoDEX từ
   * chối thì báo `orderReject` để chiến lược bỏ stop đó và tự giữ SL; không rõ kết quả thì để lần dời sau gửi lại.
   */
  async #modifyStop(
    r: Runner,
    a: Extract<StrategyAction, { type: "modifyStop" }>,
    at: number,
  ): Promise<void> {
    const [row] = await this.#d.db
      .select()
      .from(orders)
      .where(and(eq(orders.sodexAccountId, r.account.id), eq(orders.clOrdId, a.clOrdID)))
      .limit(1);
    if (row?.status !== "open") return;
    const res = await r.gateway.modifyStop(
      r.account,
      { clOrdID: a.clOrdID, market: row.market, stopPrice: a.stopPrice },
      { shard: r.shard, epoch: r.epoch },
    );
    if (res.outcome === "rejected") {
      this.#d.log.warn(
        { botId: r.botId, clOrdID: a.clOrdID, code: res.code },
        "stop modify rejected by SoDEX",
      );
      await this.#feed(r, { type: "orderReject", at, clOrdID: a.clOrdID, code: res.code });
    }
  }

  /** Lúc sớm nhất được huỷ lại của account đang trong nấc chờ (huỷ bị từ chối cả request); null = huỷ được ngay. */
  #cancelBlockedUntil(accountId: string, now: number): number | null {
    const b = this.#cancelBackoff.get(accountId);
    return b !== undefined && now < b.until ? b.until : null;
  }

  /**
   * Ghi kết quả huỷ của account (DEC-310): mọi kết quả là "SoDEX từ chối cả request" (envelope lỗi) →
   * tăng nấc chờ 5 s → 15 s → 60 s, warn một lần mỗi nấc; có kết quả theo từng lệnh → về 0.
   */
  #noteCancelResults(accountId: string, results: readonly CancelResult[]): void {
    if (results.length === 0) return;
    const refused = results.filter(
      (x): x is Extract<CancelResult, { outcome: "rejected" }> =>
        x.outcome === "rejected" && x.scope === "request",
    );
    if (refused.length < results.length) {
      if (results.some((x) => x.outcome !== "unknown")) this.#cancelBackoff.delete(accountId);
      return;
    }
    const prev = this.#cancelBackoff.get(accountId) ?? { n: 0, until: 0, warned: 0 };
    const n = prev.n + 1;
    const step = Math.min(n, CANCEL_REQUEST_BACKOFF_MS.length);
    const delay = CANCEL_REQUEST_BACKOFF_MS[step - 1] ?? 60_000;
    const now = this.#d.now();
    this.#cancelBackoff.set(accountId, {
      n,
      until: now + delay,
      warned: Math.max(prev.warned, step),
    });
    if (step > prev.warned)
      this.#d.log.warn(
        { accountId, code: refused[0]?.code, refusals: n, retryInMs: delay },
        "SoDEX refused the cancel request; cancelling again after a backoff",
      );
  }

  async #cancel(
    r: Runner,
    clOrdIDs: readonly string[],
    /** Giờ Binance của lần cập nhật giá gây ra lần huỷ này (ghi Decisions khi SoDEX xác nhận); thiếu = không ghi. */
    binanceAt?: number,
  ): Promise<void> {
    const rows = await this.#d.db
      .select()
      .from(orders)
      .where(and(eq(orders.sodexAccountId, r.account.id), inArray(orders.clOrdId, [...clOrdIDs])));
    const open = rows.filter((o) => o.status === "open" || o.status === "partially_filled");
    // Một Set dùng chung cho mọi lần huỷ của bot (DEC-254): hai lần huỷ chạy song song từng giữ hai Set riêng, lần xong
    // sau với Set rỗng xoá luôn mục của lần kia và lệnh chờ huỷ bị mất (lệnh mồ côi nằm tới lúc quét).
    let pending = this.#pendingCancels.get(r.botId);
    if (pending === undefined) {
      pending = new Set<string>();
      this.#pendingCancels.set(r.botId, pending);
    }
    // Lệnh đặt còn đang gửi (chưa có dòng, hoặc `unknown` chưa được nhận): giữ chờ huỷ, huỷ khi lệnh được nhận (DEC-254).
    const startedAt = this.#d.now();
    const inflight = clOrdIDs.filter((id) => {
      const row = rows.find((o) => o.clOrdId === id);
      if (row !== undefined && !(row.status === "unknown" && row.ackedAt === null)) {
        this.#inflightCancels.delete(id);
        return false;
      }
      const since = this.#inflightCancels.get(id) ?? startedAt;
      if (startedAt - since >= CANCEL_INFLIGHT.maxMs) {
        this.#inflightCancels.delete(id);
        return false;
      }
      this.#inflightCancels.set(id, since);
      return true;
    });
    // Không còn gì mở: bỏ khỏi danh sách chờ huỷ lại.
    for (const id of clOrdIDs)
      if (!open.some((o) => o.clOrdId === id) && !inflight.includes(id)) pending.delete(id);
    for (const id of inflight) pending.add(id);
    if (inflight.length > 0)
      this.#cancelRetryAt.set(r.botId, startedAt - CANCEL_RETRY_MS + CANCEL_NOT_BOOKED.retryMs);
    if (open.length === 0) {
      return;
    }
    // Huỷ của account đang bị SoDEX từ chối cả request (key thu hồi, nonce, 429…): chờ hết nấc chờ, giữ chờ huỷ (DEC-TBD-
    // engine-rest-budget). Không gửi gì nên lệnh vẫn `open`, đối soát vẫn chạy.
    const waitUntil = this.#cancelBlockedUntil(r.account.id, startedAt);
    if (waitUntil !== null) {
      for (const o of open) pending.add(o.clOrdId);
      this.#cancelRetryAt.set(r.botId, waitUntil - CANCEL_RETRY_MS);
      return;
    }
    let results: Awaited<ReturnType<Gateway["cancel"]>>;
    try {
      results = await r.gateway.cancel(
        r.account,
        open.map((o) => ({ clOrdID: o.clOrdId, market: o.market, engine: o.engine })),
        { shard: r.shard, epoch: r.epoch },
      );
    } catch (error) {
      // Request huỷ không rời DRIFT (signer lỗi…): lệnh vẫn sống trên SoDEX, giữ "open" và thử lại ở vòng sau.
      for (const o of open) pending.add(o.clOrdId);
      throw error;
    }
    // Huỷ không thành (SoDEX từ chối hoặc không rõ): ghi log để lần ra vì sao lệnh còn sống trên sàn. `not_found` có
    // đường riêng ở dưới.
    this.#noteCancelResults(r.account.id, results);
    for (const x of results)
      if (
        x.outcome !== "ok" &&
        x.outcome !== "not_found" &&
        !(x.outcome === "rejected" && x.scope === "request")
      )
        this.#d.log.warn(
          {
            botId: r.botId,
            clOrdID: x.clOrdID,
            outcome: x.outcome,
            code: x.outcome === "rejected" ? x.code : undefined,
            detail: x.outcome === "unknown" ? x.detail : undefined,
          },
          "cancel not confirmed",
        );
    // Rút lệnh theo giá Binance: ghi Decisions lúc SoDEX xác nhận huỷ, kèm khoảng cách từ lúc Binance chạy.
    if (binanceAt !== undefined) {
      const done = this.#d.now();
      for (const x of results) {
        if (x.outcome !== "ok") continue;
        const o = open.find((y) => y.clOrdId === x.clOrdID);
        if (o === undefined) continue;
        await this.#event(
          r,
          "decision",
          `${o.side === "sell" ? "Ask" : "Bid"} cancelled`,
          `SoDEX confirmed the cancel at ${clockTime(done)} UTC, ${String(done - binanceAt)} ms after the move on Binance.`,
          done,
        );
      }
    }
    // OrderNotFound: lệnh vừa được nhận (< CANCEL_NOT_BOOKED.windowMs) có thể chưa vào sổ (DEC-250): huỷ lại sớm, trước
    // khi nó kịp vào sổ và nằm đó. Lệnh cũ hơn không còn trên sổ (đã khớp / đã huỷ): lần huỷ xong, không huỷ lại; lệnh
    // giữ trong danh sách chờ huỷ (không gửi lại) để #reconcileOpen đọc trạng thái cuối ở lượt tới: fill thật nếu có, không
    // thì cancelled; không bao giờ thành `unknown` (DEC-308).
    const now = this.#d.now();
    const isNotFound = (x: CancelResult) =>
      x.outcome === "not_found" ||
      (x.outcome === "unknown" && x.detail?.includes("OrderNotFound") === true);
    const unbooked = (x: CancelResult) => {
      const row = open.find((y) => y.clOrdId === x.clOrdID);
      const since = (row?.ackedAt ?? row?.submittedAt)?.getTime();
      return since !== undefined && now - since < CANCEL_NOT_BOOKED.windowMs;
    };
    const notBooked = results.some((x) => isNotFound(x) && unbooked(x));
    if (notBooked)
      this.#cancelRetryAt.set(r.botId, now - CANCEL_RETRY_MS + CANCEL_NOT_BOOKED.retryMs);
    let gone = this.#cancelGone.get(r.botId);
    for (const x of results) {
      if (x.outcome !== "not_found") continue;
      if (unbooked(x)) {
        this.#d.log.info(
          { botId: r.botId, clOrdID: x.clOrdID },
          "cancel: order not on the SoDEX book yet; cancelling again shortly",
        );
        continue;
      }
      if (gone === undefined) {
        gone = new Set<string>();
        this.#cancelGone.set(r.botId, gone);
      }
      this.#goneCancelAt.set(x.clOrdID, now);
      if (gone.has(x.clOrdID)) continue;
      gone.add(x.clOrdID);
      const row = open.find((y) => y.clOrdId === x.clOrdID);
      // Đối soát ở lượt #reconcileOpen kế tiếp, không chờ nhịp OPEN_CHECK_MS.
      if (row !== undefined) this.#openChecks.delete(row.id);
      this.#d.log.info(
        { botId: r.botId, clOrdID: x.clOrdID },
        "cancel: order no longer on the SoDEX book; reconciling its final status",
      );
    }
    // Chỉ coi là đã huỷ khi SoDEX trả lời rõ: ok, hoặc từ chối (lệnh đã khớp / đã huỷ). Không rõ thì thử lại; không thấy
    // trên sổ thì chờ đối soát (ở trên).
    // Request bị từ chối cả gói (429, key, nonce…) không nói gì về lệnh: như chưa rõ, huỷ lại sau (review #216 F1).
    const settled = new Set(
      results
        .filter(
          (x) =>
            x.outcome !== "unknown" &&
            x.outcome !== "not_found" &&
            !(x.outcome === "rejected" && x.scope === "request"),
        )
        .map((x) => x.clOrdID),
    );
    const done = open.filter((o) => settled.has(o.clOrdId));
    for (const o of open) {
      if (settled.has(o.clOrdId)) pending.delete(o.clOrdId);
      else pending.add(o.clOrdId);
    }
    if (done.length > 0)
      await this.#fenced(r, (tx) =>
        tx
          .update(orders)
          .set({ status: "cancelled" })
          .where(
            inArray(
              orders.id,
              done.map((o) => o.id),
            ),
          ),
      );
    // Market Making tính khối lượng còn treo của lệnh đóng cho tới khi SoDEX xác nhận đã gỡ (DEC-100).
    if (r.strategy !== Strategy.volumeMaker) return;
    const at = this.#d.now();
    for (const res of results) {
      const o = open.find((x) => x.clOrdId === res.clOrdID);
      // Đánh dấu đã báo: tin CANCELED tới sau từ user stream không báo lần hai.
      if (res.outcome === "ok" && o !== undefined && (await this.#markDone(r, o.id)))
        await this.#feed(r, { type: "orderDone", at, clOrdID: res.clOrdID });
    }
  }

  async #transition(
    r: Runner,
    event: EngineEvent,
    reason: Reason | null,
    /** `why` của event "Running" / "Paused"; null với Pause / Resume của người dùng. */
    why: string | null = null,
    at: number = this.#d.now(),
  ): Promise<void> {
    await this.#fenced(r, async (tx) => {
      const [b] = await tx
        .select({ state: bots.state })
        .from(bots)
        .where(eq(bots.id, r.botId))
        .for("update");
      if (b === undefined) return;
      const next = applyEngineEvent(b.state, event);
      if (next === null) return;
      await tx
        .update(bots)
        .set({
          state: next,
          ...(reason === null ? {} : { reasonCode: reason }),
          ...(next === BotState.stopped ? { positionMismatch: null } : {}),
        })
        .where(eq(bots.id, r.botId));
      await tx.insert(outbox).values({
        topic: `user.${r.account.id}.bot`,
        payload: { botId: r.botId, state: next, reasonCode: reason },
      });
      // Mốc Runtime (BD-06): Start, Resume và Pause của người dùng đều ghi event "Running" / "Paused" cùng transaction với
      // lần đổi trạng thái, để Runtime của lần chạy tính đúng (trước đây Pause / Resume của người dùng không ghi gì).
      if (next === BotState.running || next === BotState.paused)
        await tx.insert(botEvents).values({
          botId: r.botId,
          type: "state",
          decision: next === BotState.running ? "Running" : "Paused",
          why,
          occurredAt: new Date(at),
        });
      // Báo team (DEC-184): bot tiền thật vào running sau một lần Start (starting → running; resume không báo).
      // Vốn tính sẵn ở đây (cùng hàm với Strategy Lab); jobs chỉ hiển thị.
      if (!r.paper && b.state === BotState.starting && next === BotState.running) {
        const cap = botCapitalOf(r.strategy, r.config);
        await tx.insert(outbox).values({
          topic: "jobs.team_ops",
          payload: {
            type: "team_bot_started",
            botId: r.botId,
            capital: cap.capital,
            capitalAsset:
              cap.capital === null ? null : cap.capitalUnit === "base" ? assetOf(r.market) : "USDC",
          },
        });
      }
      if (reason !== null)
        await tx.insert(outbox).values({
          topic: "jobs.notify",
          payload: {
            sodexAccountId: r.account.id,
            type: next === "stopped" ? "bot_stopped" : "bot_paused",
            data: { botId: r.botId, reasonCode: reason, ...(r.paper ? { paper: true } : {}) },
          },
        });
    });
  }

  /** pause giữ lệnh đang mở (DOMAIN.md mục 7.2). */
  async #pauseBot(r: Runner, reason: Reason): Promise<void> {
    const changed = await this.#fenced(r, async (tx) => {
      const [b] = await tx
        .select({ state: bots.state })
        .from(bots)
        .where(eq(bots.id, r.botId))
        .for("update");
      const next = b === undefined ? null : applyReason(b.state, reason);
      if (next === null) return false;
      await tx.update(bots).set({ state: next, reasonCode: reason }).where(eq(bots.id, r.botId));
      await tx.insert(outbox).values({
        topic: `user.${r.account.id}.bot`,
        payload: { botId: r.botId, state: next, reasonCode: reason },
      });
      await tx.insert(outbox).values({
        topic: "jobs.notify",
        payload: {
          sodexAccountId: r.account.id,
          type: next === "stopped" ? "bot_stopped" : "bot_paused",
          data: { botId: r.botId, reasonCode: reason, ...(r.paper ? { paper: true } : {}) },
        },
      });
      return true;
    });
    // Chỉ ghi "Paused" khi state thật sự đổi: bot đang stopping / stopped / paused nhận thêm lệnh pause (ví dụ lệnh
    // reduce-only bị từ chối lúc Stop) thì `applyReason` trả null và không có gì xảy ra (DEC-256).
    if (changed) await this.#event(r, "state", "Paused", reason, this.#d.now());
  }

  /** stop huỷ lệnh của bot rồi (nếu cấu hình) đóng vị thế bằng lệnh reduce-only (DOMAIN.md mục 7.2). */
  async #stopBot(r: Runner, reason: Reason | null, closeIn: boolean): Promise<void> {
    let close = closeIn;
    // Chiến lược dừng trong lúc người dùng đang Stop kèm "Close position" (bot `stopping`, closeOnStop = true): giữ lựa
    // chọn của người dùng (keep_base của chiến lược không bỏ được lệnh đóng người dùng đã chọn). Chỉ đọc khi `stopping`:
    // closeOnStop của lần Stop cũ không được reset lúc Start.
    if (reason !== null && !close) {
      const [b] = await this.#d.db
        .select({ state: bots.state, closeOnStop: bots.closeOnStop })
        .from(bots)
        .where(eq(bots.id, r.botId));
      close = b?.state === BotState.stopping && b.closeOnStop;
    }
    const open = await this.#d.db
      .select({ clOrdId: orders.clOrdId })
      .from(orders)
      .where(and(eq(orders.botId, r.botId), inArray(orders.status, ["open", "partially_filled"])));
    await this.#cancel(
      r,
      open.map((o) => o.clOrdId),
    );
    // Lệnh có kết quả `unknown` (timeout) có thể đã nằm trên SoDEX (quy tắc 1.7). Trước đây Stop bỏ qua chúng rồi bỏ
    // runner, nên không ai đối soát / huỷ: lệnh mồ côi nằm lại (harness tranh chấp). Stop của người dùng giữ bot ở
    // `stopping` tới khi #reconcile đối soát xong (≤ NOT_FOUND_AFTER_MS); lệnh hoá ra đang mở thì lượt sau huỷ ở trên.
    // Lệnh đóng vị thế cũng chờ, vì lệnh unknown còn có thể khớp và đổi vị thế.
    // Lệnh SoDEX đã nhận, xác nhận không thấy quá UNKNOWN_CHECK_WINDOW_MS mà chưa được ghi cho người dùng: ghi ngay (runner
    // sắp bị bỏ nên #reconcile sẽ không còn làm được).
    const overdue = await this.#d.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.botId, r.botId),
          eq(orders.status, "unknown"),
          lte(orders.missingConfirmedAt, new Date(this.#d.now() - UNKNOWN_CHECK_WINDOW_MS)),
          isNull(orders.unknownGaveUpAt),
        ),
      );
    for (const o of overdue) await this.#unknownGaveUp(r, o, this.#d.now());
    // Lệnh SoDEX đã nhận rồi không thấy nữa: chỉ thôi chờ khi lần tra thành công đầu tiên xác nhận không thấy
    // (`missing_confirmed_at`) đã quá UNKNOWN_CHECK_WINDOW_MS. Chưa có lần xác nhận nào thì vẫn chờ.
    const [unknown] = await this.#d.db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          eq(orders.botId, r.botId),
          eq(orders.status, "unknown"),
          or(
            isNull(orders.sodexOrderId),
            isNull(orders.missingConfirmedAt),
            gt(orders.missingConfirmedAt, new Date(this.#d.now() - UNKNOWN_CHECK_WINDOW_MS)),
          ),
        ),
      );
    if ((unknown?.n ?? 0) > 0) {
      this.#d.log.warn(
        { botId: r.botId, unknown: unknown?.n, reason },
        "stop waits for unknown orders to be reconciled",
      );
      // Stop của người dùng: bot vẫn `stopping`, nhịp sau gọi lại. Dừng do chiến lược: ghi xuống DB thành `stopping` kèm
      // lý do (bền qua restart / đổi shard), để đường Stop của người dùng làm nốt và giữ lý do + tin báo.
      if (reason !== null) await this.#haltToStopping(r, reason, close);
      return;
    }
    // Bot paper (PB-01): lệnh đóng market cần giá để mô phỏng; chưa có giá thì PaperGateway từ chối (NO_PRICE), lệnh
    // đóng thành `rejected` và bot dừng với vị thế giả còn mở. Kiểm tra giá TRƯỚC khi đặt lệnh đóng: chưa có thì Stop
    // của người dùng giữ `stopping` (nhịp sau thử lại, chưa gửi gì); dừng do chiến lược thì ghi warn.
    if (r.paper && close && !this.#paperPriced(r)) {
      this.#d.log.warn({ botId: r.botId }, "paper close waits: no price for its market yet");
      if (reason === null) return;
    }
    if (r.strategy === Strategy.copyTrade) {
      // Copy Trade nhiều market (DEC-163): đóng từng market bằng market reduce-only; clOrdID tất định theo thứ tự
      // market trong config, băm từ botId đầy đủ.
      if (close) {
        const positions = copyPositions(normalizeCopyState(r.config as CopyTradeConfig, r.state));
        const markets = copyMarkets(r.config as Record<string, unknown>);
        const closes: StrategyAction[] = markets.flatMap((market, i) => {
          const size = positions[market];
          if (size === undefined || dec(size).isZero()) return [];
          return [
            {
              type: "place" as const,
              order: {
                clOrdID: clOrdId(r.botId, r.version, `close:${String(i)}`),
                market,
                engine: "perps" as const,
                side: dec(size).isPositive() ? ("sell" as const) : ("buy" as const),
                type: "market" as const,
                quantity: dec(size).abs().toString(),
                timeInForce: "IOC" as const,
                reduceOnly: true,
                tag: "close",
              },
            },
          ];
        });
        if (!(await this.#sendCloses(r, closes))) {
          await this.#closeNotSent(r, reason);
          return;
        }
      }
      close = false;
    }
    // Funding Arb giữ hai sổ cái: chỉ đóng chân perp (rủi ro đòn bẩy); tài sản Spot vẫn ở trong account.
    const st = r.state as { ledger?: { position: string }; perp?: { position: string } };
    const arb = r.strategy === Strategy.fundingArb;
    const ledger = arb ? st.perp : st.ledger;
    if (close && ledger !== undefined && !dec(ledger.position).isZero()) {
      const qty = dec(ledger.position).abs().toString();
      const engine = arb ? "perps" : this.#engineOf(r);
      // Băm botId đầy đủ (DEC-186): 8 ký tự đầu của uuidv7 là thời gian, nên bot tạo trong cùng ~65 s
      // từng có chung mã "<8 ký tự>-close-1" và lệnh đóng của bot thứ hai bị bỏ qua (unique theo account + clOrdID).
      const id = clOrdId(r.botId, r.version, "close");
      const sent = await this.#sendCloses(r, [
        {
          type: "place",
          order: {
            clOrdID: id,
            market: r.market,
            engine,
            side: dec(ledger.position).isPositive() ? "sell" : "buy",
            type: "market",
            quantity: qty,
            timeInForce: "IOC",
            reduceOnly: engine === "perps",
            tag: "close",
          },
        },
      ]);
      if (!sent) {
        await this.#closeNotSent(r, reason);
        return;
      }
    }
    // Bot paper (PB-01): lệnh đóng market chỉ khớp ở lần giá kế tiếp khi bot còn runner; bot sắp bị bỏ khỏi runner nên
    // khớp ngay ở giá hiện tại, không để lệnh đóng nằm "open" mãi và vị thế giả không bao giờ được đóng.
    if (r.paper && !(await this.#fillPaperNow(r))) {
      // Chưa có giá cho market của lệnh đóng (vừa khởi động / đổi shard): Stop của người dùng giữ bot ở `stopping`,
      // nhịp sau thử lại (lệnh đóng không gửi lại vì trùng clOrdID). Dừng do chiến lược thì không có lần thử lại: ghi warn.
      this.#d.log.warn({ botId: r.botId }, "paper close not filled: no price for its market yet");
      if (reason === null) return;
    }
    // Dừng do chiến lược đã qua `stopping` (lệnh unknown phải đối soát trước): lý do lấy từ event "Stopping" đã ghi, để
    // tin `bot_stopped` vẫn được gửi. Stop của người dùng không có event này nên không gửi tin.
    const haltReason = reason === null ? await this.#haltReasonOf(r.botId) : null;
    const deferred = await this.#fenced(r, async (tx) => {
      const [b] = await tx
        .select({ state: bots.state, reasonCode: bots.reasonCode, closeOnStop: bots.closeOnStop })
        .from(bots)
        .where(eq(bots.id, r.botId))
        .for("update");
      if (b === undefined) return false;
      // Stop kèm "Close position" của người dùng commit SAU lần đọc ở đầu hàm (trong lúc huỷ lệnh trên SoDEX): chưa có lệnh
      // đóng mà vị thế còn. Không kết thúc; chuyển sang `stopping` giữ lý do, để nhịp Stop sau gửi lệnh đóng.
      if (
        reason !== null &&
        !close &&
        b.state === BotState.stopping &&
        b.closeOnStop &&
        this.#hasPosition(r)
      ) {
        await this.#writeHaltStopping(tx, r, reason, true);
        return true;
      }
      const next =
        reason === null
          ? applyEngineEvent(b.state, EngineEvent.confirmedStopped)
          : applyReason(b.state, reason);
      if (next === null) return false;
      // Dừng đúng kế hoạch (MM-01): không còn việc gì cho người dùng, tắt cờ Needs attention (ví dụ cảnh báo 80% budget).
      // Lý do lấy cả từ dòng bot: chiến lược dừng đúng kế hoạch mà đi qua `stopping` (còn lệnh unknown) thì lượt cuối
      // không có reason, nhưng bots.reason_code đã là BUDGET_DONE / MAX_CYCLES.
      const why = reason ?? b.reasonCode;
      const planned =
        next === BotState.stopped &&
        why !== null &&
        (PLANNED_STOP_REASONS as readonly string[]).includes(why);
      await tx
        .update(bots)
        .set({
          state: next,
          ...(reason === null ? {} : { reasonCode: reason }),
          ...(planned ? { needsAttention: false } : {}),
          // Bot đã dừng không còn quản lý vị thế: bỏ cảnh báo lệch vị thế (DEC-306).
          ...(next === BotState.stopped ? { positionMismatch: null } : {}),
        })
        .where(eq(bots.id, r.botId));
      // Sự kiện "Stopped" (BD-06) cùng transaction với lần đổi trạng thái: đúng một lần, không mất khi engine chết giữa
      // chừng. why = reason code của lần dừng (chiến lược dừng đã qua `stopping` thì lấy từ bots.reason_code), hoặc
      // STOPPED_BY_USER khi người dùng bấm Stop.
      if (next === BotState.stopped)
        await tx.insert(botEvents).values({
          botId: r.botId,
          type: "state",
          decision: "Stopped",
          why: reason ?? b.reasonCode ?? STOPPED_BY_USER,
          occurredAt: new Date(this.#d.now()),
        });
      // Version còn chờ áp (Volume Farm dừng khi lượt chưa đóng, DEC-304): không bao giờ được áp nữa,
      // không để "pending" mãi. Start lại (DEC-86) vẫn chạy với config mới nhất.
      if (next === BotState.stopped)
        await tx
          .update(botVersions)
          .set({ status: "superseded" })
          .where(and(eq(botVersions.botId, r.botId), eq(botVersions.status, "pending")));
      await tx.insert(outbox).values({
        topic: `user.${r.account.id}.bot`,
        payload: { botId: r.botId, state: next, reasonCode: reason ?? haltReason },
      });
      // Báo team (DEC-184): bot tiền thật vào running sau một lần Start (starting → running; resume không báo).
      // Vốn tính sẵn ở đây (cùng hàm với Strategy Lab); jobs chỉ hiển thị.
      if (!r.paper && b.state === BotState.starting && next === BotState.running) {
        const cap = botCapitalOf(r.strategy, r.config);
        await tx.insert(outbox).values({
          topic: "jobs.team_ops",
          payload: {
            type: "team_bot_started",
            botId: r.botId,
            capital: cap.capital,
            capitalAsset:
              cap.capital === null ? null : cap.capitalUnit === "base" ? assetOf(r.market) : "USDC",
          },
        });
      }
      const notify = reason ?? haltReason;
      if (notify !== null)
        await tx.insert(outbox).values({
          topic: "jobs.notify",
          payload: {
            sodexAccountId: r.account.id,
            type: next === "stopped" ? "bot_stopped" : "bot_paused",
            data: { botId: r.botId, reasonCode: notify, ...(r.paper ? { paper: true } : {}) },
          },
        });
      return false;
    });
    if (deferred) return;
    // Bot dừng hẳn: lệnh huỷ không còn ai huỷ lại; #reconcileOpen vẫn đối soát lệnh còn mở (gửi huỷ cuối trước khi ghi).
    for (const id of this.#cancelGone.get(r.botId) ?? []) this.#goneCancelAt.delete(id);
    this.#cancelGone.delete(r.botId);
    // Lệnh đóng vừa gửi (IOC) khớp qua user stream: không để stream đóng ngay khi runner cuối của account bị bỏ.
    if (!r.paper) {
      const held = this.#streamHolds.get(r.account.id);
      this.#streamHolds.set(r.account.id, {
        account: r.account,
        engines: new Set([...(held?.engines ?? []), ...r.engines]),
        until: this.#d.now() + STREAM_HOLD_MS,
      });
    }
    this.#runners.delete(r.botId);
  }

  /**
   * Gửi lệnh đóng vị thế của Stop. Trả `true` khi Stop được kết thúc: lệnh đóng đã rời DeskLabs (SoDEX nhận / từ chối),
   * hoặc bỏ hẳn (xem dưới). Trả `false` khi Stop phải chờ (bot giữ `stopping`, vòng sau gọi lại):
   * - lease của shard không xác nhận được (không ghi dòng lệnh nào);
   * - đang chờ theo nấc thử lại `CLOSE_RETRY` sau lần trước chưa gửi được;
   * - lệnh đóng còn `unknown` (chờ #reconcile; quy tắc 1.7);
   * - lệnh đóng chưa tới SoDEX: `not_placed` do signer / key lỗi (ngay sau khi gửi), hoặc do đối soát không thấy trên
   *   SoDEX (timeout, chuyển shard lúc ký; thấy ở lượt sau). Cả hai đi chung một đường (#closeFailed): tính một lần thử,
   *   xoá dòng `not_placed` (unique theo account + clOrdID từng chặn lần gửi lại), chờ theo nấc, ghi Decisions một lần mỗi
   *   lý do. Key không dùng được, hoặc vẫn chưa tới SoDEX sau `CLOSE_RETRY.giveUpMs`: kết thúc Stop với vị thế còn mở,
   *   bật Needs attention, ghi một dòng "Couldn't close your position".
   */
  async #sendCloses(r: Runner, closes: StrategyAction[]): Promise<boolean> {
    const list = closes.flatMap((a) => (a.type === "place" ? [a.order] : []));
    const ids = list.map((o) => o.clOrdID);
    if (ids.length === 0) return true;
    const now = this.#d.now();
    if (r.closeRetry !== null && now < r.closeRetry.nextAt) return false;
    if (!(await this.#leaseConfirmed(r.shard))) {
      this.#d.log.warn({ botId: r.botId }, "close not sent: shard lease not confirmed");
      return false;
    }
    const mine = and(eq(orders.sodexAccountId, r.account.id), inArray(orders.clOrdId, ids));
    const read = () =>
      this.#d.db
        .select({ clOrdId: orders.clOrdId, status: orders.status, rejectCode: orders.rejectCode })
        .from(orders)
        .where(mine);
    // Lần gửi trước đối soát ra `not_placed` (SoDEX không có lệnh): tính là một lần thử không thành.
    const before = await read();
    if (before.some((o) => o.status === "not_placed"))
      return this.#closeFailed(r, list, before, now);
    if (before.some((o) => o.status === "unknown")) return false;
    await this.#execute(r, closes, now);
    const rows = await read();
    if (rows.some((o) => o.status === "unknown")) return false;
    if (rows.some((o) => o.status === "not_placed")) return this.#closeFailed(r, list, rows, now);
    r.closeRetry = null;
    return true;
  }

  /**
   * Lệnh đóng chưa tới SoDEX: xoá dòng `not_placed` để lần sau gửi lại cùng clOrdID, rồi chờ theo nấc (trả `false`), hoặc
   * bỏ hẳn (trả `true`: kết thúc Stop với vị thế còn mở).
   */
  async #closeFailed(
    r: Runner,
    list: readonly OrderIntent[],
    rows: readonly { clOrdId: string; status: string; rejectCode: string | null }[],
    now: number,
  ): Promise<boolean> {
    const failed = rows.filter((o) => o.status === "not_placed");
    const code = failed[0]?.rejectCode ?? "NOT_PLACED";
    const markets = [
      ...new Set(
        list.filter((o) => failed.some((f) => f.clOrdId === o.clOrdID)).map((o) => o.market),
      ),
    ].join(", ");
    await this.#fenced(r, (tx) =>
      tx.delete(orders).where(
        and(
          eq(orders.sodexAccountId, r.account.id),
          inArray(
            orders.clOrdId,
            failed.map((f) => f.clOrdId),
          ),
          eq(orders.status, "not_placed"),
        ),
      ),
    );
    const b = r.closeRetry ?? { since: now, attempts: 0, nextAt: now, reasons: new Set<string>() };
    const keyBroken = code === "key_unusable" || code === "key_not_active";
    if (keyBroken || now - b.since >= CLOSE_RETRY.giveUpMs) {
      r.closeRetry = null;
      await this.#fenced(r, async (tx) => {
        await tx.update(bots).set({ needsAttention: true }).where(eq(bots.id, r.botId));
        await tx.insert(botEvents).values({
          botId: r.botId,
          type: "error",
          decision: "Couldn't close your position",
          why: `SoDEX didn't receive the close order (${code}). Your ${markets} position is still open — close it on SoDEX.`,
          occurredAt: new Date(now),
        });
      });
      this.#d.log.warn(
        { botId: r.botId, code, attempts: b.attempts + 1 },
        "stop gave up on its close order",
      );
      // Key hỏng thì mọi bot tiền thật khác của account cũng không ký được (như #notSent).
      if (keyBroken) await this.pauseAccount(r.account.id, ReasonCode.apiKeyUnusable);
      return true;
    }
    b.attempts += 1;
    b.nextAt =
      now + (CLOSE_RETRY.backoffMs[Math.min(b.attempts, CLOSE_RETRY.backoffMs.length) - 1] ?? 0);
    if (!b.reasons.has(code)) {
      b.reasons.add(code);
      await this.#event(
        r,
        "error",
        "Close order not sent",
        `SoDEX didn't receive the close order (${code}). DeskLabs will try again.`,
        now,
      );
    }
    r.closeRetry = b;
    return false;
  }

  /** Lệnh đóng chưa gửi được: Stop của người dùng giữ `stopping` (nhịp sau thử lại); dừng do chiến lược thì ghi `stopping`. */
  async #closeNotSent(r: Runner, reason: Reason | null): Promise<void> {
    this.#d.log.warn({ botId: r.botId, reason }, "stop waits: close order not sent yet");
    if (reason !== null) await this.#haltToStopping(r, reason, true);
  }

  /**
   * Chiến lược dừng (halt) khi bot còn lệnh `unknown` (quy tắc 1.7): chuyển bot sang `stopping` kèm lý do và lựa chọn
   * đóng vị thế trong một transaction có fence, rồi ghi event "Stopping" với lý do. UI hiện "Stopping…" đúng sự thật
   * (quy tắc 1.6); đường Stop của người dùng làm nốt khi đã đối soát xong.
   */
  async #haltToStopping(r: Runner, reason: Reason, close: boolean): Promise<void> {
    await this.#fenced(r, async (tx) => {
      const [b] = await tx
        .select({ state: bots.state, closeOnStop: bots.closeOnStop })
        .from(bots)
        .where(eq(bots.id, r.botId))
        .for("update");
      if (b === undefined || b.state === BotState.stopped || b.state === BotState.archived) return;
      // Người dùng đang Stop kèm đóng vị thế thì giữ lựa chọn đó (closeOnStop chỉ có nghĩa khi bot đang `stopping`).
      const userClose = b.state === BotState.stopping && b.closeOnStop;
      await this.#writeHaltStopping(tx, r, reason, close || userClose);
    });
  }

  /** Ghi (trong transaction đang giữ khoá dòng bot): `stopping` + lý do + lựa chọn đóng, outbox và event "Stopping". */
  async #writeHaltStopping(tx: Db, r: Runner, reason: Reason, close: boolean): Promise<void> {
    await tx
      .update(bots)
      .set({ state: BotState.stopping, reasonCode: reason, closeOnStop: close })
      .where(eq(bots.id, r.botId));
    await tx.insert(outbox).values({
      topic: `user.${r.account.id}.bot`,
      payload: { botId: r.botId, state: BotState.stopping, reasonCode: reason },
    });
    // Cùng transaction: lý do của lần dừng không mất nếu engine chết giữa chừng (#haltReasonOf đọc lại event này).
    await tx.insert(botEvents).values({
      botId: r.botId,
      type: "state",
      decision: "Stopping",
      why: reason,
      occurredAt: new Date(this.#d.now()),
    });
  }

  /** Bot còn vị thế theo sổ cái (cùng nguồn với lệnh đóng khi Stop). */
  #hasPosition(r: Runner): boolean {
    if (r.strategy === Strategy.copyTrade)
      return Object.values(
        copyPositions(normalizeCopyState(r.config as CopyTradeConfig, r.state)),
      ).some((s) => !dec(s).isZero());
    const st = r.state as { ledger?: { position: string }; perp?: { position: string } };
    const ledger = r.strategy === Strategy.fundingArb ? st.perp : st.ledger;
    return ledger !== undefined && !dec(ledger.position).isZero();
  }

  /** Lý do của lần dừng do chiến lược đang chờ đối soát: event trạng thái gần nhất là "Stopping" kèm reason code. */
  async #haltReasonOf(botId: string): Promise<Reason | null> {
    const [e] = await this.#d.db
      .select({ decision: botEvents.decision, why: botEvents.why })
      .from(botEvents)
      .where(and(eq(botEvents.botId, botId), eq(botEvents.type, "state")))
      .orderBy(desc(botEvents.occurredAt))
      .limit(1);
    if (e?.decision !== "Stopping" || e.why === null) return null;
    return (Object.values(ReasonCode) as string[]).includes(e.why) ? (e.why as Reason) : null;
  }

  /** Market của bot paper đã có giá mô phỏng (cùng nguồn `PaperGateway.priceOf` mà lệnh paper dùng). */
  #paperPriced(r: Runner): boolean {
    const paper = this.#d.paper;
    if (paper === undefined) return true;
    return paper.priceOf(r.market) !== null;
  }

  /**
   * Khớp ngay các lệnh paper đang mở của bot ở giá gần nhất của từng market (lệnh limit chỉ khớp khi giá đã qua).
   * Trả false khi còn lệnh market (lệnh đóng) đang mở vì market của nó chưa có giá.
   */
  async #fillPaperNow(r: Runner): Promise<boolean> {
    const paper = this.#d.paper;
    if (paper === undefined) return true;
    const at = this.#d.now();
    const priced = new Set<string>();
    for (const market of new Set([r.market, ...Object.keys(r.ctx.rules)])) {
      const price = this.#lastPrice.get(market) ?? paper.priceOf(market);
      if (price === null) continue;
      priced.add(market);
      for (const f of await paper.onPrice(market, price, at, [r.botId]))
        await this.onFill(f.accountId, f.clOrdID, f.totalFilled, f.avgPrice, f.fee, at);
    }
    const waiting = await this.#d.db
      .select({ market: orders.market })
      .from(orders)
      .where(
        and(
          eq(orders.botId, r.botId),
          eq(orders.type, "market"),
          inArray(orders.status, ["open", "partially_filled"]),
        ),
      );
    return waiting.every((o) => priced.has(o.market));
  }

  /** Engine của lệnh đóng khi Stop: Futures Grid / DCA, Volume Maker / Farm và TWAP chạy Perps đều là Perps. */
  #engineOf(r: Runner): "spot" | "perps" {
    return engineOfBot(r.strategy, r.config);
  }

  /** Phí một chiều của bot (DEC-112); account builder chạy live không chịu builder fee. */
  #feeRateOf(
    bot: typeof bots.$inferSelect,
    config: unknown,
    rules: Record<string, MarketRules>,
    route: { account: AccountRef; paper: boolean },
    builderRate: number,
    taker = false,
  ): string {
    const own =
      !route.paper &&
      this.#d.builderId !== undefined &&
      isBuilderAccount(route.account.sodexAccountId, this.#d.builderId, this.#d.builderExempt);
    return (taker ? botTakerFeeRate : botFeeRate)(
      bot.strategy,
      config,
      rules[bot.market],
      own,
      builderRate,
    );
  }

  /** Builder fee riêng team đặt cho user (DEC-159). */
  async #builderFees(userId: string): Promise<BuilderFeeOverrides> {
    return (await this.#builderFeesOf([userId])).get(userId) ?? {};
  }

  /** Như `#builderFees` cho nhiều user trong một truy vấn (mỗi vòng `#syncBots`). */
  async #builderFeesOf(userIds: readonly string[]): Promise<Map<string, BuilderFeeOverrides>> {
    // Mức theo bậc volume rồi mức team đặt tay (DEC-159, DEC-258), cùng nguồn với API và backtest.
    return builderFeeOverridesOf(this.#d.db, userIds);
  }

  async #event(
    r: Runner,
    type: string,
    decision: string,
    why: string,
    at: number,
    /** Ghi thêm trong cùng transaction (outbox cảnh báo bot copy, DEC-212). */
    also?: (tx: Db) => Promise<void>,
    /** Dữ liệu kèm event (ví dụ clOrdID của lệnh đặt cùng quyết định, BD-02). */
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.#fenced(r, async (tx) => {
      await tx.insert(botEvents).values({
        botId: r.botId,
        type,
        decision,
        why,
        occurredAt: new Date(at),
        ...(payload === undefined ? {} : { payload }),
      });
      if (also !== undefined) await also(tx);
    });
  }

  /**
   * Bối cảnh lúc đặt của từng lệnh (Market Making, #233) theo clOrdID, parse lại bằng zod. Sai schema thì bỏ riêng bối
   * cảnh đó (log warn, chỉ tên field); không bao giờ ném lỗi, không bao giờ chặn việc ghi / gửi lệnh.
   */
  #orderContexts(
    r: Runner,
    actions: readonly StrategyAction[],
  ): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    try {
      for (const a of actions) {
        if (a.type !== "place" || a.context === undefined) continue;
        const parsed = mmOrderContextSchema.safeParse(a.context);
        if (parsed.success) out.set(a.order.clOrdID, parsed.data);
        else
          this.#d.log.warn(
            {
              botId: r.botId,
              fields: parsed.error.issues.map((i) => i.path.map(String).join(".")).slice(0, 5),
            },
            "order context dropped: schema mismatch",
          );
      }
    } catch {
      out.clear();
    }
    return out;
  }

  /**
   * Payload của event quyết định: `orders` của bước (BD-02) + dữ liệu chiến lược gắn kèm (`signal` của Volume Farm,
   * #221; `quote` của Market Making, #230). Snapshot không đúng schema thì bỏ riêng nó (log warn, chỉ tên field, không
   * kèm nội dung), không bao giờ chặn việc ghi quyết định hay lệnh.
   */
  #decisionPayload(
    r: Runner,
    placed: { orders: string[] } | undefined,
    extra: DecisionPayload | undefined,
  ): Record<string, unknown> | undefined {
    const dropped = (
      kind: "signal" | "quote",
      issues: readonly { path: readonly PropertyKey[] }[],
    ) => {
      this.#d.log.warn(
        { botId: r.botId, fields: issues.map((i) => i.path.map(String).join(".")).slice(0, 5) },
        `decision ${kind} snapshot dropped: schema mismatch`,
      );
    };
    let signal: VbSignalSnapshot | undefined;
    if (extra?.signal !== undefined) {
      const parsed = vbSignalSnapshotSchema.safeParse(extra.signal);
      if (parsed.success) signal = parsed.data;
      else dropped("signal", parsed.error.issues);
    }
    let quote: MmQuoteSnapshot | undefined;
    if (extra?.quote !== undefined) {
      const parsed = mmQuoteSnapshotSchema.safeParse(extra.quote);
      if (parsed.success) quote = parsed.data;
      else dropped("quote", parsed.error.issues);
    }
    if (placed === undefined && signal === undefined && quote === undefined) return undefined;
    return {
      ...placed,
      ...(signal === undefined ? {} : { signal }),
      ...(quote === undefined ? {} : { quote }),
    };
  }

  /**
   * Dựng dữ liệu cảnh báo bot copy (DEC-212): chỉ bot copy tiền thật; bot paper không bao giờ có tin.
   * Không bao giờ ném lỗi ra transaction đang ghi: lỗi thì log warn (không dữ liệu nhạy cảm) và bỏ tin (PM điều kiện ii).
   */
  #copyAlerts<T>(r: Runner, build: () => T[]): T[] {
    if (r.paper || r.strategy !== Strategy.copyTrade) return [];
    try {
      return build();
    } catch (err) {
      this.#d.log.warn(
        { botId: r.botId, err: err instanceof Error ? err.name : "unknown" },
        "copy bot alert dropped",
      );
      return [];
    }
  }

  // ---------- đối soát & phí ----------

  /**
   * Việc đọc SoDEX theo account trong một bước của shard (DEC-308): các account chạy song song (tối
   * đa ACCOUNT_CONCURRENCY), việc của một account vẫn tuần tự theo thứ tự cũ. Lỗi của một account (SoDEX chậm / lỗi, mạng)
   * chỉ bỏ phần còn lại của account đó ở lượt này (ghi warn, lượt sau thử lại), không bỏ account khác hay các bước sau của
   * shard. Lỗi fencing ném lại.
   */
  async #perAccount<T>(
    phase: ShardPhase,
    items: readonly T[],
    accountOf: (item: T) => string,
    work: (item: T) => Promise<void>,
  ): Promise<void> {
    const groups = new Map<string, T[]>();
    for (const x of items) pushTo(groups, accountOf(x), x);
    await eachLimited([...groups], ACCOUNT_CONCURRENCY, async ([accountId, list]) => {
      try {
        for (const x of list) await work(x);
      } catch (error) {
        if (error instanceof FencedError) throw error;
        this.#d.log.warn(
          { err: error, accountId, phase },
          "SoDEX step failed for one account; retrying next tick",
        );
      }
    });
  }

  /** Lệnh `unknown`: hỏi SoDEX theo clOrdID rồi mới quyết định; không gửi lại (quy tắc 1.7). */
  async #reconcile(shard: number, snap: TickSnapshot): Promise<void> {
    const now = this.#d.now();
    const pending = await this.#fresh(
      snap.unknown.filter((o) => this.#runners.get(o.botId)?.shard === shard),
    );
    await this.#perAccount(
      "reconcile",
      pending,
      (o) => o.sodexAccountId,
      async (o) => {
        const r = this.#runners.get(o.botId);
        if (r?.shard !== shard) return;
        const confirmedAt = o.missingConfirmedAt?.getTime();
        const givingUp =
          o.sodexOrderId !== null &&
          confirmedAt !== undefined &&
          now - confirmedAt >= UNKNOWN_CHECK_WINDOW_MS;
        // Không có trong kế hoạch tra của vòng (ngân sách REST của worker): chờ vòng sau, không đổi nhịp tra lại.
        if (!givingUp && !this.#lookupAllowed(snap, o.id, now)) return;
        // SoDEX đã nhận lệnh mà sau đó không tìm thấy: tra lại giãn dần 15 → 30 → 60 s, không phải mỗi vòng. Quá
        // UNKNOWN_CHECK_WINDOW_MS tính từ lần tra THÀNH CÔNG đầu tiên xác nhận không thấy (`missing_confirmed_at`, bền qua
        // khởi động lại) thì ghi cho người dùng một lần (quy tắc 1.7). Chưa có lần xác nhận nào thì không bỏ cuộc.
        if (o.sodexOrderId !== null) {
          const c = this.#unknownChecks.get(o.id) ?? { n: 0, at: 0 };
          const confirmed = o.missingConfirmedAt?.getTime();
          if (confirmed !== undefined && now - confirmed >= UNKNOWN_CHECK_WINDOW_MS) {
            await this.#unknownGaveUp(r, o, now);
            return;
          }
          if (now - c.at < Math.min(UNKNOWN_RECHECK_MAX_MS, OPEN_CHECK_MS * 2 ** c.n)) return;
          this.#unknownChecks.set(o.id, { ...c, n: c.n + 1, at: now });
        }
        // Một lệnh tra lỗi (SoDEX / mạng) không được làm hỏng cả vòng của shard: #reconcileOpen, huỷ lại, phí, đồng hồ
        // của mọi bot vẫn chạy; lệnh này thử lại ở nhịp sau (follow-up #154).
        try {
          await this.#reconcileOne(r, o, now);
        } catch (error) {
          if (error instanceof FencedError) throw error;
          this.#d.log.warn(
            { err: error, botId: r.botId, clOrdID: o.clOrdId },
            "reconcile failed for one order; retrying next tick",
          );
        }
      },
    );
  }

  /**
   * Lệnh SoDEX đã nhận, `unknown` quá UNKNOWN_CHECK_WINDOW_MS: không còn trong lệnh mở của SoDEX (đã kiểm nhiều lần) nên
   * không khớp thêm được, nhưng không biết đã khớp bao nhiêu. Không đoán (quy tắc 1.7): giữ `unknown`, gắn Needs attention
   * và ghi Decisions một lần để người dùng kiểm tra vị thế trên SoDEX. Lưới an toàn fill vẫn ghi trade nếu nó xuất hiện.
   */
  async #unknownGaveUp(r: Runner, o: typeof orders.$inferSelect, now: number): Promise<void> {
    this.#d.log.error(
      { botId: r.botId, clOrdID: o.clOrdId },
      "order result still unknown after reconciling; needs attention",
    );
    await this.#fenced(r, async (tx) => {
      // Ghi một lần: chỉ dòng chưa bỏ cuộc mới được đánh dấu (vòng / engine khác đã ghi thì thôi).
      const marked = await tx
        .update(orders)
        .set({ unknownGaveUpAt: new Date(now) })
        .where(and(eq(orders.id, o.id), isNull(orders.unknownGaveUpAt)))
        .returning({ id: orders.id });
      if (marked.length === 0) return;
      await tx.update(bots).set({ needsAttention: true }).where(eq(bots.id, r.botId));
      await tx.insert(botEvents).values({
        botId: r.botId,
        type: "reconcile",
        decision: UNKNOWN_DECISION,
        why: `${o.clOrdId}: SoDEX accepted it, but it is not in the order history and has no trades. Check this bot's position on SoDEX.`,
        occurredAt: new Date(now),
      });
    });
  }

  /** Đối soát một lệnh `unknown` với SoDEX. */
  async #reconcileOne(r: Runner, o: typeof orders.$inferSelect, now: number): Promise<void> {
    const found = await r.gateway.lookup(r.account, {
      clOrdID: o.clOrdId,
      market: o.market,
      engine: o.engine,
    });
    if (found.status === "not_found") {
      if (now - (o.submittedAt?.getTime() ?? now) < NOT_FOUND_AFTER_MS) return;
      // Lịch sử lệnh REST của SoDEX trễ hơn lịch sử khớp: hỏi trade của lệnh trước khi kết luận.
      if (!r.paper) {
        const trades = await this.#orderTrades(r.account, o);
        const t = foundFromTrades(o, trades, o.sodexOrderId ?? 0n);
        if (t !== null) {
          this.#d.log.info(
            { botId: r.botId, clOrdID: o.clOrdId, filled: t.found.filledQty, done: t.done },
            "unknown order not found on SoDEX, but its trades are; recording the fill",
          );
          this.#unknownChecks.delete(o.id);
          if (o.ackedAt === null) {
            await this.#ack(r, now);
            await this.#feed(r, { type: "orderAck", at: now, clOrdID: o.clOrdId });
          }
          // Lệnh limit khớp một phần có thể vẫn nằm trên sổ: chỉ ghi fill, không kết thúc (M1).
          if (t.done)
            await this.#settleOrder(r.shard, r.epoch, r.account, o, t.found, now, false, trades);
          else await this.#recordTrades(r.account, o, trades, now);
          return;
        }
      }
      // SoDEX đã nhận lệnh (có orderID): không phải "chưa đặt". Giữ `unknown`, đối soát lại sau (quy tắc 1.7). Lần tra
      // thành công đầu tiên mà vẫn không thấy được ghi lại (kể cả dòng `unknown` cũ chưa có dấu này).
      if (o.sodexOrderId !== null) {
        if (o.missingConfirmedAt === null)
          await this.#fenced(r, (tx) =>
            tx
              .update(orders)
              .set({ missingConfirmedAt: new Date(now) })
              .where(and(eq(orders.id, o.id), isNull(orders.missingConfirmedAt))),
          );
        return;
      }
      await this.#fenced(r, (tx) =>
        tx
          .update(orders)
          .set({ status: "not_placed", reconciledAt: new Date(now) })
          .where(eq(orders.id, o.id)),
      );
      await this.#event(
        r,
        "reconcile",
        "Order not placed",
        `${o.clOrdId} was not found on SoDEX.`,
        now,
      );
      await this.#feed(r, {
        type: "orderReject",
        at: now,
        clOrdID: o.clOrdId,
        code: "NOT_PLACED",
      });
      return;
    }
    this.#unknownChecks.delete(o.id);
    await this.#fenced(r, (tx) =>
      tx
        .update(orders)
        .set({
          // Lệnh market (IOC) SoDEX báo đã huỷ: để #reconcileOpen kết thúc nó (hỏi trade trước, báo chiến lược một lần).
          status:
            found.status === "partially_filled" ||
            found.status === "filled" ||
            (found.status === "cancelled" && o.type === "market")
              ? "open"
              : found.status,
          sodexOrderId: found.orderId,
          reconciledAt: new Date(now),
          ackedAt: o.ackedAt ?? new Date(now),
        })
        .where(eq(orders.id, o.id)),
    );
    await this.#event(
      r,
      "reconcile",
      "Order found on SoDEX",
      `${o.clOrdId} is ${found.status}.`,
      now,
    );
    if (found.status === "rejected") {
      await this.#feed(r, { type: "orderReject", at: now, clOrdID: o.clOrdId, code: "REJECTED" });
      return;
    }
    await this.#ack(r, now);
    await this.#feed(r, { type: "orderAck", at: now, clOrdID: o.clOrdId });
    if (dec(found.filledQty).gt(0) && found.avgPrice !== null) {
      await this.onFill(r.account.id, o.clOrdId, found.filledQty, found.avgPrice, "0", now);
    }
  }

  /**
   * Lịch sử khớp gần đây (500 dòng, như `recentTrades`) của account trên market, đọc tối đa một lần mỗi vòng tick và
   * dùng chung cho đối soát từng lệnh và lưới an toàn fill (giữ hạn mức REST, M4).
   */
  #accountTrades(
    account: AccountRef,
    market: string,
    engine: "spot" | "perps",
    /** Bản đang giữ đọc trước mốc này (`#readSeq`) thì đọc lại. */
    notBefore = 0,
  ): Promise<(OrderTrade & { clOrdID: string })[]> {
    const key = `${account.id}:${engine}:${market}`;
    const cached = this.#tradesCache.get(key);
    if (cached !== undefined && cached.seq >= notBefore) return cached.p;
    // Đọc thật: ghi vào cửa sổ ngân sách đọc của worker (DEC-310), kể cả lưới an toàn fill.
    if (account.paper !== true) this.#lookupLog.push({ at: this.#d.now(), weight: TRADES_WEIGHT });
    const entry = {
      seq: ++this.#readSeq,
      p: this.#d.gateway.recentTrades(account, { market, engine }),
    };
    this.#tradesCache.set(key, entry);
    entry.p.catch(() => {
      if (this.#tradesCache.get(key) === entry) this.#tradesCache.delete(key);
    });
    return entry.p;
  }

  /** Trade SoDEX của một lệnh (theo clOrdID), từ lịch sử khớp dùng chung của vòng. */
  async #orderTrades(
    account: AccountRef,
    o: { clOrdId: string; market: string; engine: "spot" | "perps" },
    notBefore = 0,
  ): Promise<OrderTrade[]> {
    return (await this.#accountTrades(account, o.market, o.engine, notBefore)).filter(
      (t) => t.clOrdID === o.clOrdId,
    );
  }

  /**
   * Ghi các trade của lệnh (fill theo `sodex_trade_id`) và phần khớp mới qua `onFill`, không kết thúc lệnh: dùng khi
   * không được kết luận lệnh đã xong (lệnh limit khớp một phần có thể vẫn nằm trên sổ).
   */
  async #recordTrades(
    account: AccountRef,
    o: typeof orders.$inferSelect,
    trades: readonly OrderTrade[],
    now: number,
  ): Promise<void> {
    for (const t of trades) await this.onTrade(account.id, { ...t, clOrdID: o.clOrdId });
    const t = foundFromTrades(o, trades, o.sodexOrderId ?? 0n);
    if (t?.found.avgPrice == null) return;
    await this.#fillFromTrades(
      account.id,
      o.clOrdId,
      trades,
      t.found.filledQty,
      t.found.avgPrice,
      now,
    );
  }

  /**
   * Phần khớp mới theo trade SoDEX, trong hàng đợi của lệnh: phí tính trên dòng lệnh đọc lại ở đó (phần stream đã ghi
   * trong lúc đọc REST không bị tính phí lần hai), rồi đi qua đường fill thường.
   */
  async #fillFromTrades(
    accountId: string,
    clOrdID: string,
    trades: readonly OrderTrade[],
    total: string,
    avg: string,
    now: number,
  ): Promise<void> {
    await this.#inOrderQueue(accountId, clOrdID, async () => {
      const [cur] = await this.#d.db
        .select({ filledSize: orders.filledSize })
        .from(orders)
        .where(and(eq(orders.sodexAccountId, accountId), eq(orders.clOrdId, clOrdID)))
        .limit(1);
      if (cur === undefined || !dec(total).gt(cur.filledSize)) return;
      const fee = feeBeyond(trades, cur.filledSize).toString();
      await this.#applyOrderFill(accountId, clOrdID, total, avg, fee, now);
    });
  }

  /**
   * Lệnh đang mở của shard cần tra SoDEX ở vòng này (#reconcileOpen), theo thứ tự tra: lệnh nghi ngờ trước (đã gửi huỷ
   * chưa có kết quả, lệnh market, lệnh Volume Farm DRIFT tự huỷ trong khoảng trống stream, DEC-308), rồi lệnh kiểm lâu
   * nhất (chưa kiểm = 0), rồi lệnh cũ nhất (DEC-185); tối đa OPEN_CHECK_BATCH lệnh mỗi account. Không có tác dụng phụ.
   */
  #openDue(shard: number, snap: TickSnapshot, now: number): (OrderRow & { suspect: boolean })[] {
    // Lệnh bot thật của shard (snapshot của vòng, DEC-105: không bao giờ lệnh paper).
    const rows = snap.open.get(shard) ?? [];
    const gap = (o: { sodexAccountId: string; engine: "spot" | "perps" }) =>
      this.#inGap(o.sodexAccountId, o.engine, now);
    // Lệnh bot đã gửi huỷ mà SoDEX chưa xác nhận: đọc trạng thái thật thay vì huỷ lại mãi (DEC-121).
    const cancelling = (o: { botId: string; clOrdId: string }) =>
      this.#pendingCancels.get(o.botId)?.has(o.clOrdId) === true;
    const open = rows.filter((o) => {
      const r = this.#runners.get(o.botId);
      return (
        o.type === "market" ||
        r === undefined ||
        cancelling(o) ||
        (r.strategy === Strategy.volumeFarm && gap(o))
      );
    });
    // Lệnh Volume Farm DRIFT tự huỷ nhưng chưa xác nhận: có thể đã khớp ngay trước lúc huỷ.
    const unconfirmed = (snap.unconfirmed.get(shard) ?? []).filter((o) => gap(o));
    const lastCheck = (o: { id: string }) => this.#openChecks.get(o.id) ?? 0;
    const suspect = (o: OrderRow) =>
      o.type === "market" || cancelling(o) || unconfirmed.includes(o) ? 0 : 1;
    const accounts = new Set((snap.accounts.get(shard) ?? []).map((a) => a.id));
    const perAccount = new Map<string, number>();
    return [...open, ...unconfirmed]
      .filter((o) => now - lastCheck(o) >= OPEN_CHECK_MS)
      .sort(
        (a, b) =>
          suspect(a) - suspect(b) ||
          lastCheck(a) - lastCheck(b) ||
          (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0),
      )
      .filter((o) => {
        // Account còn kết nối; tối đa OPEN_CHECK_BATCH lệnh mỗi account mỗi vòng (DEC-308).
        if (!accounts.has(o.sodexAccountId)) return false;
        const n = perAccount.get(o.sodexAccountId) ?? 0;
        if (n >= OPEN_CHECK_BATCH) return false;
        perAccount.set(o.sodexAccountId, n + 1);
        return true;
      })
      .map((o) => ({ ...o, suspect: suspect(o) === 0 }));
  }

  /**
   * Lệnh `unknown` của shard có thể được tra SoDEX ở vòng này (#reconcile): tới nhịp tra lại. Lập kế hoạch trước khi nạp
   * bot của vòng, nên không đòi runner (#reconcile tự bỏ lệnh không có runner). Không có tác dụng phụ.
   */
  #unknownDue(shard: number, snap: TickSnapshot, now: number): OrderRow[] {
    return snap.unknown.filter((o) => {
      if (shardOf(o.sodexAccountId, this.#d.shards) !== shard) return false;
      if (o.sodexOrderId === null) return true;
      const c = this.#unknownChecks.get(o.id) ?? { n: 0, at: 0 };
      const confirmed = o.missingConfirmedAt?.getTime();
      if (confirmed !== undefined && now - confirmed >= UNKNOWN_CHECK_WINDOW_MS) return false;
      return now - c.at >= Math.min(UNKNOWN_RECHECK_MAX_MS, OPEN_CHECK_MS * 2 ** c.n);
    });
  }

  /**
   * Chọn lệnh được tra ở vòng này cho cả worker (DEC-310): lệnh nghi ngờ (`unknown`, đã gửi huỷ, market,
   * Volume Farm tự huỷ trong khoảng trống stream) trước, rồi lệnh đang nằm sổ; trong mỗi nhóm luân phiên giữa các account
   * (mỗi account một lệnh mỗi lượt, giữ thứ tự của account). Số lệnh ≤ phần còn lại của LOOKUP_BUDGET trong 60 s.
   */
  #planLookups(snap: TickSnapshot, shards: readonly number[], now: number): Set<string> | null {
    if (!Number.isFinite(this.#d.lookupBudget)) return null;
    const suspects = new Map<string, OrderRow[]>();
    const others = new Map<string, OrderRow[]>();
    // Lệnh của bot sẽ được nạp ở vòng này (vừa khởi động lại / nhận shard): kế hoạch lập trước khi nạp nên lệnh trông như
    // không có runner; xếp cuối, sau khi nạp phần lớn không còn tới hạn (chỉ market / đã gửi huỷ / khoảng trống stream).
    const later = new Map<string, OrderRow[]>();
    for (const shard of shards) {
      const loading = new Set(
        (snap.bots.get(shard) ?? [])
          .filter((x) => !this.#runners.has(x.bot.id))
          .map((x) => x.bot.id),
      );
      for (const o of this.#unknownDue(shard, snap, now)) pushTo(suspects, o.sodexAccountId, o);
      for (const o of this.#openDue(shard, snap, now))
        pushTo(o.suspect ? suspects : loading.has(o.botId) ? later : others, o.sodexAccountId, o);
    }
    const room = Math.max(
      0,
      Math.floor((this.#d.lookupBudget - this.#lookupUsed(now)) / (LOOKUP_WEIGHT + TRADES_WEIGHT)),
    );
    const plan = new Set<string>();
    for (const tier of [suspects, others, later]) {
      const queues = [...tier.values()];
      for (let round = 0; plan.size < room && queues.some((q) => q.length > round); round += 1)
        for (const q of queues) {
          const o = q[round];
          if (o !== undefined && plan.size < room) plan.add(o.id);
        }
    }
    return plan;
  }

  /** Weight tra lệnh đã dùng trong LOOKUP_BUDGET.windowMs gần nhất (bỏ phần cũ hơn). */
  #lookupUsed(now: number): number {
    this.#lookupLog = this.#lookupLog.filter((x) => now - x.at < LOOKUP_BUDGET.windowMs);
    return this.#lookupLog.reduce((a, x) => a + x.weight, 0);
  }

  /** Lệnh được tra ở vòng này: có trong kế hoạch (hoặc không giới hạn) và còn ngân sách; ghi lần tra vào ngân sách. */
  #lookupAllowed(snap: TickSnapshot, id: string, now: number): boolean {
    if (snap.lookups === null) return true;
    return snap.lookups.has(id) && this.#takeLookup(now);
  }

  /** Ghi một lần tra vào ngân sách; hết ngân sách (lane của vòng trước còn chạy) thì false, không tra. */
  #takeLookup(now: number): boolean {
    if (this.#lookupUsed(now) + LOOKUP_WEIGHT + TRADES_WEIGHT > this.#d.lookupBudget) return false;
    this.#lookupLog.push({ at: now, weight: LOOKUP_WEIGHT });
    return true;
  }

  /**
   * Lệnh còn `open` trong DRIFT mà không ai cập nhật được (DEC-85): bot đã dừng (không còn runner, user stream có
   * thể đã đóng ngay sau lệnh đóng vị thế của Stop), hoặc lệnh market (IOC không thể nằm trên sổ, SoDEX không báo
   * khi hết hạn mà chưa khớp). Đọc trạng thái thật từ SoDEX, ghi fill, cập nhật sổ cái và PnL của bot.
   */
  async #reconcileOpen(shard: number, snap: TickSnapshot): Promise<void> {
    const held = this.#leases.get(shard);
    if (held === undefined) return;
    const now = this.#d.now();
    const due = this.#openDue(shard, snap, now);
    if (due.length === 0) return;
    const accounts = new Map((snap.accounts.get(shard) ?? []).map((a) => [a.id, a]));
    const cancelling = (o: { botId: string; clOrdId: string }) =>
      this.#pendingCancels.get(o.botId)?.has(o.clOrdId) === true;
    // Chỉ lệnh có trong kế hoạch tra của vòng (ngân sách REST của cả worker, DEC-310).
    const picked = due.filter((o) => snap.lookups?.has(o.id) !== false);
    const batch = await this.#fresh(picked);
    await this.#perAccount(
      "reconcileOpen",
      batch,
      (o) => o.sodexAccountId,
      async (o) => {
        const account = accounts.get(o.sodexAccountId);
        if (account === undefined) return;
        if (!this.#lookupAllowed(snap, o.id, now)) return;
        this.#openChecks.set(o.id, now);
        const ref = { clOrdID: o.clOrdId, market: o.market, engine: o.engine };
        const lookedAt = ++this.#readSeq;
        const found = await this.#d.gateway.lookup(account, ref);
        if (found.status === "open") {
          this.#missingSince.delete(o.id);
          // Lần huỷ trước nhận OrderNotFound mà lệnh vẫn nằm sổ (vào sổ muộn): huỷ lại ở #retryCancels.
          if (this.#cancelGone.get(o.botId)?.delete(o.clOrdId) === true)
            this.#cancelRetryAt.delete(o.botId);
          return;
        }
        if (found.status === "not_found") {
          // Lịch sử lệnh REST trễ vài giây sau khi khớp: không tìm thấy chưa có nghĩa là đã huỷ. Hỏi trade của lệnh trước,
          // kể cả stop loss gốc (stop đã kích hoạt và khớp cũng có thể chưa vào lịch sử).
          const trades = await this.#orderTrades(account, o);
          const t = foundFromTrades(o, trades, o.sodexOrderId ?? 0n);
          if (t?.done === true) {
            this.#d.log.info(
              { botId: o.botId, clOrdID: o.clOrdId, filled: t.found.filledQty },
              "order not found on SoDEX, but its trades are; recording the fill",
            );
            await this.#settleOrder(
              shard,
              held.epoch,
              account,
              o,
              t.found,
              now,
              cancelling(o),
              trades,
            );
            this.#pendingCancels.get(o.botId)?.delete(o.clOrdId);
            this.#openChecks.delete(o.id);
            this.#missingSince.delete(o.id);
            return;
          }
          // Lệnh limit khớp một phần có thể vẫn nằm trên sổ: ghi fill, chưa kết thúc (M1).
          if (t !== null) await this.#recordTrades(account, o, trades, now);
          // Stop loss gốc đã được SoDEX nhận (DEC-118) mà không còn, không có trade: SoDEX huỷ nó khi vị thế đóng. Lịch sử
          // khớp dùng chung có thể đã đọc TRƯỚC lần tra này (stop vừa kích hoạt và khớp ở giữa): đọc lại trước khi ghi huỷ.
          if (t === null && isNativeStop(o) && o.status === "open" && o.sodexOrderId !== null) {
            const again = await this.#orderTrades(account, o, lookedAt);
            const fired = foundFromTrades(o, again, o.sodexOrderId);
            if (fired?.done === true) {
              await this.#settleOrder(
                shard,
                held.epoch,
                account,
                o,
                fired.found,
                now,
                false,
                again,
              );
              this.#openChecks.delete(o.id);
              this.#missingSince.delete(o.id);
              return;
            }
            await this.#fenced({ shard, epoch: held.epoch }, (tx) =>
              tx
                .update(orders)
                .set({ status: "cancelled", reconciledAt: new Date(now) })
                .where(eq(orders.id, o.id)),
            );
            this.#openChecks.delete(o.id);
            this.#d.log.info(
              { botId: o.botId, clOrdID: o.clOrdId },
              "native stop no longer on SoDEX and no trades; recorded as cancelled",
            );
            await this.onOrderClosed(o.sodexAccountId, o.clOrdId, "cancelled", now);
            return;
          }
          // Chờ NOT_FOUND_AFTER_MS tính từ lần đầu không thấy (không từ lúc gửi: lệnh nằm sổ lâu cũng được chờ đủ). Vẫn
          // không thấy thì `unknown` (quy tắc 1.7), không suy là đã huỷ; #reconcile đối soát tiếp. Lệnh bot đã gửi huỷ:
          // không còn trong lệnh mở của SoDEX nên không thể khớp nữa, ghi là đã huỷ.
          const since = this.#missingSince.get(o.id) ?? now;
          this.#missingSince.set(o.id, since);
          if (now - since < NOT_FOUND_AFTER_MS) return;
          this.#missingSince.delete(o.id);
          const wasCancelling = cancelling(o);
          const toUnknown = !(o.status === "cancelled" || wasCancelling);
          // Lệnh đã gửi huỷ sắp được ghi `cancelled` chỉ vì REST không thấy: gửi một lệnh huỷ thật ngay trước đó để sàn có
          // tiếng nói cuối (lệnh vào sổ muộn vẫn còn sống, quy tắc 1.7, review #216 M3). Huỷ không rõ / không gửi được thì
          // chưa ghi gì, lượt sau thử lại.
          if (wasCancelling && o.status !== "cancelled") {
            let last: CancelResult | undefined;
            // Account đang trong nấc chờ vì huỷ bị từ chối cả request: chưa gửi, như chưa rõ (thử lại lượt sau).
            if (this.#cancelBlockedUntil(account.id, now) === null)
              try {
                const res = await this.#d.gateway.cancel(account, [ref], {
                  shard,
                  epoch: held.epoch,
                });
                this.#noteCancelResults(account.id, res);
                [last] = res;
              } catch (error) {
                if (error instanceof FencedError) throw error;
                last = undefined;
              }
            // Request bị từ chối cả gói (429, key, nonce…) như chưa rõ: lệnh huỷ chưa được xử lý (review #216 F1).
            if (
              last === undefined ||
              last.outcome === "unknown" ||
              (last.outcome === "rejected" && last.scope === "request")
            ) {
              this.#missingSince.set(o.id, since);
              this.#d.log.warn(
                {
                  botId: o.botId,
                  clOrdID: o.clOrdId,
                  outcome: last?.outcome,
                  code: last?.outcome === "rejected" ? last.code : undefined,
                },
                "final cancel before recording cancelled was not confirmed; checking again",
              );
              return;
            }
            // Lệnh còn sống và vừa được gỡ khỏi sổ: có thể đã khớp một phần sau lần đọc trade ở trên. Không ghi ngay; lần tra
            // sau ghi trạng thái cuối theo SoDEX (số đã khớp thật), không thấy nữa thì chờ lại NOT_FOUND_AFTER_MS.
            if (last.outcome === "ok") {
              this.#missingSince.set(o.id, now);
              this.#openChecks.delete(o.id);
              this.#d.log.warn(
                { botId: o.botId, clOrdID: o.clOrdId },
                "order SoDEX could not find was still live; cancelled it, recording its final status next check",
              );
              return;
            }
          }
          await this.#fenced({ shard, epoch: held.epoch }, async (tx) => {
            await tx
              .update(orders)
              .set({
                status: toUnknown ? "unknown" : "cancelled",
                reconciledAt: new Date(now),
                // Lần tra thành công xác nhận lệnh không còn ở đâu: mốc bền cho bỏ cuộc và Stop thôi chờ.
                ...(toUnknown ? { missingConfirmedAt: new Date(now) } : {}),
              })
              .where(eq(orders.id, o.id));
            if (toUnknown)
              await tx.insert(botEvents).values({
                botId: o.botId,
                type: "reconcile",
                decision: UNKNOWN_DECISION,
                why: `${o.clOrdId}: not found on SoDEX and no trades yet. Checking again before anything else is sent for it.`,
                occurredAt: new Date(now),
              });
          });
          if (toUnknown)
            this.#d.log.warn(
              { botId: o.botId, clOrdID: o.clOrdId },
              "order not found on SoDEX and no trades; marked unknown",
            );
          if (wasCancelling) this.#pendingCancels.get(o.botId)?.delete(o.clOrdId);
          return;
        }
        this.#missingSince.delete(o.id);
        const expected = cancelling(o);
        await this.#settleOrder(shard, held.epoch, account, o, found, now, expected);
        this.#pendingCancels.get(o.botId)?.delete(o.clOrdId);
        this.#openChecks.delete(o.id);
      },
    );
  }

  /**
   * Market Making (DEC-100). (1) Fill của mọi lệnh bot đã gửi trong 10 phút, kể cả lệnh đã huỷ / thay: đọc lịch sử
   * khớp của SoDEX, phần chưa ghi đi qua `onFill` (tính theo `filledSize` nên mỗi phần chỉ được tính một lần).
   * (2) Vị thế thật trên SoDEX gửi cho chiến lược bằng `positionSync`, chỉ khi đây là bot duy nhất của account
   * trên market đó; nếu không thì không chia được vị thế giữa các bot.
   */
  /** Thử huỷ lại các lệnh mà lần huỷ trước chưa được SoDEX xác nhận (DEC-111). */
  async #retryCancels(shard: number): Promise<void> {
    const now = this.#d.now();
    for (const r of [...this.#runners.values()].filter((x) => x.shard === shard)) {
      const pending = this.#pendingCancels.get(r.botId);
      if (pending === undefined || pending.size === 0) continue;
      // Lệnh SoDEX đã báo không còn trên sổ: chờ #reconcileOpen (DEC-308), nhưng vẫn huỷ lại chậm
      // (mỗi OPEN_CHECK_MS) phòng khi lệnh vào sổ muộn (quy tắc 1.7, review #216 M3).
      const gone = this.#cancelGone.get(r.botId);
      if (gone !== undefined)
        for (const id of gone)
          if (!pending.has(id)) {
            gone.delete(id);
            this.#goneCancelAt.delete(id);
          }
      const normal = [...pending].filter((id) => gone?.has(id) !== true);
      const normalDue =
        normal.length > 0 && now - (this.#cancelRetryAt.get(r.botId) ?? 0) >= CANCEL_RETRY_MS;
      const slow = [...(gone ?? [])].filter(
        (id) => now - (this.#goneCancelAt.get(id) ?? 0) >= OPEN_CHECK_MS,
      );
      const resend = [...(normalDue ? normal : []), ...slow];
      if (resend.length === 0) continue;
      if (normalDue) this.#cancelRetryAt.set(r.botId, now);
      for (const id of slow) this.#goneCancelAt.set(id, now);
      try {
        await this.#cancel(r, resend);
      } catch (error) {
        if (error instanceof FencedError) throw error;
        this.#d.log.warn({ err: error, botId: r.botId }, "cancel retry failed");
      }
    }
  }

  /**
   * Market Making: lệnh còn "open" trong DRIFT quá `MAKER_ORPHAN_MS` mà chiến lược không còn coi là đang sống (ví dụ
   * lần huỷ trước không gửi được rồi chiến lược đã bỏ theo dõi) thì huỷ. Lệnh mồ côi như vậy làm kiểm tra self-trade
   * chặn mọi báo giá ngược chiều (DEC-111). Lưới an toàn bền qua khởi động lại vì đọc từ DB và state đã lưu.
   */
  async #sweepMakerOrphans(r: Runner, now: number): Promise<void> {
    const tracked = (r.state as { orders?: Record<string, { status?: string }> }).orders ?? {};
    const open = await this.#d.db
      .select({ clOrdId: orders.clOrdId })
      .from(orders)
      .where(
        and(
          eq(orders.botId, r.botId),
          inArray(orders.status, ["open", "partially_filled"]),
          lt(orders.submittedAt, new Date(now - MAKER_ORPHAN_MS)),
        ),
      );
    // Lệnh SoDEX đã báo không còn trên sổ khi huỷ: đang chờ #reconcileOpen ghi trạng thái cuối, không huỷ lại.
    const gone = this.#cancelGone.get(r.botId);
    const orphans = open
      .map((o) => o.clOrdId)
      .filter((id) => tracked[id]?.status !== "live" && gone?.has(id) !== true);
    if (orphans.length === 0) return;
    await this.#event(
      r,
      "reconcile",
      `Cancelled ${String(orphans.length)} untracked order${orphans.length === 1 ? "" : "s"}`,
      "An earlier cancel did not go through; the order was still open, so the bot cancelled it.",
      now,
    );
    await this.#cancel(r, orphans);
  }

  async #reconcileMaker(shard: number): Promise<void> {
    const now = this.#d.now();
    const makers = [...this.#runners.values()].filter(
      (r) => r.shard === shard && r.strategy === Strategy.volumeMaker && !r.paper,
    );
    await this.#perAccount(
      "reconcileMaker",
      makers,
      (r) => r.account.id,
      async (r) => {
        const key = `${r.account.id}:${r.market}`;
        if (now - (this.#makerBackfill.get(key) ?? 0) >= MAKER_BACKFILL_MS) {
          this.#makerBackfill.set(key, now);
          await this.#backfillMaker(r, now);
          await this.#sweepMakerOrphans(r, now).catch((error: unknown) => {
            if (error instanceof FencedError) throw error;
            this.#d.log.warn({ err: error, botId: r.botId }, "orphan sweep failed");
          });
        }
      },
    );
  }

  async #backfillMaker(r: Runner, now: number): Promise<void> {
    const sent = await this.#d.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.sodexAccountId, r.account.id),
          eq(orders.market, r.market),
          gt(orders.submittedAt, new Date(now - MAKER_BACKFILL_WINDOW_MS)),
        ),
      );
    if (sent.length === 0) return;
    const byId = new Map(sent.map((o) => [o.clOrdId, o]));
    const trades = (
      await r.gateway.recentTrades(r.account, { market: r.market, engine: "perps" })
    ).filter((t) => byId.has(t.clOrdID));
    if (trades.length === 0) return;
    const recorded = new Set(
      (
        await this.#d.db
          .select({ tradeId: fills.sodexTradeId })
          .from(fills)
          .where(
            inArray(
              fills.orderId,
              sent.map((o) => o.id),
            ),
          )
      ).map((f) => String(f.tradeId)),
    );
    const byOrder = new Map<string, typeof trades>();
    for (const t of trades) byOrder.set(t.clOrdID, [...(byOrder.get(t.clOrdID) ?? []), t]);
    for (const [clOrdID, list] of byOrder) {
      const o = byId.get(clOrdID);
      if (o === undefined) continue;
      const total = list.reduce((a, t) => a.add(t.quantity), dec("0"));
      if (!total.gt(o.filledSize)) continue;
      const value = list.reduce((a, t) => a.add(dec(t.price).mul(t.quantity)), dec("0"));
      const fresh = list.filter((t) => !recorded.has(String(t.tradeId)));
      for (const t of fresh) await this.onTrade(r.account.id, t);
      const fee = fresh.reduce((a, t) => a.add(t.fee), dec("0"));
      await this.onFill(
        r.account.id,
        clOrdID,
        total.toString(),
        value.div(total).toString(),
        fee.toString(),
        now,
      );
    }
  }

  /**
   * Lưới an toàn fill cho mọi bot thật trừ Market Making (đã có #backfillMaker), DEC-303. Lệnh có thể đã
   * khớp mà DRIFT chưa ghi:
   * (a) gửi trong FILL_BACKFILL_WINDOW_MS, chưa khớp đủ và kết thúc không có xác nhận của user stream (`unknown`, hoặc bot
   *     huỷ mà chưa có tin CANCELED): đọc lịch sử khớp tối đa một lần mỗi MAKER_BACKFILL_MS cho account + market;
   * (b) account vừa có khoảng trống user stream: lệnh còn mở hoặc gửi trong MAKER_BACKFILL_WINDOW_MS, đọc MỘT lần cho mỗi
   *     khoảng trống, sau BACKFILL_TRADE_GRACE_MS (M4).
   * Lịch sử khớp dùng chung với đối soát trong vòng. Chỉ trade cũ hơn BACKFILL_TRADE_GRACE_MS được coi là bị mất (tin
   * stream của trade mới hơn có thể đang tới, M5); quyết định chạy trong hàng đợi của lệnh, trên dòng lệnh đọc lại.
   */
  /**
   * Ứng viên của lưới an toàn fill cho cả vòng, MỘT truy vấn (DEC-301): lệnh của runner thật (trừ Market Making) chưa
   * khớp đủ, (a) gửi trong FILL_BACKFILL_WINDOW_MS và `unknown` / bot huỷ mà chưa có tin CANCELED, hoặc (b) của
   * account + engine đang trong khoảng trống stream: còn mở hoặc gửi trong MAKER_BACKFILL_WINDOW_MS.
   */
  async #backfillCandidates(now: number): Promise<OrderRow[]> {
    const runners = [...this.#runners.values()].filter(
      (r) => !r.paper && r.strategy !== Strategy.volumeMaker,
    );
    if (runners.length === 0) return [];
    const gapAccounts = [...new Set(runners.map((r) => r.account.id))].filter(
      (id) => this.#inGap(id, "spot", now) || this.#inGap(id, "perps", now),
    );
    return (
      await this.#d.db
        .select()
        .from(orders)
        .where(
          and(
            inArray(
              orders.botId,
              runners.map((r) => r.botId),
            ),
            or(
              and(
                gt(orders.submittedAt, new Date(now - FILL_BACKFILL_WINDOW_MS)),
                or(
                  eq(orders.status, "unknown"),
                  and(eq(orders.status, "cancelled"), isNull(orders.doneFedAt)),
                ),
              ),
              gapAccounts.length === 0
                ? undefined
                : and(
                    inArray(orders.sodexAccountId, gapAccounts),
                    ne(orders.status, "rejected"),
                    ne(orders.status, "not_placed"),
                    or(
                      inArray(orders.status, ["open", "partially_filled"]),
                      gt(orders.submittedAt, new Date(now - MAKER_BACKFILL_WINDOW_MS)),
                    ),
                  ),
            ),
          ),
        )
    ).filter(
      (o) =>
        dec(o.filledSize).lt(o.size) &&
        (o.status === "unknown" ||
          (o.status === "cancelled" && o.doneFedAt === null) ||
          this.#inGap(o.sodexAccountId, o.engine, now)),
    );
  }

  /**
   * Lưới an toàn fill cho mọi bot thật trừ Market Making (đã có #backfillMaker), DEC-303. Ứng viên đọc
   * một lần mỗi vòng (#backfillCandidates). (a) Lệnh nghi ngờ: đọc lịch sử khớp tối đa một lần mỗi MAKER_BACKFILL_MS cho
   * account + market; (b) khoảng trống stream của account + engine: đọc MỘT lần mỗi khoảng trống, sau
   * BACKFILL_TRADE_GRACE_MS (M4). Lịch sử khớp dùng chung với đối soát trong vòng. Chỉ trade cũ hơn
   * BACKFILL_TRADE_GRACE_MS được coi là bị mất (tin stream của trade mới hơn có thể đang tới, M5); quyết định chạy trong
   * hàng đợi của lệnh, trên dòng lệnh đọc lại.
   */
  async #backfillFills(shard: number, snap: TickSnapshot): Promise<void> {
    const now = this.#d.now();
    const runners = new Map(
      [...this.#runners.values()]
        .filter((r) => r.shard === shard && !r.paper && r.strategy !== Strategy.volumeMaker)
        .map((r) => [r.botId, r]),
    );
    if (runners.size === 0) return;
    const rows = (snap.backfill.get(shard) ?? []).filter((o) => runners.has(o.botId));
    const groups = new Map<string, typeof rows>();
    for (const o of rows) {
      const key = `${o.sodexAccountId}:${o.engine}:${o.market}`;
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    await this.#perAccount(
      "backfillFills",
      [...groups],
      ([, list]) => list[0]?.sodexAccountId ?? "",
      async ([key, list]) => {
        const first = list[0];
        const r = first === undefined ? undefined : runners.get(first.botId);
        if (first === undefined || r === undefined) return;
        const suspect = list.some(
          (o) =>
            (o.submittedAt?.getTime() ?? 0) > now - FILL_BACKFILL_WINDOW_MS &&
            (o.status === "unknown" || (o.status === "cancelled" && o.doneFedAt === null)),
        );
        const gap = this.#streamGaps.get(`${first.sodexAccountId}:${first.engine}`) ?? -Infinity;
        const gapDue =
          now - gap < STREAM_GAP_MS &&
          now - gap >= BACKFILL_TRADE_GRACE_MS &&
          this.#gapBackfilled.get(key) !== gap;
        const suspectDue = suspect && now - (this.#fillBackfill.get(key) ?? 0) >= MAKER_BACKFILL_MS;
        if (!gapDue && !suspectDue) return;
        if (gapDue) this.#gapBackfilled.set(key, gap);
        this.#fillBackfill.set(key, now);
        try {
          await this.#backfillGroup(r.account, first.market, first.engine, list, runners, now);
        } catch (error) {
          if (error instanceof FencedError) throw error;
          this.#d.log.warn({ err: error, accountId: r.account.id }, "fill backfill failed");
        }
      },
    );
  }

  async #backfillGroup(
    account: AccountRef,
    market: string,
    engine: "spot" | "perps",
    list: readonly (typeof orders.$inferSelect)[],
    runners: ReadonlyMap<string, Runner>,
    now: number,
  ): Promise<void> {
    const byId = new Map(list.map((o) => [o.clOrdId, o]));
    // Trade quá mới chưa tính: tin user stream của nó có thể vẫn đang tới (M5).
    const trades = (await this.#accountTrades(account, market, engine)).filter(
      (t) => byId.has(t.clOrdID) && t.at <= now - BACKFILL_TRADE_GRACE_MS,
    );
    if (trades.length === 0) return;
    const byOrder = new Map<string, typeof trades>();
    for (const t of trades) byOrder.set(t.clOrdID, [...(byOrder.get(t.clOrdID) ?? []), t]);
    for (const [clOrdID, own] of byOrder) {
      const listed = byId.get(clOrdID);
      const r = listed === undefined ? undefined : runners.get(listed.botId);
      if (listed === undefined || r === undefined) continue;
      for (const t of own) await this.onTrade(account.id, t);
      // Quyết định trên dòng lệnh đọc lại trong hàng đợi của lệnh: fill của stream tới trong lúc đọc REST đã được tính.
      await this.#inOrderQueue(account.id, clOrdID, async () => {
        const [o] = await this.#d.db.select().from(orders).where(eq(orders.id, listed.id)).limit(1);
        if (o === undefined) return;
        const t = foundFromTrades(o, own, o.sodexOrderId ?? 0n);
        if (t === null || !dec(t.found.filledQty).gt(o.filledSize)) return;
        const avg = t.found.avgPrice ?? "0";
        if (o.doneFedAt !== null && !LATE_FILL_STRATEGIES.has(r.strategy)) {
          await this.#lateFill(r, o, t.found.filledQty, avg, now);
          return;
        }
        this.#d.log.info(
          { botId: o.botId, clOrdID, filled: t.found.filledQty, recorded: o.filledSize },
          "fill found in SoDEX trade history; recording it",
        );
        const fee = feeBeyond(own, o.filledSize).toString();
        await this.#applyOrderFill(account.id, clOrdID, t.found.filledQty, avg, fee, now);
        // IOC không nằm trên sổ: đã có trade nghĩa là lệnh đã xong. Báo chiến lược một lần (sau fill, cùng hàng đợi).
        if (o.doneFedAt === null && o.timeInForce === "IOC" && !isNativeStop(o))
          await this.#finishOrder(
            account.id,
            clOrdID,
            t.found.status === "filled" ? "filled" : "cancelled",
            now,
            null,
          );
      });
    }
  }

  /**
   * Fill tìm thấy sau khi chiến lược đã nhận `orderDone` với ít hơn. Không báo lại (chiến lược có thể đã hành động theo
   * số cũ): ghi số thật vào lệnh, gắn Needs attention và ghi Decisions. Không có reason code nào trong DOMAIN.md 7.2 cho
   * trường hợp này nên không pause. `o` là dòng vừa đọc lại trong hàng đợi của lệnh.
   */
  async #lateFill(
    r: Runner,
    o: typeof orders.$inferSelect,
    filled: string,
    avg: string,
    now: number,
  ): Promise<void> {
    this.#d.log.error(
      { botId: r.botId, clOrdID: o.clOrdId, filled, recorded: o.filledSize },
      "fill found after the strategy was told the order ended; needs attention",
    );
    await this.#fenced(r, async (tx) => {
      await tx
        .update(orders)
        .set({
          filledSize: filled,
          avgPrice: avg,
          reconciledAt: new Date(now),
          ...(dec(filled).gte(o.size) ? { status: "filled" as const } : {}),
        })
        .where(eq(orders.id, o.id));
      await tx.update(bots).set({ needsAttention: true }).where(eq(bots.id, r.botId));
      await tx.insert(botEvents).values({
        botId: r.botId,
        type: "reconcile",
        decision: "Fill found after the order ended",
        why: `${o.clOrdId}: SoDEX shows ${dec(filled).toString()} filled, the bot had counted ${dec(o.filledSize).toString()}. Check this bot's position on SoDEX.`,
        occurredAt: new Date(now),
      });
    });
  }

  // ---------- kiểm tra vị thế thật (DEC-306) ----------

  /** Market Perps bot giữ vị thế (Funding Arb: chân Perps; Copy Trade: mọi market của bot). Bot chỉ Spot: không có. */
  #perpMarketsOf(strategy: string, market: string, engine: string, config: unknown): string[] {
    if (engine === "spot") return [];
    const c = (config ?? {}) as Record<string, unknown>;
    if (typeof c.perpMarket === "string") return [c.perpMarket];
    if (strategy === Strategy.copyTrade) return [...new Set([market, ...copyMarkets(c)])];
    return [market];
  }

  /**
   * Mỗi POSITION_CHECK_MS, mỗi account có runner thật trên Perps: đọc account state SoDEX MỘT lần (mọi vị thế), rồi so
   * với sổ cái của runner ở từng market chỉ có đúng MỘT bot thật của account (kể cả bot paused: vị thế không chia được
   * giữa nhiều bot). Market Making nhận vị thế thật bằng `positionSync` (DEC-100), chiến lược tự xử lý. Không market nào
   * so được thì không đọc. Đọc lỗi (rate limit, mạng) thì bỏ lượt, không làm gì. Market có thêm bot thứ hai: bỏ cảnh báo
   * đã ghi của market đó (không còn biết vị thế nào là của bot nào).
   */
  async #checkPositions(shard: number): Promise<void> {
    const now = this.#d.now();
    const runners = [...this.#runners.values()].filter(
      (r) => r.shard === shard && !r.paper && r.engines.includes("perps"),
    );
    const due = [...new Set(runners.map((r) => r.account.id))].filter(
      (id) =>
        now - (this.#positionCheckAt.get(id) ?? Number.NEGATIVE_INFINITY) >= POSITION_CHECK_MS,
    );
    if (due.length === 0) return;
    for (const id of due) this.#positionCheckAt.set(id, now);
    const rows = await this.#d.db
      .select({
        id: bots.id,
        accountId: bots.sodexAccountId,
        strategy: bots.strategy,
        market: bots.market,
        engine: bots.engine,
        state: bots.state,
        mismatch: bots.positionMismatch,
        config: botVersions.config,
      })
      .from(bots)
      .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
      .where(
        and(
          inArray(bots.sodexAccountId, due),
          eq(bots.mode, "live"),
          inArray(bots.state, [...ENGINE_ACTIVE_STATES, BotState.paused]),
        ),
      );
    const holders = new Map<string, number>();
    for (const b of rows)
      for (const m of this.#perpMarketsOf(b.strategy, b.market, b.engine, b.config)) {
        const key = `${b.accountId}:${m}`;
        holders.set(key, (holders.get(key) ?? 0) + 1);
      }
    for (const b of rows) {
      const shared = Object.keys(b.mismatch ?? {}).filter(
        (m) => (holders.get(`${b.accountId}:${m}`) ?? 0) > 1,
      );
      if (shared.length > 0) await this.#dropMismatch(b.id, shared);
    }
    const stateOf = new Map(rows.map((b) => [b.id, b.state]));
    await this.#perAccount(
      "checkPositions",
      due,
      (id) => id,
      async (accountId) => {
        const pairs = runners
          .filter((r) => r.account.id === accountId)
          .flatMap((r) =>
            this.#perpMarketsOf(r.strategy, r.market, "perps", r.config).flatMap((m) => {
              if (holders.get(`${accountId}:${m}`) === 1 && stateOf.has(r.botId)) return [{ r, m }];
              this.#positionWatch.delete(`${r.botId}:${m}`);
              return [];
            }),
          );
        const first = pairs[0];
        if (first === undefined) return;
        let positions: Map<string, { size: string; entryPrice: string }>;
        try {
          positions = await first.r.gateway.readPositions(first.r.account);
        } catch (error) {
          this.#d.log.info(
            { err: error, accountId },
            "position check skipped: could not read the SoDEX account state",
          );
          return;
        }
        for (const { r, m } of pairs) {
          const p = positions.get(m);
          try {
            if (r.strategy === Strategy.volumeMaker)
              await this.#feed(r, {
                type: "positionSync",
                at: now,
                market: m,
                size: p?.size ?? "0",
                entryPrice: p?.entryPrice ?? "0",
              });
            else
              await this.#comparePosition(r, m, p?.size ?? "0", stateOf.get(r.botId), now, {
                // Chỉ khi lần áp version gần đây bỏ một sổ cái còn vị thế (`initialState`, DEC-38; N2). Volume Farm chỉ áp
                // khi phẳng (DEC-304), version đang chờ chưa đổi sổ cái: lệch lúc đó đi theo bậc 1 / 2 (có đọc trade).
                versionChange:
                  r.resetDroppedPosition &&
                  r.appliedAt !== null &&
                  now - r.appliedAt < POSITION_VERSION_WINDOW_MS,
              });
          } catch (error) {
            if (error instanceof FencedError) throw error;
            this.#d.log.warn({ err: error, botId: r.botId, market: m }, "position check failed");
          }
        }
      },
    );
  }

  /** Bỏ cảnh báo của các market này (không ghi Decisions): bot không còn là bot duy nhất trên market, hoặc đã dừng. */
  async #dropMismatch(botId: string, markets: readonly string[]): Promise<void> {
    const r = this.#runners.get(botId);
    const write = async (tx: Db) => {
      const [b] = await tx
        .select({ mismatch: bots.positionMismatch })
        .from(bots)
        .where(eq(bots.id, botId))
        .for("update");
      const left = Object.fromEntries(
        Object.entries(b?.mismatch ?? {}).filter(([m]) => !markets.includes(m)),
      );
      await tx
        .update(bots)
        .set({ positionMismatch: Object.keys(left).length === 0 ? null : left })
        .where(eq(bots.id, botId));
    };
    if (r === undefined) await this.#d.db.transaction(write);
    else {
      await this.#fenced(r, write);
      const next = new Map(r.positionMismatch);
      for (const m of markets) next.delete(m);
      r.positionMismatch = next;
      if (next.size === 0) r.mismatchWaitLogged = false;
    }
    for (const m of markets) this.#positionWatch.delete(`${botId}:${m}`);
    this.#d.log.info(
      { botId, markets },
      "position mismatch dropped: another bot of the account trades this market",
    );
  }

  /**
   * So vị thế thật với sổ cái của bot trên một market, theo ba bậc (người dùng duyệt 2026-11-17; không pause, không bao
   * giờ tự đóng vị thế). "Cùng độ lệch" = hiệu số thật − sổ cái không đổi (fill đã ghi đổi cả hai số như nhau; fill
   * đang bay làm hiệu số đổi).
   * - bậc 0: lần đầu thấy lệch → chỉ ghi nhớ;
   * - bậc 1: cùng hiệu số qua các lần kiểm tra liên tiếp kéo dài POSITION_CONFIRM_MS, không có lệnh nào của bot đang bay
   *   → đọc lịch sử khớp của account × market một lần (lưới an toàn fill, DEC-303). Bot vừa áp version mới bằng
   *   `initialState` (sổ cái bắt đầu lại trong khi vị thế cũ còn trên SoDEX): không đọc trade, ghi ngay cảnh báo nguyên
   *   nhân "version" (một dòng Decisions riêng);
   * - bậc 2: lần kiểm tra sau đó vẫn cùng hiệu số → `bots.position_mismatch` + một dòng Decisions; bước chiến lược theo thị
   *   trường làm tăng |vị thế thật| bị bỏ cả bước (#feed), lãi / lỗ hiện "Not available" (api).
   * Đã cảnh báo thì khớp POSITION_CLEAR_CHECKS lần liên tiếp mới bỏ (một dòng Decisions).
   */
  async #comparePosition(
    r: Runner,
    market: string,
    real: string,
    botState: BotState | undefined,
    now: number,
    opts: { versionChange: boolean },
  ): Promise<void> {
    // Chỉ bot đang chạy ổn định: lúc starting / pausing / resuming / stopping sổ cái đang đổi.
    if (botState !== BotState.running) return;
    const ledger = positionOf(r.state, market, "perps");
    const step = r.ctx.rules[market]?.stepSize;
    if (ledger === null || step === undefined) return;
    const key = `${r.botId}:${market}`;
    const w = this.#positionWatch.get(key);
    const alerted = r.positionMismatch.get(market);
    const delta = dec(real).sub(ledger);
    const half = dec(step).div(2);
    const fields = { botId: r.botId, market, real, ledger };
    if (delta.abs().lte(half)) {
      if (alerted === undefined) {
        if (w?.backfilledAt != null)
          this.#d.log.info(fields, "position matches the ledger after reading SoDEX trades");
        this.#positionWatch.delete(key);
        return;
      }
      const matches = (w?.matches ?? 0) + 1;
      if (matches < POSITION_CLEAR_CHECKS) {
        this.#positionWatch.set(key, {
          delta: delta.toString(),
          firstSeen: w?.firstSeen ?? now,
          backfilledAt: w?.backfilledAt ?? null,
          matches,
        });
        return;
      }
      this.#positionWatch.delete(key);
      await this.#clearMismatch(r, market, real, now);
      return;
    }
    if (alerted !== undefined) {
      // Vẫn lệch: chặn theo lần đọc mới nhất (vị thế thật và sổ cái lúc đọc, M2); không ghi thêm Decisions.
      r.positionMismatch.set(market, { ...alerted, real, ledger });
      this.#positionWatch.set(key, {
        delta: delta.toString(),
        firstSeen: w?.firstSeen ?? now,
        backfilledAt: w?.backfilledAt ?? null,
        matches: 0,
      });
      return;
    }
    if (w === undefined || dec(w.delta).sub(delta).abs().gt(half)) {
      this.#positionWatch.set(key, {
        delta: delta.toString(),
        firstSeen: now,
        backfilledAt: null,
        matches: 0,
      });
      this.#d.log.info(fields, "position differs from the bot's ledger; checking again");
      return;
    }
    if (w.backfilledAt === null && now - w.firstSeen < POSITION_CONFIRM_MS) return;
    // Lệnh còn bay (kết quả chưa rõ, hoặc vừa gửi: tin khớp có thể đang tới): chờ lần kiểm tra sau.
    if (await this.#positionInFlight(r, market, now)) {
      this.#d.log.info(fields, "position check waits: an order of this bot is in flight");
      return;
    }
    // Sổ cái bắt đầu lại sau khi áp version mới trong lúc vị thế còn mở: đọc trade không giúp được gì.
    if (opts.versionChange && !dec(real).isZero()) {
      await this.#raiseMismatch(r, market, real, ledger, now, "version");
      return;
    }
    if (w.backfilledAt === null) {
      w.backfilledAt = now;
      this.#d.log.warn(fields, "position still differs from the ledger; reading SoDEX trades");
      await this.#positionBackfill(r, market, now);
      return;
    }
    await this.#raiseMismatch(r, market, real, ledger, now, "trades");
  }

  /** Lệnh của bot trên market còn `unknown`, hoặc gửi chưa quá BACKFILL_TRADE_GRACE_MS. */
  async #positionInFlight(r: Runner, market: string, now: number): Promise<boolean> {
    const [row] = await this.#d.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.botId, r.botId),
          eq(orders.market, market),
          or(
            eq(orders.status, "unknown"),
            gt(orders.submittedAt, new Date(now - BACKFILL_TRADE_GRACE_MS)),
          ),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Bậc 1: đọc lịch sử khớp của account × market một lần cho các lệnh gần nhất chưa khớp đủ của bot (DEC-303). */
  async #positionBackfill(r: Runner, market: string, now: number): Promise<void> {
    const list = await this.#d.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.botId, r.botId),
          eq(orders.market, market),
          ne(orders.status, "rejected"),
          ne(orders.status, "not_placed"),
          sql`${orders.filledSize} < ${orders.size}`,
        ),
      )
      .orderBy(desc(orders.submittedAt))
      .limit(POSITION_BACKFILL_ORDERS);
    if (list.length === 0) return;
    await this.#backfillGroup(r.account, market, "perps", list, new Map([[r.botId, r]]), now);
  }

  /**
   * Ghi cảnh báo một lần (bền qua khởi động lại). Không đụng `needs_attention`: lệch vị thế là cờ riêng
   * (`position_mismatch`), api gộp hai cờ khi hiện Needs attention, nên các lý do khác không bị tắt nhầm.
   */
  async #raiseMismatch(
    r: Runner,
    market: string,
    real: string,
    ledger: string,
    now: number,
    cause: MismatchCause,
  ): Promise<void> {
    const next = new Map(r.positionMismatch).set(market, {
      real,
      ledger,
      since: new Date(now).toISOString(),
      cause,
    });
    await this.#fenced(r, async (tx) => {
      await tx
        .update(bots)
        .set({ positionMismatch: Object.fromEntries(next) })
        .where(eq(bots.id, r.botId));
      await tx.insert(botEvents).values({
        botId: r.botId,
        type: "reconcile",
        decision: cause === "version" ? POSITION_UNTRACKED_DECISION : POSITION_MISMATCH_DECISION,
        why:
          cause === "version"
            ? positionUntrackedWhy(market, real)
            : positionMismatchWhy(market, real, ledger),
        occurredAt: new Date(now),
      });
    });
    r.positionMismatch = next;
    this.#d.log.warn(
      { botId: r.botId, market, real, ledger, cause },
      "position on SoDEX does not match the bot's ledger; steps that add to it are held",
    );
  }

  /** Vị thế khớp lại: bỏ cảnh báo của market (một dòng Decisions). */
  async #clearMismatch(r: Runner, market: string, real: string, now: number): Promise<void> {
    const next = new Map(r.positionMismatch);
    next.delete(market);
    await this.#fenced(r, async (tx) => {
      await tx
        .update(bots)
        .set({ positionMismatch: next.size === 0 ? null : Object.fromEntries(next) })
        .where(eq(bots.id, r.botId));
      await tx.insert(botEvents).values({
        botId: r.botId,
        type: "reconcile",
        decision: POSITION_MATCH_DECISION,
        why: positionMatchWhy(market, real),
        occurredAt: new Date(now),
      });
    });
    r.positionMismatch = next;
    if (next.size === 0) r.mismatchWaitLogged = false;
    this.#d.log.info({ botId: r.botId, market, real }, "position matches the ledger again");
  }

  /**
   * Bước chiến lược có lệnh làm tăng |vị thế thật| ở market đang lệch (`opensPosition` với vị thế thật hiệu dụng, cộng
   * lệnh giảm đang chờ trên sổ và lệnh trước nó trong bước). Bước có pause / stop không bao giờ bị giữ.
   */
  #opensBeyondReal(
    r: Runner,
    actions: readonly StrategyAction[],
    pending: ReadonlyMap<string, Decimal>,
  ): boolean {
    if (actions.some((a) => a.type === "pause" || a.type === "stop")) return false;
    const reducing = new Map(pending);
    for (const a of actions) {
      if (a.type !== "place") continue;
      const o = a.order;
      const key = `${o.market}:${o.side}`;
      const before = (reducing.get(key) ?? dec("0")).toString();
      const mm = o.engine === "perps" ? r.positionMismatch.get(o.market) : undefined;
      if (mm !== undefined) {
        const ledgerNow = positionOf(r.state, o.market, "perps");
        const real = effectiveReal(mm.real, mm.ledger, ledgerNow);
        if (opensPosition(o, real, before)) return true;
      }
      reducing.set(key, dec(before).add(o.quantity));
    }
    return false;
  }

  async #settleOrder(
    shard: number,
    epoch: number,
    account: AccountRef,
    o: typeof orders.$inferSelect,
    reported: Extract<LookupResult, { filledQty: string }>,
    now: number,
    /** Bot đã gửi huỷ lệnh này: SoDEX huỷ đúng như vậy thì không ghi Decisions. */
    cancelRequested = false,
    /** Trade của lệnh đã đọc từ SoDEX (không đọc lại). */
    known: OrderTrade[] | null = null,
  ): Promise<void> {
    let found = reported;
    let trades = known;
    const readTrades = () => this.#orderTrades(account, o);
    // IOC SoDEX báo CANCELED mà chưa khớp gì: hỏi trade trước khi tin, lịch sử lệnh REST có thể trễ hơn lịch sử khớp.
    if (
      found.status === "cancelled" &&
      !dec(found.filledQty).gt(0) &&
      o.timeInForce === "IOC" &&
      !isNativeStop(o)
    ) {
      trades ??= await readTrades();
      const confirmed = foundFromTrades(o, trades, found.orderId);
      if (confirmed !== null) {
        this.#d.log.info(
          { botId: o.botId, clOrdID: o.clOrdId, filled: confirmed.found.filledQty },
          "SoDEX reported the IOC cancelled with no fill, but its trades exist; recording the fill",
        );
        found = confirmed.found;
      }
    }
    const delta = sub(found.filledQty, o.filledSize);
    let fee = dec("0");
    if (delta.gt(0)) {
      trades ??= await readTrades();
      for (const t of trades) await this.onTrade(account.id, { ...t, clOrdID: o.clOrdId });
      // Chỉ phí của phần chưa ghi: phần stream đã ghi đã mang phí của nó.
      fee = feeBeyond(trades, o.filledSize);
    }
    const avg = found.avgPrice ?? o.avgPrice;
    const r = this.#runners.get(o.botId);
    if (r !== undefined && delta.gt(0) && avg !== null) {
      await (trades === null
        ? this.onFill(account.id, o.clOrdId, found.filledQty, avg, fee.toString(), now)
        : this.#fillFromTrades(account.id, o.clOrdId, trades, found.filledQty, avg, now));
    }
    await this.#fenced({ shard, epoch }, async (tx) => {
      // Đọc lại trong transaction (khoá dòng): fill có thể vừa được ghi bởi user stream / lưới an toàn, sổ cái đã lưu chỉ
      // cộng phần chưa ghi, và `filledSize` không bao giờ lùi về số cũ hơn của REST.
      const [cur] = await tx
        .select({ filledSize: orders.filledSize })
        .from(orders)
        .where(eq(orders.id, o.id))
        .for("update");
      const curFilled = cur?.filledSize ?? o.filledSize;
      const ledgerDelta = sub(found.filledQty, curFilled);
      await tx
        .update(orders)
        .set({
          status: found.status,
          filledSize: ledgerDelta.lt(0) ? (cur?.filledSize ?? found.filledQty) : found.filledQty,
          avgPrice: avg,
          reconciledAt: new Date(now),
        })
        .where(eq(orders.id, o.id));
      // Huỷ đúng như dự kiến thì không ghi Decisions, nếu không mỗi lượt Volume Farm thêm một dòng. Stop loss gốc
      // SoDEX tự huỷ khi vị thế đóng (DEC-119) cũng là bình thường.
      const stopGone = o.type === "market" && found.status === "cancelled" && !delta.gt(0);
      const asked = cancelRequested && found.status === "cancelled" && !delta.gt(0);
      if (!stopGone && !asked && (delta.gt(0) || o.status !== "cancelled")) {
        await tx.insert(botEvents).values({
          botId: o.botId,
          type: "reconcile",
          decision: `Order ${found.status}`,
          why: `${o.clOrdId}: confirmed from SoDEX (${found.filledQty} filled).`,
          occurredAt: new Date(now),
        });
      }
      if (r !== undefined || !ledgerDelta.gt(0) || avg === null) return;
      // Bot đã dừng: không còn chiến lược để nhận fill, ghi thẳng vào sổ cái để PnL đúng.
      await this.#applyToSavedLedger(
        tx,
        o,
        avg,
        ledgerDelta,
        trades === null ? fee : feeBeyond(trades, curFilled),
        now,
      );
    });
    // Lệnh đã kết thúc trên SoDEX: báo chiến lược một lần (sau fill ở trên, cùng hàng đợi của lệnh).
    if (
      r !== undefined &&
      (found.status === "filled" || found.status === "cancelled" || found.status === "rejected")
    )
      await this.onOrderClosed(account.id, o.clOrdId, found.status, now);
  }

  /** Approval phí khác 50 → pause mọi bot của account (quy tắc 1.5), xử lý ở engine. */
  async #checkFees(shard: number, accounts: readonly AccountRef[]): Promise<void> {
    const now = this.#d.now();
    // Chỉ account có bot tiền thật đang chạy trên worker này: bot paper không bao giờ chạm SoDEX (DEC-105) và revoke phí
    // không pause bot paper (`pauseAccount`), nên đọc approval cho account chỉ có bot paper là thừa.
    const live = new Set<string>();
    for (const r of this.#runners.values())
      if (r.shard === shard && !r.paper) live.add(r.account.id);
    for (const account of accounts) {
      if (!live.has(account.id)) continue;
      if (now - (this.#lastFeeCheck.get(account.id) ?? 0) < this.#d.feeCheckMs) continue;
      this.#lastFeeCheck.set(account.id, now);
      // Một account đọc lỗi (SoDEX lỗi, account không còn) không được làm hỏng cả vòng của shard: các bot khác cùng
      // shard vẫn phải chạy. Không đọc được thì chưa pause, thử lại ở lần kiểm tra sau (DEC-113).
      const approved = await this.#d.gateway.builderApproved(account).catch((error: unknown) => {
        this.#d.log.warn({ err: error, accountId: account.id }, "builder fee check failed");
        return null;
      });
      if (approved !== false) continue;
      await this.pauseAccount(account.id, ReasonCode.builderFeeRevoked);
    }
  }

  /** Pause mọi bot đang chạy của account theo reason phạm vi account. Lệnh đang mở được giữ. */
  async pauseAccount(accountId: string, reason: Reason): Promise<number> {
    if (REASON_CODE_META[reason].scope !== "account")
      throw new RangeError("Not an account-scoped reason");
    let count = 0;
    // Lý do phạm vi account (builder fee, API key, giới hạn rủi ro của tiền thật) không áp cho bot paper (DEC-105).
    for (const r of [...this.#runners.values()].filter(
      (x) => x.account.id === accountId && !x.paper,
    )) {
      await this.#pauseBot(r, reason);
      count += 1;
    }
    return count;
  }
}
