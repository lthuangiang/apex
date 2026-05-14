/**
 * BacktestAdapter — Simulated Exchange Adapter
 *
 * Implements the full `ExchangeAdapter` interface using historical OHLCV data
 * instead of a live exchange connection. Bot logic runs completely unchanged.
 *
 * Requirements: 1.1–1.14
 */

import type {
  ExchangeAdapter,
  Kline,
  Order,
  Position,
  RawTrade,
} from '../adapters/ExchangeAdapter.js';
import type {
  BacktestAdapterConfig,
  BalanceSnapshot,
  PendingOrder,
  SimulatedTrade,
} from './types.js';
import { InsufficientBalanceError, InvalidOrderError } from './types.js';

// ---------------------------------------------------------------------------
// BacktestAdapter
// ---------------------------------------------------------------------------

export class BacktestAdapter implements ExchangeAdapter {
  // ---- Injected data -------------------------------------------------------
  private readonly klines: Map<string, Kline[]>;
  private readonly config: BacktestAdapterConfig;

  // ---- Simulated state -----------------------------------------------------
  private balance: number;
  private readonly positions: Map<string, Position>;
  private readonly pendingOrders: Map<string, PendingOrder>;
  private readonly currentCandle: Map<string, Kline>;

  // ---- Candle index tracking (for fill monotonicity) ----------------------
  /** Maps symbol → current candle index (0-based). */
  private readonly currentCandleIndex: Map<string, number>;

  // ---- Audit logs ----------------------------------------------------------
  private readonly tradeLog: SimulatedTrade[];
  private readonly balanceHistory: BalanceSnapshot[];

  // -------------------------------------------------------------------------

  constructor(
    klines: Map<string, Kline[]>,
    initialBalance: number,
    config: BacktestAdapterConfig,
  ) {
    this.klines = klines;
    this.balance = initialBalance;
    this.config = config;

    this.positions = new Map();
    this.pendingOrders = new Map();
    this.currentCandle = new Map();
    this.currentCandleIndex = new Map();
    this.tradeLog = [];
    this.balanceHistory = [];
  }

  // =========================================================================
  // Clock control — called by BacktestRunner
  // =========================================================================

  /**
   * Advance the simulated clock to the given candle for `symbol`.
   * Updates `currentCandle`, increments the candle index, then checks fills.
   *
   * Requirements: 2.1–2.13
   */
  advanceTo(candle: Kline, symbol: string): void {
    this.currentCandle.set(symbol, candle);

    // Increment candle index (starts at 0 for the first candle)
    const prevIndex = this.currentCandleIndex.get(symbol) ?? -1;
    this.currentCandleIndex.set(symbol, prevIndex + 1);

    this._checkFills(candle, symbol);
  }

  // =========================================================================
  // _checkFills — order fill simulation (task 2.2)
  // =========================================================================

