import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';

/**
 * Configuration for maker-chunked entry execution.
 */
export interface ChunkedEntryConfig {
  /** USD value per chunk (default: 100) */
  chunkSizeUsd: number;
  /** Seconds to wait for each chunk to fill before cancel+retry (default: 30) */
  chunkTimeoutSecs: number;
  /** Max maker attempts per chunk before escalating to taker (default: 3) */
  maxMakerAttempts: number;
  /** Hard deadline in seconds for total entry — taker all remaining after this (default: 300) */
  maxTotalEntryTimeSecs: number;
}

/**
 * Result of a chunked entry execution.
 */
export interface ChunkedEntryResult {
  filledSizeA: number;
  filledSizeB: number;
  avgPriceA: number;
  avgPriceB: number;
  makerFills: number;
  takerFills: number;
  totalChunks: number;
  elapsedMs: number;
}

/**
 * ChunkedEntryExecutor — splits a large entry into small maker (PostOnly) orders
 * to reduce taker fees by ~70%. Falls back to taker after timeout.
 *
 * Strategy:
 * 1. Split total position into chunks of `chunkSizeUsd`
 * 2. Place PostOnly orders on BOTH legs simultaneously
 * 3. Wait `chunkTimeoutSecs` for fills
 * 4. If filled → next chunk. If not → cancel, retry up to `maxMakerAttempts`
 * 5. After max attempts or hard deadline → taker remaining
 */
export class ChunkedEntryExecutor {
  constructor(
    private readonly adapterA: ExchangeAdapter,
    private readonly adapterB: ExchangeAdapter,
    private readonly config: ChunkedEntryConfig,
  ) {}

