import { describe, it, expect, beforeEach } from 'vitest';
import { MarketMaker } from '../MarketMaker';
import { config } from '../../config';

describe('MarketMaker', () => {
  let mm: MarketMaker;

  beforeEach(() => {
    mm = new MarketMaker();
  });

  // ── 11.1 ─────────────────────────────────────────────────────────────────
  it('11.1 computeEntryBias returns blocked=true with blockReason=inventory_long when cumLong - cumShort > MM_INVENTORY_HARD_BLOCK', () => {
    mm.recordTrade('long', 200);
    const result = mm.computeEntryBias(null, mm.getState());
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe('inventory_long');
  });

  // ── 11.2 ─────────────────────────────────────────────────────────────────
  it('11.2 computeEntryBias returns blocked=true with blockReason=inventory_short when cumShort - cumLong > MM_INVENTORY_HARD_BLOCK', () => {
    mm.recordTrade('short', 200);
    const result = mm.computeEntryBias(null, mm.getState());
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe('inventory_short');
  });

  // ── 11.3 ─────────────────────────────────────────────────────────────────
  it('11.3 computeEntryBias returns pingPongBias = -MM_PINGPONG_BIAS_STRENGTH and biasedDirection = short after a long exit (balanced inventory)', () => {
    const result = mm.computeEntryBias(
      { side: 'long', exitPrice: 100, pnl: 1 },
      mm.getState()
    );
    expect(result.pingPongBias).toBe(-config.MM_PINGPONG_BIAS_STRENGTH);
    expect(result.biasedDirection).toBe('short');
    expect(result.blocked).toBe(false);
  });

  // ── 11.4 ─────────────────────────────────────────────────────────────────
  it('11.4 computeEntryBias returns pingPongBias = +MM_PINGPONG_BIAS_STRENGTH and biasedDirection = long after a short exit (balanced inventory)', () => {
    const result = mm.computeEntryBias(
      { side: 'short', exitPrice: 100, pnl: 1 },
      mm.getState()
    );
    expect(result.pingPongBias).toBe(config.MM_PINGPONG_BIAS_STRENGTH);
    expect(result.biasedDirection).toBe('long');
    expect(result.blocked).toBe(false);
  });

  // ── 11.5 ─────────────────────────────────────────────────────────────────
  it('11.5 computeEntryBias returns pingPongBias = 0 and biasedDirection = null when lastTradeContext = null (balanced inventory)', () => {
    const result = mm.computeEntryBias(null, mm.getState());
    expect(result.pingPongBias).toBe(0);
    expect(result.biasedDirection).toBeNull();
    expect(result.blocked).toBe(false);
  });

  // ── 11.6 ─────────────────────────────────────────────────────────────────
  it('11.6 computeEntryBias returns inventoryBias = -MM_INVENTORY_BIAS_STRENGTH and biasedDirection = short when netExposure > MM_INVENTORY_SOFT_BIAS', () => {
    const result = mm.computeEntryBias(null, {
      cumLongUsd: 100,
      cumShortUsd: 0,
      lastExitSide: null,
      tradeCount: 0,
    });
    expect(result.inventoryBias).toBe(-config.MM_INVENTORY_BIAS_STRENGTH);
    expect(result.biasedDirection).toBe('short');
    expect(result.blocked).toBe(false);
  });

  // ── 11.7 ─────────────────────────────────────────────────────────────────
  it('11.7 computeEntryBias returns inventoryBias = +MM_INVENTORY_BIAS_STRENGTH and biasedDirection = long when netExposure < -MM_INVENTORY_SOFT_BIAS', () => {
    const result = mm.computeEntryBias(null, {
      cumLongUsd: 0,
      cumShortUsd: 100,
      lastExitSide: null,
      tradeCount: 0,
    });
    expect(result.inventoryBias).toBe(config.MM_INVENTORY_BIAS_STRENGTH);
    expect(result.biasedDirection).toBe('long');
    expect(result.blocked).toBe(false);
  });

  // ── 11.8 ─────────────────────────────────────────────────────────────────
  it('11.8 inventory bias direction overrides ping-pong direction when both are active and conflicting', () => {
    // net=100 > 50 → inventory says 'short'; last exit was 'short' → ping-pong says 'long'
    const result = mm.computeEntryBias(
      { side: 'short', exitPrice: 100, pnl: 1 },
      { cumLongUsd: 100, cumShortUsd: 0, lastExitSide: 'short', tradeCount: 1 }
    );
    expect(result.biasedDirection).toBe('short');
    expect(result.inventoryBias).toBe(-config.MM_INVENTORY_BIAS_STRENGTH);
    expect(result.pingPongBias).toBe(config.MM_PINGPONG_BIAS_STRENGTH);
  });

  // ── 11.9 ─────────────────────────────────────────────────────────────────
  it('11.9 computeEntryBias returns inventoryBias = 0 when |netExposure| <= MM_INVENTORY_SOFT_BIAS', () => {
    // net = 30 - 10 = 20 <= 50
    const result = mm.computeEntryBias(null, {
      cumLongUsd: 30,
      cumShortUsd: 10,
      lastExitSide: null,
      tradeCount: 0,
    });
    expect(result.inventoryBias).toBe(0);
  });

  // ── 11.10 ────────────────────────────────────────────────────────────────
  it('11.10 computeDynamicTP returns value <= MM_TP_MAX_USD for typical BTC price and spread', () => {
    const result = mm.computeDynamicTP(95000, 3);
    expect(result).toBeLessThanOrEqual(config.MM_TP_MAX_USD);
  });

  // ── 11.11 ────────────────────────────────────────────────────────────────
  it('11.11 computeDynamicTP returns fee floor when spreadBps = 0', () => {
    // feeFloor = ORDER_SIZE_MIN * entryPrice * FEE_RATE_MAKER * 2 * MM_MIN_FEE_MULT
    //          = 0.003 * 95000 * 0.00012 * 2 * 1.5 = 0.1026
    const expectedFeeFloor =
      config.ORDER_SIZE_MIN * 95000 * config.FEE_RATE_MAKER * 2 * config.MM_MIN_FEE_MULT;
    const result = mm.computeDynamicTP(95000, 0);
    expect(result).toBeCloseTo(expectedFeeFloor, 10);
  });

  // ── 11.12 ────────────────────────────────────────────────────────────────
  it('11.12 computeDynamicTP returns MM_TP_MAX_USD when spread is very wide', () => {
    const result = mm.computeDynamicTP(95000, 1000);
    expect(result).toBe(config.MM_TP_MAX_USD);
  });

  // ── 11.13 ────────────────────────────────────────────────────────────────
  it('11.13 recordTrade(long, 100) increments cumLongUsd by 100, sets lastExitSide=long, increments tradeCount', () => {
    mm.recordTrade('long', 100);
    expect(mm.getState()).toEqual({
      cumLongUsd: 100,
      cumShortUsd: 0,
      lastExitSide: 'long',
      tradeCount: 1,
    });
  });

  // ── 11.14 ────────────────────────────────────────────────────────────────
  it('11.14 recordTrade(short, 50) increments cumShortUsd by 50, sets lastExitSide=short, increments tradeCount', () => {
    mm.recordTrade('short', 50);
    expect(mm.getState()).toEqual({
      cumLongUsd: 0,
      cumShortUsd: 50,
      lastExitSide: 'short',
      tradeCount: 1,
    });
  });

  // ── 11.15 ────────────────────────────────────────────────────────────────
  it('11.15 reset() sets all state fields to initial values', () => {
    mm.recordTrade('long', 100);
    mm.recordTrade('short', 50);
    mm.reset();
    expect(mm.getState()).toEqual({
      cumLongUsd: 0,
      cumShortUsd: 0,
      lastExitSide: null,
      tradeCount: 0,
    });
  });
});