  /**
   * Check whether any pending orders for `symbol` should be filled on `candle`.
   *
   * Fill rules:
   *  - Buy limit fills when `candle.low <= order.price`
   *  - Sell limit fills when `candle.high >= order.price`
   *  - Orders placed at the current candle index are skipped (fill monotonicity)
   *  - Fill price depends on `fillMode`: optimistic → limit price, realistic → candle close,
   *    pessimistic → limit price ± slippage
   *  - Fee = fillPrice * size * makerFeeBps / 10000
   *  - If a fill would make balance negative, throw `InsufficientBalanceError` and leave
   *    the order in the queue (balance and position unchanged)
   *
   * Requirements: 2.1–2.13
   */
  protected _checkFills(candle: Kline, symbol: string): void {
    const currentIdx = this.currentCandleIndex.get(symbol) ?? 0;
    const slip = this.config.slippageBps / 10_000;

    // Collect orders to fill in a separate pass to avoid mutating the map
    // while iterating over it.
    const toFill: PendingOrder[] = [];

    for (const order of this.pendingOrders.values()) {
      if (order.symbol !== symbol) continue;

      // Req 2.12 — fill monotonicity: skip orders placed in this same tick
      if (order.placedAtCandleIndex === currentIdx) continue;

      // Req 2.1 — buy limit fills when candle.low <= order.price
      // Req 2.2 — sell limit fills when candle.high >= order.price
      const shouldFill =
        (order.side === 'buy' && candle.l <= order.price) ||
        (order.side === 'sell' && candle.h >= order.price);

      if (shouldFill) {
        toFill.push(order);
      }
    }

    for (const order of toFill) {
      // ---- Determine fill price (Req 2.3–2.6) ----------------------------
      let fillPrice: number;
      const mode = this.config.fillMode ?? 'realistic';

      if (mode === 'optimistic') {
        // Req 2.3 — fill at exact limit price
        fillPrice = order.price;
      } else if (mode === 'realistic') {
        // Req 2.4 — fill at candle close
        fillPrice = candle.c;
      } else {
        // pessimistic — apply slippage (Req 2.5, 2.6)
        if (order.side === 'buy') {
          fillPrice = order.price * (1 + slip);
        } else {
          fillPrice = order.price * (1 - slip);
        }
      }

      // ---- Compute fee (Req 2.7, 2.8) ------------------------------------
      const fee = fillPrice * order.size * (this.config.makerFeeBps / 10_000);

      // ---- Balance sufficiency check (Req 2.13) --------------------------
      // For a buy: we deduct (fillPrice * size) + fee from balance
      // For a sell: we credit (fillPrice * size) and deduct fee
      const balanceDelta =
        order.side === 'buy'
          ? -(fillPrice * order.size + fee)   // cost + fee
          : fillPrice * order.size - fee;     // proceeds - fee

      if (this.balance + balanceDelta < 0) {
        throw new InsufficientBalanceError(
          `InsufficientBalanceError: fill of order ${order.id} (${order.side} ${order.size} @ ${fillPrice}) ` +
          `would reduce balance from ${this.balance.toFixed(4)} to ` +
          `${(this.balance + balanceDelta).toFixed(4)}`,
        );
      }

      // ---- Apply balance update (Req 2.7, 2.8) ---------------------------
      this.balance += balanceDelta;

      // ---- Compute realized PnL if this fill closes an existing position ----
      // We need to check the position BEFORE applying the fill to get the entry price.
      const existingPos = this.positions.get(order.symbol);
      let grossPnl = 0;
      let closingSize = 0;
      let entryPriceForPnl = fillPrice;

      if (existingPos && existingPos.size > 0) {
        // Determine if this fill reduces/closes the existing position
        const isClosingLong = existingPos.side === 'long' && order.side === 'sell';
        const isClosingShort = existingPos.side === 'short' && order.side === 'buy';

        if (isClosingLong || isClosingShort) {
          closingSize = Math.min(order.size, existingPos.size);
          entryPriceForPnl = existingPos.entryPrice;

          if (isClosingLong) {
            // Sell closes long: grossPnl = (fillPrice - entryPrice) * closingSize
            grossPnl = (fillPrice - existingPos.entryPrice) * closingSize;
          } else {
            // Buy closes short: grossPnl = (entryPrice - fillPrice) * closingSize
            grossPnl = (existingPos.entryPrice - fillPrice) * closingSize;
          }
        }
      }

      // ---- Apply position update (Req 2.9) --------------------------------
      this._applyPositionFill(order, fillPrice, candle);

      // ---- Remove from pending queue (Req 2.10) ---------------------------
      this.pendingOrders.delete(order.id);

      // ---- Append SimulatedTrade record (Req 2.11) -----------------------
      const tradeId = crypto.randomUUID();
      const fillTime = new Date(candle.t).toISOString();

      // Determine trade side from order side
      const tradeSide: 'long' | 'short' = order.side === 'buy' ? 'long' : 'short';

      const netPnl = grossPnl - fee;

      const trade: SimulatedTrade = {
        id: tradeId,
        symbol: order.symbol,
        side: tradeSide,
        entryPrice: closingSize > 0 ? entryPriceForPnl : fillPrice,
        exitPrice: fillPrice,
        size: order.size,
        entryTime: fillTime,
        exitTime: fillTime,
        holdingPeriodSecs: 0,
        grossPnl,
        netPnl,
        feePaid: fee,
        exitReason: closingSize > 0 ? 'SIGNAL' : 'FILL',
      };

      this.appendTrade(trade);
    }
  }

  // =========================================================================
  // _applyPositionFill — update positions map after a fill
  // =========================================================================