  /**
   * Execute chunked entry for both legs.
   *
   * @param symbolA - Symbol on primary exchange
   * @param symbolB - Symbol on hedge exchange
   * @param totalSizeA - Total position size (asset units) for leg A
   * @param totalSizeB - Total position size (asset units) for leg B
   * @param sideA - 'buy' or 'sell' for leg A
   * @param sideB - 'buy' or 'sell' for leg B
   */
  async execute(
    symbolA: string,
    symbolB: string,
    totalSizeA: number,
    totalSizeB: number,
    sideA: 'buy' | 'sell',
    sideB: 'buy' | 'sell',
  ): Promise<ChunkedEntryResult> {
    const startMs = Date.now();
    let remainingA = totalSizeA;
    let remainingB = totalSizeB;
    let makerFills = 0;
    let takerFills = 0;
    let totalChunks = 0;
    let weightedPriceA = 0;
    let weightedPriceB = 0;
    let filledSizeA = 0;
    let filledSizeB = 0;

    // Get initial prices for chunk size calculation
    let priceA = await this.adapterA.get_mark_price(symbolA);
    let priceB = await this.adapterB.get_mark_price(symbolB);

    const deadlineMs = startMs + this.config.maxTotalEntryTimeSecs * 1000;

    while ((remainingA > 0.000001 || remainingB > 0.000001) && Date.now() < deadlineMs) {
      totalChunks++;

      // Refresh prices each chunk for accurate sizing and order placement
      priceA = await this.adapterA.get_mark_price(symbolA);
      priceB = await this.adapterB.get_mark_price(symbolB);

      // Calculate chunk sizes — only place orders for legs that still have remaining
      const chunkA = remainingA > 0.000001 ? Math.min(remainingA, this.config.chunkSizeUsd / priceA) : 0;
      const chunkB = remainingB > 0.000001 ? Math.min(remainingB, this.config.chunkSizeUsd / priceB) : 0;

      // Skip if both chunks too small
      if (chunkA < 0.000001 && chunkB < 0.000001) break;

      // Try maker fill for this chunk (BOTH legs together)
      let filled = false;
      for (let attempt = 0; attempt < this.config.maxMakerAttempts; attempt++) {
        if (Date.now() >= deadlineMs) break;

        const result = await this._tryMakerChunk(
          symbolA, symbolB, chunkA, chunkB, sideA, sideB, priceA, priceB
        );

        // Only count as success if BOTH legs that needed filling actually filled.
        // This prevents one leg racing ahead while the other falls behind.
        const aOk = chunkA < 0.000001 || result.filledA > 0;
        const bOk = chunkB < 0.000001 || result.filledB > 0;

        if (aOk && bOk) {
          // Both filled — success
          weightedPriceA += result.fillPriceA * result.filledA;
          weightedPriceB += result.fillPriceB * result.filledB;
          filledSizeA += result.filledA;
          filledSizeB += result.filledB;
          remainingA -= result.filledA;
          remainingB -= result.filledB;
          makerFills++;
          filled = true;
          console.log(`[ChunkedEntry] Maker fill #${totalChunks}: A=${result.filledA.toFixed(6)} B=${result.filledB.toFixed(6)} (attempt ${attempt + 1})`);
          break;
        } else if (result.filledA > 0 || result.filledB > 0) {
          // Partial: one leg filled but not the other
          // SAFETY: DO NOT continue with imbalanced legs — try to fix immediately
          if (result.filledA > 0 && result.filledB === 0) {
            // Leg A filled, Leg B didn't — taker B with same size as A fill
            console.log(`[ChunkedEntry] ⚠️ Imbalance: A filled ${result.filledA.toFixed(6)} but B=0 — taker B to match`);
            try {
              const freshPriceB = await this.adapterB.get_mark_price(symbolB);
              const freshOb = await this.adapterB.get_orderbook(symbolB);
              const aggressivePrice = sideB === 'buy' ? freshOb.best_ask * 1.001 : freshOb.best_bid * 0.999;
              await this.adapterB.place_limit_order(symbolB, sideB, aggressivePrice, result.filledA, false, 1);
              // Assume B filled at aggressive price
              weightedPriceA += result.fillPriceA * result.filledA;
              weightedPriceB += aggressivePrice * result.filledA;
              filledSizeA += result.filledA;
              filledSizeB += result.filledA;
              remainingA -= result.filledA;
              remainingB -= result.filledA;
              makerFills++;
              filled = true;
            } catch (err) {
              console.error(`[ChunkedEntry] CRITICAL: Cannot match B leg — A is exposed unhedged. Aborting.`, err);
              // Still count A fill so caller knows the imbalance
              weightedPriceA += result.fillPriceA * result.filledA;
              filledSizeA += result.filledA;
              remainingA -= result.filledA;
              filled = true;
            }
          } else if (result.filledB > 0 && result.filledA === 0) {
            // Leg B filled, Leg A didn't — taker A to match
            console.log(`[ChunkedEntry] ⚠️ Imbalance: B filled ${result.filledB.toFixed(6)} but A=0 — taker A to match`);
            try {
              const freshOb = await this.adapterA.get_orderbook(symbolA);
              const aggressivePrice = sideA === 'buy' ? freshOb.best_ask * 1.001 : freshOb.best_bid * 0.999;
              await this.adapterA.place_limit_order(symbolA, sideA, aggressivePrice, result.filledB, false, 1);
              weightedPriceA += aggressivePrice * result.filledB;
              weightedPriceB += result.fillPriceB * result.filledB;
              filledSizeA += result.filledB;
              filledSizeB += result.filledB;
              remainingA -= result.filledB;
              remainingB -= result.filledB;
              makerFills++;
              filled = true;
            } catch (err) {
              console.error(`[ChunkedEntry] CRITICAL: Cannot match A leg — B is exposed unhedged. Aborting.`, err);
              weightedPriceB += result.fillPriceB * result.filledB;
              filledSizeB += result.filledB;
              remainingB -= result.filledB;
              filled = true;
            }
          } else {
            // Both filled partially — both count
            weightedPriceA += result.fillPriceA * result.filledA;
            weightedPriceB += result.fillPriceB * result.filledB;
            filledSizeA += result.filledA;
            filledSizeB += result.filledB;
            remainingA -= result.filledA;
            remainingB -= result.filledB;
            makerFills++;
            filled = true;
          }
          console.log(`[ChunkedEntry] Chunk #${totalChunks} resolved: A=${filledSizeA.toFixed(6)} B=${filledSizeB.toFixed(6)} (attempt ${attempt + 1})`);
          break;
        }

        // Neither filled — retry with fresh prices
        priceA = await this.adapterA.get_mark_price(symbolA);
        priceB = await this.adapterB.get_mark_price(symbolB);
      }

      // If maker failed for this chunk → taker
      if (!filled && (chunkA > 0.000001 || chunkB > 0.000001)) {
        console.log(`[ChunkedEntry] Maker exhausted for chunk #${totalChunks} — escalating to taker`);
        const takerResult = await this._takerFill(symbolA, symbolB, chunkA, chunkB, sideA, sideB);
        weightedPriceA += takerResult.priceA * takerResult.filledA;
        weightedPriceB += takerResult.priceB * takerResult.filledB;
        filledSizeA += takerResult.filledA;
        filledSizeB += takerResult.filledB;
        remainingA -= takerResult.filledA;
        remainingB -= takerResult.filledB;
        takerFills++;
      }
    }

    // Hard deadline reached — taker everything remaining
    if (remainingA > 0.000001 || remainingB > 0.000001) {
      console.log(`[ChunkedEntry] Deadline reached — taker remaining: A=${remainingA.toFixed(6)} B=${remainingB.toFixed(6)}`);
      const takerResult = await this._takerFill(symbolA, symbolB, remainingA, remainingB, sideA, sideB);
      weightedPriceA += takerResult.priceA * takerResult.filledA;
      weightedPriceB += takerResult.priceB * takerResult.filledB;
      filledSizeA += takerResult.filledA;
      filledSizeB += takerResult.filledB;
      takerFills++;
    }

    // Check for leg imbalance — if significant mismatch, warn caller
    const imbalanceRatio = filledSizeA > 0 && filledSizeB > 0
      ? Math.abs(filledSizeA - filledSizeB) / Math.max(filledSizeA, filledSizeB)
      : (filledSizeA > 0 || filledSizeB > 0 ? 1.0 : 0);
    if (imbalanceRatio > 0.05) {
      console.error(`[ChunkedEntry] ⚠️ LEG IMBALANCE: A=${filledSizeA.toFixed(6)} B=${filledSizeB.toFixed(6)} (${(imbalanceRatio * 100).toFixed(1)}% mismatch)`);
    }

    return {
      filledSizeA,
      filledSizeB,
      avgPriceA: filledSizeA > 0 ? weightedPriceA / filledSizeA : priceA,
      avgPriceB: filledSizeB > 0 ? weightedPriceB / filledSizeB : priceB,
      makerFills,
      takerFills,
      totalChunks,
      elapsedMs: Date.now() - startMs,
    };
  }

