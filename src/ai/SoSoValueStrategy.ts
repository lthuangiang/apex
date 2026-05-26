/**
 * SoSoValue-driven strategy adjustments
 *
 * Combines 3 signals: Fear & Greed + BTC ETF Net Flow + Macro Events
 *
 * Macro guard is a hard cap — when FOMC/CPI/NFP is today, size is capped at 30%
 * regardless of F&G or ETF signal. Tomorrow's events → 60% cap.
 *
 * F&G + ETF are combined via geometric mean to prevent extreme compounding.
 */

import type { EtfFlowData, EtfFlowSignal, MacroRisk } from './SoSoValueClient.js';

export interface StrategyAdjustment {
  mode: 'aggressive_farm' | 'normal_farm' | 'balanced' | 'cautious_trade' | 'defensive';
  confidenceMultiplier: number;
  sizeMultiplier: number;
  description: string;
  etfSignal?: EtfFlowSignal;
  macroRiskLevel?: MacroRisk['riskLevel'];
}

// ── Fear & Greed base adjustment ─────────────────────────────────────────────

function _computeFGBase(fearGreedIndex: number): { mode: StrategyAdjustment['mode']; size: number; conf: number; label: string } {
  if (fearGreedIndex < 25) {
    return { mode: 'aggressive_farm', size: 1.15, conf: 0.85, label: 'Extreme Fear - Aggressive farm (buy the dip)' };
  } else if (fearGreedIndex < 45) {
    return { mode: 'normal_farm',     size: 1.0,  conf: 0.95, label: 'Fear - Normal farm' };
  } else if (fearGreedIndex < 55) {
    return { mode: 'balanced',        size: 1.0,  conf: 1.0,  label: 'Neutral - Balanced' };
  } else if (fearGreedIndex < 75) {
    return { mode: 'cautious_trade',  size: 0.9,  conf: 1.1,  label: 'Greed - Cautious trade' };
  } else {
    return { mode: 'defensive',       size: 0.8,  conf: 1.2,  label: 'Extreme Greed - Defensive (avoid FOMO)' };
  }
}

// ── ETF flow modifier ─────────────────────────────────────────────────────────

const ETF_ADJUSTMENTS: Record<EtfFlowSignal, { size: number; conf: number }> = {
  strong_bull: { size: 1.08, conf: 0.95 },
  bull:        { size: 1.04, conf: 0.98 },
  neutral:     { size: 1.0,  conf: 1.0  },
  bear:        { size: 0.94, conf: 1.06 },
  strong_bear: { size: 0.88, conf: 1.12 },
};

// ── Main export ───────────────────────────────────────────────────────────────

export function computeStrategyAdjustment(
  fearGreedIndex: number,
  etfFlow?: EtfFlowData | null,
  macroRisk?: MacroRisk | null,
): StrategyAdjustment {
  const fg = _computeFGBase(fearGreedIndex);

  // F&G + ETF combined via geometric mean
  const etfAdj = etfFlow ? ETF_ADJUSTMENTS[etfFlow.signal] : { size: 1.0, conf: 1.0 };
  const combinedSize = Math.sqrt(fg.size * etfAdj.size);
  const combinedConf = Math.sqrt(fg.conf * etfAdj.conf);

  let sizeMultiplier = Math.max(0.5, Math.min(1.3, combinedSize));
  let confidenceMultiplier = Math.max(0.7, Math.min(1.5, combinedConf));

  // Macro guard — hard cap, overrides F&G and ETF when risk is high/elevated
  if (macroRisk && macroRisk.riskLevel !== 'none') {
    sizeMultiplier = Math.min(sizeMultiplier, macroRisk.sizeMultiplier);
    confidenceMultiplier = Math.max(confidenceMultiplier, macroRisk.confidenceMultiplier);
  }

  const etfTag = etfFlow ? ` | ETF: ${etfFlow.signal}` : '';
  const macroTag = macroRisk && macroRisk.riskLevel !== 'none' ? ` | Macro: ${macroRisk.riskLevel}` : '';

  return {
    mode: fg.mode,
    sizeMultiplier,
    confidenceMultiplier,
    description: `${fg.label}${etfTag}${macroTag}`,
    etfSignal: etfFlow?.signal,
    macroRiskLevel: macroRisk?.riskLevel,
  };
}