  /**
   * Update the positions map when an order is filled.
   *
   * - Buy fill → increases long position (or reduces short)
   * - Sell fill → increases short position (or reduces long)
   *
   * Requirement 2.9
   */
  private _applyPositionFill(order: PendingOrder, fillPrice: number, candle: Kline): void {
    const existing = this.positions.get(order.symbol);

    if (order.side === 'buy') {
      if (!existing || existing.size === 0) {
        // Open a new long position
        this.positions.set(order.symbol, {
          symbol: order.symbol,
          side: 'long',
          size: order.size,
          entryPrice: fillPrice,
          unrealizedPnl: 0,
        });
      } else if (existing.side === 'long') {
        // Add to existing long — compute weighted average entry price
        const totalSize = existing.size + order.size;
        const avgEntry =
          (existing.entryPrice * existing.size + fillPrice * order.size) / totalSize;
        this.positions.set(order.symbol, {
          ...existing,
          size: totalSize,
          entryPrice: avgEntry,
          unrealizedPnl: 0,
        });
      } else {
        // Reduce or flip short position
        if (order.size >= existing.size) {
          // Close short (and possibly flip to long)
          const remaining = order.size - existing.size;
          if (remaining > 0) {
            this.positions.set(order.symbol, {
              symbol: order.symbol,
              side: 'long',
              size: remaining,
              entryPrice: fillPrice,
              unrealizedPnl: 0,
            });
          } else {
            this.positions.delete(order.symbol);
          }
        } else {
          // Partial close of short
          this.positions.set(order.symbol, {
            ...existing,
            size: existing.size - order.size,
          });
        }
      }
    } else {
      // sell
      if (!existing || existing.size === 0) {
        // Open a new short position
        this.positions.set(order.symbol, {
          symbol: order.symbol,
          side: 'short',
          size: order.size,
          entryPrice: fillPrice,
          unrealizedPnl: 0,
        });
      } else if (existing.side === 'short') {
        // Add to existing short — weighted average entry
        const totalSize = existing.size + order.size;
        const avgEntry =
          (existing.entryPrice * existing.size + fillPrice * order.size) / totalSize;
        this.positions.set(order.symbol, {
          ...existing,
          size: totalSize,
          entryPrice: avgEntry,
          unrealizedPnl: 0,
        });
      } else {
        // Reduce or flip long position
        if (order.size >= existing.size) {
          const remaining = order.size - existing.size;
          if (remaining > 0) {
            this.positions.set(order.symbol, {
              symbol: order.symbol,
              side: 'short',
              size: remaining,
              entryPrice: fillPrice,
              unrealizedPnl: 0,
            });
          } else {
            this.positions.delete(order.symbol);
          }
        } else {
          // Partial close of long
          this.positions.set(order.symbol, {
            ...existing,
            size: existing.size - order.size,
          });
        }
      }
    }

    // Req 3 (Position Consistency): clear zero-size positions
    const pos = this.positions.get(order.symbol);
    if (pos && pos.size === 0) {
      this.positions.delete(order.symbol);
    }

    // Suppress unused-variable warning for candle (used for timestamp context)
    void candle;
  }

  // =========================================================================
  // ExchangeAdapter — market data
  // =========================================================================

  /**
   * Returns the close price of the current candle for `symbol`.
   * Requirement 1.2
   */
  async get_mark_price(symbol: string): Promise<number> {
    const candle = this.currentCandle.get(symbol);
    if (!candle) {
      throw new Error(`BacktestAdapter: no current candle for symbol "${symbol}"`);
    }
    return candle.c;
  }

  /**
   * Returns a synthetic orderbook derived from the current candle close price
   * and the configured slippage.
   *
   * best_bid = close * (1 - slippageBps / 10000)
   * best_ask = close * (1 + slippageBps / 10000)
   *
   * Requirement 1.3
   */
  async get_orderbook(symbol: string): Promise<{ best_bid: number; best_ask: number }> {
    const candle = this.currentCandle.get(symbol);
    if (!candle) {
      throw new Error(`BacktestAdapter: no current candle for symbol "${symbol}"`);
    }
    const slip = this.config.slippageBps / 10_000;
    return {
      best_bid: candle.c * (1 - slip),
      best_ask: candle.c * (1 + slip),
    };
  }