  /**
   * Try to fill a chunk with PostOnly (maker) on both legs simultaneously.
   * 
   * Flow:
   * 1. Place PostOnly on BOTH Leg A and Leg B
   * 2. Wait chunkTimeoutSecs for fills
   * 3. If BOTH fill → success ✅
   * 4. If ONE fills but other doesn't → escalate unfilled leg to TAKER (never cancel filled leg)
   * 5. If NEITHER fills → return unfilled (caller retries)
   */
  private async _tryMakerChunk(
    symbolA: string, symbolB: string,
    sizeA: number, sizeB: number,
    sideA: 'buy' | 'sell', sideB: 'buy' | 'sell',
    priceA: number, priceB: number,
  ): Promise<{ filledA: number; filledB: number; fillPriceA: number; fillPriceB: number }> {
    // Get orderbook for maker price on both legs
    const obA = await this.adapterA.get_orderbook(symbolA);
    const obB = await this.adapterB.get_orderbook(symbolB);

    // Maker price: join the book (buy at bid, sell at ask)
    const makerPriceA = sideA === 'buy' ? obA.best_bid : obA.best_ask;
    const makerPriceB = sideB === 'buy' ? obB.best_bid : obB.best_ask;

    let orderIdA: string | null = null;
    let orderIdB: string | null = null;

    // Place PostOnly on both legs simultaneously
    try {
      if (sizeA > 0.000001) {
        orderIdA = await this.adapterA.place_limit_order(symbolA, sideA, makerPriceA, sizeA, false, 4);
      }
      if (sizeB > 0.000001) {
        orderIdB = await this.adapterB.place_limit_order(symbolB, sideB, makerPriceB, sizeB, false, 4);
      }
    } catch (err) {
      console.warn(`[ChunkedEntry] Maker order placement failed:`, err);
      if (orderIdA) await this.adapterA.cancel_order(orderIdA, symbolA).catch(() => {});
      if (orderIdB) await this.adapterB.cancel_order(orderIdB, symbolB).catch(() => {});
      return { filledA: 0, filledB: 0, fillPriceA: 0, fillPriceB: 0 };
    }

    // Wait for fills on both legs (poll every 3s)
    // IMPORTANT: "order not open" does NOT mean "filled" — IOC orders disappear even if cancelled.
    // We check position size to verify actual fills.
    const timeoutMs = this.config.chunkTimeoutSecs * 1000;
    const pollInterval = 3_000;
    const deadline = Date.now() + timeoutMs;
    let legAFilled = !orderIdA; // true if no order placed (size was dust)
    let legBFilled = !orderIdB;

    // Get position sizes BEFORE to calculate delta (actual fill)
    const posAStart = orderIdA ? await this.adapterA.get_position(symbolA).catch(() => null) : null;
    const posBStart = orderIdB ? await this.adapterB.get_position(symbolB).catch(() => null) : null;
    const sizeAStart = posAStart ? Math.abs(posAStart.size) : 0;
    const sizeBStart = posBStart ? Math.abs(posBStart.size) : 0;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollInterval));

      // Check if orders left the book (filled OR cancelled)
      if (!legAFilled && orderIdA) {
        const stillOpen = await this._isOrderOpen(this.adapterA, orderIdA, symbolA);
        if (!stillOpen) {
          // Verify fill via position size delta
          const posANow = await this.adapterA.get_position(symbolA).catch(() => null);
          const sizeANow = posANow ? Math.abs(posANow.size) : 0;
          legAFilled = (sizeANow - sizeAStart) >= sizeA * 0.5;
        }
      }
      if (!legBFilled && orderIdB) {
        const stillOpen = await this._isOrderOpen(this.adapterB, orderIdB, symbolB);
        if (!stillOpen) {
          const posBNow = await this.adapterB.get_position(symbolB).catch(() => null);
          const sizeBNow = posBNow ? Math.abs(posBNow.size) : 0;
          legBFilled = (sizeBNow - sizeBStart) >= sizeB * 0.5;
        }
      }

      // Both done → early exit
      if (legAFilled && legBFilled) break;
    }

    // ── Post-timeout: handle partial fills ────────────────────────────────────
    let fillPriceA = makerPriceA;
    let fillPriceB = makerPriceB;

    if (legAFilled && legBFilled) {
      // Both filled as maker → best case ✅
      console.log(`[ChunkedEntry] Both legs filled as maker`);
    } else if (legAFilled && !legBFilled) {
      // Leg A filled, Leg B stuck → cancel B maker, taker B immediately
      console.log(`[ChunkedEntry] Leg A filled, Leg B timeout → taker B`);
      if (orderIdB) await this.adapterB.cancel_order(orderIdB, symbolB).catch(() => {});

      // Get position BEFORE taker attempt to verify fill
      const posBBefore = await this.adapterB.get_position(symbolB).catch(() => null);
      const sizeBBefore = posBBefore ? Math.abs(posBBefore.size) : 0;

      try {
        const freshObB = await this.adapterB.get_orderbook(symbolB);
        fillPriceB = sideB === 'buy' ? freshObB.best_ask : freshObB.best_bid;
        if (fillPriceB <= 0) throw new Error('No valid price in orderbook — market may be illiquid');
        await this.adapterB.place_limit_order(symbolB, sideB, fillPriceB, sizeB, false, 1); // IOC taker

        // Verify fill by checking position actually grew
        await new Promise(r => setTimeout(r, 2000)); // wait for exchange to process
        const posBAfter = await this.adapterB.get_position(symbolB).catch(() => null);
        const sizeBAfter = posBAfter ? Math.abs(posBAfter.size) : 0;
        const actualFill = sizeBAfter - sizeBBefore;

        if (actualFill >= sizeB * 0.5) {
          // At least 50% filled — count as success
          legBFilled = true;
          console.log(`[ChunkedEntry] Taker B verified: filled ${actualFill.toFixed(6)} of ${sizeB.toFixed(6)}`);
        } else {
          // IOC didn't fill (illiquid market) — DO NOT mark as filled
          legBFilled = false;
          console.warn(`[ChunkedEntry] ⚠️ Taker B NOT FILLED (illiquid): wanted ${sizeB.toFixed(6)}, got ${actualFill.toFixed(6)}`);
        }
      } catch (err) {
        console.error(`[ChunkedEntry] Taker B failed after A filled:`, err);
        legBFilled = false;
      }
    } else if (!legAFilled && legBFilled) {
      // Leg B filled, Leg A stuck → cancel A maker, taker A immediately
      console.log(`[ChunkedEntry] Leg B filled, Leg A timeout → taker A`);
      if (orderIdA) await this.adapterA.cancel_order(orderIdA, symbolA).catch(() => {});

      // Get position BEFORE taker attempt
      const posABefore = await this.adapterA.get_position(symbolA).catch(() => null);
      const sizeABefore = posABefore ? Math.abs(posABefore.size) : 0;

      try {
        const freshObA = await this.adapterA.get_orderbook(symbolA);
        fillPriceA = sideA === 'buy' ? freshObA.best_ask : freshObA.best_bid;
        if (fillPriceA <= 0) throw new Error('No valid price in orderbook — market may be illiquid');
        await this.adapterA.place_limit_order(symbolA, sideA, fillPriceA, sizeA, false, 1); // IOC taker

        // Verify fill
        await new Promise(r => setTimeout(r, 2000));
        const posAAfter = await this.adapterA.get_position(symbolA).catch(() => null);
        const sizeAAfter = posAAfter ? Math.abs(posAAfter.size) : 0;
        const actualFill = sizeAAfter - sizeABefore;

        if (actualFill >= sizeA * 0.5) {
          legAFilled = true;
          console.log(`[ChunkedEntry] Taker A verified: filled ${actualFill.toFixed(6)} of ${sizeA.toFixed(6)}`);
        } else {
          legAFilled = false;
          console.warn(`[ChunkedEntry] ⚠️ Taker A NOT FILLED (illiquid): wanted ${sizeA.toFixed(6)}, got ${actualFill.toFixed(6)}`);
        }
      } catch (err) {
        console.error(`[ChunkedEntry] Taker A failed after B filled:`, err);
        legAFilled = false;
      }
    } else {
      // Neither filled → cancel both, return unfilled for retry
      console.log(`[ChunkedEntry] Neither leg filled — cancelling both`);
      if (orderIdA) await this.adapterA.cancel_order(orderIdA, symbolA).catch(() => {});
      if (orderIdB) await this.adapterB.cancel_order(orderIdB, symbolB).catch(() => {});
    }

    return {
      filledA: legAFilled ? sizeA : 0,
      filledB: legBFilled ? sizeB : 0,
      fillPriceA: legAFilled ? fillPriceA : 0,
      fillPriceB: legBFilled ? fillPriceB : 0,
    };
  }

  /**
   * Fill remaining size with IOC (taker) orders — guaranteed fill.
   */
  private async _takerFill(
    symbolA: string, symbolB: string,
    sizeA: number, sizeB: number,
    sideA: 'buy' | 'sell', sideB: 'buy' | 'sell',
  ): Promise<{ filledA: number; filledB: number; priceA: number; priceB: number }> {
    const priceA = await this.adapterA.get_mark_price(symbolA);
    const priceB = await this.adapterB.get_mark_price(symbolB);

    try {
      const tasks: Promise<string>[] = [];
      if (sizeA > 0.000001) {
        // IOC (timeInForce=1) to cross spread
        tasks.push(this.adapterA.place_limit_order(symbolA, sideA, priceA, sizeA, false, 1));
      }
      if (sizeB > 0.000001) {
        tasks.push(this.adapterB.place_limit_order(symbolB, sideB, priceB, sizeB, false, 1));
      }
      await Promise.all(tasks);
    } catch (err) {
      console.error(`[ChunkedEntry] Taker fill failed:`, err);
    }

    return { filledA: sizeA, filledB: sizeB, priceA, priceB };
  }

  /**
   * Check if an order is still open.
   */
  private async _isOrderOpen(adapter: ExchangeAdapter, orderId: string, symbol: string): Promise<boolean> {
    try {
      const orders = await adapter.get_open_orders(symbol);
      return orders.some((o: any) => o.id === orderId);
    } catch {
      return false;
    }
  }
}
