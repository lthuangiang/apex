import { config } from '../config';

export interface MMEntryBias {
  biasedDirection: 'long' | 'short' | null;
  pingPongBias: number;
  inventoryBias: number;
  blocked: boolean;
  blockReason?: string;
  netExposureUsd: number;
}

export interface MMState {
  cumLongUsd: number;
  cumShortUsd: number;
  lastExitSide: 'long' | 'short' | null;
  tradeCount: number;
}

export interface MarketMakerInterface {
  computeEntryBias(
    lastTradeContext: { side: 'long' | 'short'; exitPrice: number; pnl: number } | null,
    inventoryState: MMState
  ): MMEntryBias;
  computeDynamicTP(entryPrice: number, spreadBps: number): number;
  recordTrade(side: 'long' | 'short', volumeUsd: number): void;
  getState(): MMState;
  reset(): void;
}

export class MarketMaker implements MarketMakerInterface {
  private state: MMState;

  constructor() {
    this.state = {
      cumLongUsd: 0,
      cumShortUsd: 0,
      lastExitSide: null,
      tradeCount: 0,
    };
  }

  getState(): MMState {
    return { ...this.state };
  }

  reset(): void {
    this.state = {
      cumLongUsd: 0,
      cumShortUsd: 0,
      lastExitSide: null,
      tradeCount: 0,
    };
  }

  computeEntryBias(
    lastTradeContext: { side: 'long' | 'short'; exitPrice: number; pnl: number } | null,
    inventoryState: MMState
  ): MMEntryBias {
    const netExposure = inventoryState.cumLongUsd - inventoryState.cumShortUsd;

    // Step 1: Hard block check
    if (netExposure > config.MM_INVENTORY_HARD_BLOCK) {
      return {
        biasedDirection: null,
        pingPongBias: 0,
        inventoryBias: 0,
        blocked: true,
        blockReason: 'inventory_long',
        netExposureUsd: netExposure,
      };
    }
    if (netExposure < -config.MM_INVENTORY_HARD_BLOCK) {
      return {
        biasedDirection: null,
        pingPongBias: 0,
        inventoryBias: 0,
        blocked: true,
        blockReason: 'inventory_short',
        netExposureUsd: netExposure,
      };
    }

    // Step 2: Ping-pong bias
    let pingPongBias = 0;
    let pingPongDirection: 'long' | 'short' | null = null;
    if (lastTradeContext !== null) {
      if (lastTradeContext.side === 'long') {
        pingPongBias = -config.MM_PINGPONG_BIAS_STRENGTH;
        pingPongDirection = 'short';
      } else {
        pingPongBias = config.MM_PINGPONG_BIAS_STRENGTH;
        pingPongDirection = 'long';
      }
    }

    // Step 3: Inventory soft bias
    let inventoryBias = 0;
    let inventoryDirection: 'long' | 'short' | null = pingPongDirection;
    if (netExposure > config.MM_INVENTORY_SOFT_BIAS) {
      inventoryBias = -config.MM_INVENTORY_BIAS_STRENGTH;
      inventoryDirection = 'short';
    } else if (netExposure < -config.MM_INVENTORY_SOFT_BIAS) {
      inventoryBias = config.MM_INVENTORY_BIAS_STRENGTH;
      inventoryDirection = 'long';
    }

    // Step 4: Combine — inventory bias takes precedence when active
    const finalBiasedDirection = inventoryBias !== 0 ? inventoryDirection : pingPongDirection;

    return {
      biasedDirection: finalBiasedDirection,
      pingPongBias,
      inventoryBias,
      blocked: false,
      netExposureUsd: netExposure,
    };
  }

  computeDynamicTP(entryPrice: number, spreadBps: number): number {
    const spreadTarget = (spreadBps / 10000) * entryPrice * config.MM_SPREAD_MULT;
    const feeFloor = config.ORDER_SIZE_MIN * entryPrice * config.FEE_RATE_MAKER * 2 * config.MM_MIN_FEE_MULT;
    return Math.min(Math.max(spreadTarget, feeFloor), config.MM_TP_MAX_USD);
  }

  recordTrade(side: 'long' | 'short', volumeUsd: number): void {
    if (side === 'long') {
      this.state.cumLongUsd += volumeUsd;
    } else {
      this.state.cumShortUsd += volumeUsd;
    }
    this.state.lastExitSide = side;
    this.state.tradeCount += 1;
  }
}
