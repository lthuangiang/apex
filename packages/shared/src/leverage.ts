import { Strategy } from "./enums";

// Đòn bẩy trên SoDEX đặt theo account + symbol (DEC-51): bot Perps đổi đòn bẩy cho cả account trên symbol đó.
// Quy tắc chặn / cảnh báo do người dùng chốt 2026-10-29 (UI_REVIEW I3, DEC-58). Hàm thuần: api (check
// "Before it starts") và engine (ngay trước `updateLeverage`) dùng chung.

export interface LeverageSpec {
  market: string;
  leverage: number;
  marginMode: "cross" | "isolated";
}

/**
 * Đòn bẩy + margin mode bot Perps cần trên SoDEX. Funding Arb / Volume Maker không có field margin mode:
 * Cross (mặc định STRATEGIES.md). Bot Spot hoặc không đặt đòn bẩy (TWAP) trả null.
 */
export function leverageSpecOf(
  strategy: string,
  market: string,
  config: unknown,
): LeverageSpec | null {
  const c = (config ?? {}) as { leverage?: unknown; marginMode?: unknown; perpMarket?: unknown };
  if (typeof c.leverage !== "number") return null;
  const perpMarket =
    strategy === Strategy.fundingArb && typeof c.perpMarket === "string" ? c.perpMarket : market;
  return {
    market: perpMarket,
    leverage: c.leverage,
    marginMode: c.marginMode === "isolated" ? "isolated" : "cross",
  };
}

export interface SymbolSetting {
  leverage: number;
  marginMode: "cross" | "isolated";
}

export type LeverageConflict =
  /** Cùng đòn bẩy và margin mode, hoặc SoDEX chưa có thiết lập cho symbol. */
  | { kind: "none" }
  /** Không có vị thế, chỉ khác cài đặt: ✓ kèm cảnh báo + xác nhận riêng. */
  | { kind: "changes"; current: SymbolSetting }
  /** Có vị thế mở trên symbol với thiết lập khác: chặn. */
  | { kind: "position"; current: SymbolSetting }
  /** Bot DRIFT khác đang chạy cùng symbol với thiết lập khác: chặn. */
  | { kind: "bot"; botName: string; other: SymbolSetting };

const mode = (m: string): "cross" | "isolated" =>
  m.toUpperCase() === "ISOLATED" ? "isolated" : "cross";
const same = (a: SymbolSetting, b: SymbolSetting) =>
  a.leverage === b.leverage && a.marginMode === b.marginMode;

export function leverageConflict(
  spec: LeverageSpec,
  state: {
    S: readonly { s: string; l: number; m: string }[];
    P: readonly { s: string; sz: string; l: number; m: string }[];
  },
  others: readonly { name: string; spec: LeverageSpec }[],
): LeverageConflict {
  const want: SymbolSetting = { leverage: spec.leverage, marginMode: spec.marginMode };
  const pos = state.P.find((p) => p.s === spec.market && Number(p.sz) !== 0);
  const set = state.S.find((x) => x.s === spec.market);
  const current: SymbolSetting | null =
    set !== undefined
      ? { leverage: set.l, marginMode: mode(set.m) }
      : pos !== undefined
        ? { leverage: pos.l, marginMode: mode(pos.m) }
        : null;
  if (pos !== undefined && current !== null && !same(current, want))
    return { kind: "position", current };
  const bot = others.find((o) => o.spec.market === spec.market && !same(o.spec, want));
  if (bot !== undefined)
    return {
      kind: "bot",
      botName: bot.name,
      other: { leverage: bot.spec.leverage, marginMode: bot.spec.marginMode },
    };
  if (current !== null && !same(current, want)) return { kind: "changes", current };
  return { kind: "none" };
}
