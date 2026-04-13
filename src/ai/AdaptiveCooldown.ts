import { config } from '../config.js';

export interface AdaptiveCooldownInput {
  recentPnLs: number[];
  lastChopScore: number;
}

export interface AdaptiveCooldownResult {
  cooldownMs: number;
  baseMins: number;
  streakMult: number;
  chopMult: number;
  losingStreak: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeAdaptiveCooldown(input: AdaptiveCooldownInput): AdaptiveCooldownResult {
  // Count losing streak from the end of recentPnLs
  let losingStreak = 0;
  for (let i = input.recentPnLs.length - 1; i >= 0; i--) {
    if (input.recentPnLs[i] < 0) {
      losingStreak++;
    } else {
      break;
    }
  }

  const streakMult = clamp(1.0 + losingStreak * config.CHOP_COOLDOWN_STREAK_FACTOR, 1.0, 4.0);
  const chopMult = clamp(1.0 + input.lastChopScore * config.CHOP_COOLDOWN_CHOP_FACTOR, 1.0, 3.0);

  const baseMins =
    config.COOLDOWN_MIN_MINS +
    Math.random() * (config.COOLDOWN_MAX_MINS - config.COOLDOWN_MIN_MINS);

  const finalMins = clamp(
    baseMins * streakMult * chopMult,
    config.COOLDOWN_MIN_MINS,
    config.CHOP_COOLDOWN_MAX_MINS
  );

  return {
    cooldownMs: finalMins * 60 * 1000,
    baseMins,
    streakMult,
    chopMult,
    losingStreak,
  };
}