  /**
   * Returns a synthetic orderbook depth (two levels on each side).
   * Requirement 1.1 (must implement all ExchangeAdapter methods)
   */
  async get_orderbook_depth(
    symbol: string,
    limit: number,
  ): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    const candle = this.currentCandle.get(symbol);
    if (!candle) {
      throw new Error(`BacktestAdapter: no current candle for symbol "${symbol}"`);
    }
    const slip = this.config.slippageBps / 10_000;
    const levels = Math.max(1, limit);

    const bids: [number, number][] = [];
    const asks: [number, number][] = [];
    for (let i = 0; i < levels; i++) {
      const offset = slip * (i + 1);
      bids.push([candle.c * (1 - offset), candle.v / levels]);
      asks.push([candle.c * (1 + offset), candle.v / levels]);
    }
    return { bids, asks };
  }

  /**
   * Returns synthetic recent trades constructed from the most recent candles.
   * Each candle contributes one synthetic trade record (alternating buy/sell).
   *
   * Requirement 1.13
   */
  async get_recent_trades(symbol: string, limit: number): Promise<RawTrade[]> {
    const allKlines = this.klines.get(symbol) ?? [];
    const currentIdx = this.currentCandleIndex.get(symbol) ?? -1;

    // Collect up to `limit` candles ending at the current index (inclusive)
    const endIdx = currentIdx; // inclusive
    const startIdx = Math.max(0, endIdx - limit + 1);

    const trades: RawTrade[] = [];
    for (let i = startIdx; i <= endIdx && i < allKlines.length; i++) {
      const k = allKlines[i];
      trades.push({
        side: i % 2 === 0 ? 'buy' : 'sell',
        price: k.c,
        size: k.v,
        timestamp: k.t,
      });
    }
    return trades;
  }

  /**
   * Returns up to `limit` historical klines for `symbol` with timestamps
   * ≤ the current simulated time.
   *
   * Requirement 1.14
   */
  async get_klines(symbol: string, _interval: string, limit: number): Promise<Kline[]> {
    const allKlines = this.klines.get(symbol) ?? [];
    const currentIdx = this.currentCandleIndex.get(symbol) ?? -1;

    if (currentIdx < 0) {
      return [];
    }

    // Include candles from index 0 up to and including currentIdx
    const endIdx = currentIdx; // inclusive
    const startIdx = Math.max(0, endIdx - limit + 1);

    return allKlines.slice(startIdx, endIdx + 1);
  }

  // =========================================================================
  // ExchangeAdapter — order management
  // =========================================================================

  /**
   * Places a limit order into the pending orders queue.
   *
   * Validates price > 0 and size > 0; throws `InvalidOrderError` otherwise.
   * Assigns a UUID order ID and stamps `placedAtCandleIndex`.
   *
   * Requirements: 1.4, 1.5
   */
  async place_limit_order(
    symbol: string,
    side: 'buy' | 'sell',
    price: number,
    size: number,
    reduceOnly?: boolean,
    // timeInForce is accepted but ignored in simulation (Req 1.4)
    _timeInForce?: number,
  ): Promise<string> {
    if (price <= 0) {
      throw new InvalidOrderError(
        `place_limit_order: price must be > 0, got ${price}`,
      );
    }
    if (size <= 0) {
      throw new InvalidOrderError(
        `place_limit_order: size must be > 0, got ${size}`,
      );
    }

    const orderId = crypto.randomUUID();
    const candleIndex = this.currentCandleIndex.get(symbol) ?? -1;
    const candle = this.currentCandle.get(symbol);

    const order: PendingOrder = {
      id: orderId,
      symbol,
      side,
      price,
      size,
      reduceOnly: reduceOnly ?? false,
      placedAtCandleIndex: candleIndex,
      placedAt: candle ? new Date(candle.t).toISOString() : new Date().toISOString(),
    };

    this.pendingOrders.set(orderId, order);
    return orderId;
  }

  /**
   * Cancels a pending order by ID.
   * Returns `true` if found and removed, `false` if not found.
   *
   * Requirements: 1.6, 1.7
   */
  async cancel_order(order_id: string, _symbol: string): Promise<boolean> {
    if (this.pendingOrders.has(order_id)) {
      this.pendingOrders.delete(order_id);
      return true;
    }
    return false;
  }

  /**
   * Cancels all pending orders for `symbol`.
   * Always returns `true` (even if there were no orders).
   *
   * Requirement 1.8
   */
  async cancel_all_orders(symbol: string): Promise<boolean> {
    for (const [id, order] of this.pendingOrders) {
      if (order.symbol === symbol) {
        this.pendingOrders.delete(id);
      }
    }
    return true;
  }

  /**
   * Returns all pending (unfilled) orders for `symbol`.
   *
   * Requirement 1.9
   */
  async get_open_orders(symbol: string): Promise<Order[]> {
    const result: Order[] = [];
    for (const order of this.pendingOrders.values()) {
      if (order.symbol === symbol) {
        result.push({
          id: order.id,
          symbol: order.symbol,
          side: order.side,
          price: order.price,
          size: order.size,
          status: 'open',
        });
      }
    }
    return result;
  }

  // =========================================================================
  // ExchangeAdapter — account state
  // =========================================================================

  /**
   * Returns the `Position` for `symbol` with `unrealizedPnl` computed from
   * `markPrice ?? currentCandle.close`. Returns `null` if no open position.
   *
   * Requirements: 1.10, 1.11
   */
  async get_position(symbol: string, markPrice?: number): Promise<Position | null> {
    const pos = this.positions.get(symbol);
    if (!pos || pos.size === 0) {
      return null;
    }

    // Determine the effective mark price
    const candle = this.currentCandle.get(symbol);
    const effectiveMark = markPrice ?? candle?.c ?? pos.entryPrice;

    // Compute unrealized PnL
    let unrealizedPnl: number;
    if (pos.side === 'long') {
      unrealizedPnl = (effectiveMark - pos.entryPrice) * pos.size;
    } else {
      // short
      unrealizedPnl = (pos.entryPrice - effectiveMark) * pos.size;
    }

    return {
      symbol: pos.symbol,
      side: pos.side,
      size: pos.size,
      entryPrice: pos.entryPrice,
      unrealizedPnl,
    };
  }

  /**
   * Returns the current simulated cash balance.
   *
   * Requirement 1.12
   */
  async get_balance(): Promise<number> {
    return this.balance;
  }

  // =========================================================================
  // Metrics access
  // =========================================================================

  /** Returns the full trade log (all completed simulated trades). */
  getTradeLog(): SimulatedTrade[] {
    return [...this.tradeLog];
  }

  /** Returns the balance history (one snapshot per recorded tick). */
  getBalanceHistory(): BalanceSnapshot[] {
    return [...this.balanceHistory];
  }

  // =========================================================================
  // Internal helpers (accessible to subclasses / task 2.2)
  // =========================================================================

  /** Direct read access to the balance (for _checkFills in task 2.2). */
  protected getBalance(): number {
    return this.balance;
  }

  /** Direct write access to the balance (for _checkFills in task 2.2). */
  protected setBalance(value: number): void {
    this.balance = value;
  }

  /** Direct read access to the positions map (for _checkFills in task 2.2). */
  protected getPositions(): Map<string, Position> {
    return this.positions;
  }

  /** Direct read access to the pending orders map (for _checkFills in task 2.2). */
  protected getPendingOrders(): Map<string, PendingOrder> {
    return this.pendingOrders;
  }

  /** Direct read access to the current candle index map (for _checkFills in task 2.2). */
  protected getCurrentCandleIndex(): Map<string, number> {
    return this.currentCandleIndex;
  }

  /** Direct read access to the current candle map (for _checkFills in task 2.2). */
  protected getCurrentCandle(): Map<string, Kline> {
    return this.currentCandle;
  }

  /** Append a trade record to the trade log (for _checkFills in task 2.2). */
  protected appendTrade(trade: SimulatedTrade): void {
    this.tradeLog.push(trade);
  }

  /** Append a balance snapshot to the history (called by BacktestRunner). */
  recordBalanceSnapshot(snapshot: BalanceSnapshot): void {
    this.balanceHistory.push(snapshot);
  }

  /** Expose the full klines map (read-only) for use by BacktestRunner. */
  getKlinesMap(): ReadonlyMap<string, Kline[]> {
    return this.klines;
  }

  /** Expose the adapter config (read-only). */
  getConfig(): Readonly<BacktestAdapterConfig> {
    return this.config;
  }
}
