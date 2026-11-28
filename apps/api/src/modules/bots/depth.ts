import {
  AppError,
  dec,
  DEPTH_LEVELS,
  ErrorCode,
  inDepthCapScope,
  maxPositionsOf,
  parseDepthCapMarkets,
  positionDepthIssue,
  raisedPositions,
  sideNotional,
  type DepthCapScope,
  type MaxPosition,
  type PositionDepthIssue,
} from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import type { BookTop } from "@drift/strategies";

import { TtlCache } from "../chart/service";

// Kiểm tổng vị thế tối đa theo sổ lệnh lúc tạo / sửa bot tiền thật (DEC-402 mục 5, #590): trên market `Thin` /
// `Very thin` (một phía dưới 10.000 USD notional 10 mức), tổng vị thế tối đa không lớn hơn phía mỏng hơn; sổ rỗng một
// phía thì không tạo. Market đủ sâu không bị kiểm. Bot paper không áp. Bot đang chạy không bao giờ bị dừng vì quy tắc này:
// chỉ kiểm khi TẠO, và khi SỬA làm tăng tổng vị thế tối đa ở market nào đó.

/** Sổ 10 mức cache ngắn theo market (DEC-402 mục 4: cache 30–60 s, đọc qua bucket IP chung). */
export const DEPTH_CHECK_CACHE_MS = 30_000;

type BookRest = Pick<SodexRestClient, "getOrderbook">;

const caches = new WeakMap<BookRest, TtlCache<BookTop | null>>();

/**
 * Đỉnh sổ 10 mức của một market (giá tốt nhất + tổng notional mỗi phía); `null` khi một phía rỗng. Đọc lỗi ném
 * `SODEX_UNAVAILABLE`: không kiểm được thì không cho tạo (không đoán độ sâu).
 */
export async function bookDepth(
  deps: { rest: BookRest; now: () => Date },
  engine: "spot" | "perps",
  market: string,
): Promise<BookTop | null> {
  let cache = caches.get(deps.rest);
  if (cache === undefined) {
    cache = new TtlCache<BookTop | null>(200);
    caches.set(deps.rest, cache);
  }
  return cache
    .get(`${engine}:${market}`, DEPTH_CHECK_CACHE_MS, deps.now().getTime(), async () => {
      const b = await deps.rest.getOrderbook(engine, market, DEPTH_LEVELS);
      const [bid] = b.bids;
      const [ask] = b.asks;
      if (bid === undefined || ask === undefined) return null;
      return {
        bid: bid[0],
        ask: ask[0],
        bidNotional: sideNotional(b.bids),
        askNotional: sideNotional(b.asks),
      };
    })
    .catch((error: unknown) => {
      if (error instanceof AppError && error.code === ErrorCode.rateLimited) throw error;
      throw new AppError(
        ErrorCode.sodexUnavailable,
        "Can't read this market's order book on SoDEX right now. Try again in a moment.",
      );
    });
}

/** Câu lỗi (câu chữ PM duyệt 2026-11-28, PR #597). */
export const depthIssueMessage = (issue: PositionDepthIssue): string =>
  issue.kind === "empty"
    ? `${issue.market} has no orders on one side of the order book. Try again when it trades.`
    : `Too large for ${issue.market}'s order book: max position is ${issue.limit} USD here (the thinner side of the top 10 levels).`;

/** Giá giữa của sổ, chỉ để quy TWAP (khối lượng base) ra notional. */
const midOf = (b: BookTop) => dec(b.bid).add(b.ask).div(2).toString();

/**
 * Ném `VALIDATION_FAILED` (`reason: "order_book_depth"`) khi một market của bot mỏng hơn tổng vị thế tối đa (hoặc sổ rỗng).
 * `before`: cấu hình đang có khi SỬA; chỉ market tăng tổng vị thế tối đa mới bị kiểm.
 */
export async function assertDepthFits(
  deps: { rest: BookRest; now: () => Date; depthCapMarkets?: DepthCapScope | undefined },
  strategy: string,
  config: Record<string, unknown>,
  before?: Record<string, unknown>,
): Promise<void> {
  // Chỉ market trong `DEPTH_CAP_MARKETS` (DEC-402 bổ sung 2026-11-28): ngoài danh sách thì không đọc sổ, không kiểm.
  const scope = deps.depthCapMarkets ?? parseDepthCapMarkets(undefined);
  const inScope = (m: string) => inDepthCapScope(scope, m);
  const books = new Map<string, BookTop | null>();
  const read = async (p: Pick<MaxPosition, "engine" | "market">) => {
    const key = `${p.engine}:${p.market}`;
    if (!books.has(key)) books.set(key, await bookDepth(deps, p.engine, p.market));
    return books.get(key) ?? null;
  };
  // TWAP tính theo base: cần giá, lấy giá giữa của chính sổ đang kiểm.
  let price: string | undefined;
  if (strategy === "twap" && typeof config.market === "string" && inScope(config.market)) {
    const b = await read({
      engine: config.engine === "perps" ? "perps" : "spot",
      market: config.market,
    });
    if (b === null) {
      const issue: PositionDepthIssue = { kind: "empty", market: config.market };
      throw new AppError(ErrorCode.validationFailed, depthIssueMessage(issue), {
        reason: "order_book_depth",
        market: issue.market,
      });
    }
    price = midOf(b);
  }
  const after = maxPositionsOf(strategy, config, price);
  const check =
    before === undefined ? after : raisedPositions(maxPositionsOf(strategy, before, price), after);
  for (const p of check) {
    if (!inScope(p.market)) continue;
    if (p.market === "" || !dec(p.notional).gt(0)) continue;
    const issue = positionDepthIssue(p, await read(p));
    if (issue !== null)
      throw new AppError(ErrorCode.validationFailed, depthIssueMessage(issue), {
        reason: "order_book_depth",
        market: issue.market,
        ...(issue.kind === "too_large" ? { maxPosition: issue.limit } : {}),
      });
  }
}
