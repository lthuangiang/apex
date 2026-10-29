import { Decimal, dec, toDecimalString as plain } from "../money";

// Định giá account (màn Overview / Portfolio, DEC-41). Mọi số lấy từ SoDEX:
// - Spot: số dư × giá gần nhất của market `<coin>_vUSDC` (stablecoin = 1); coin không có giá → `unpriced`, không tính.
// - Perps: `av` (cross account value, đã gồm PnL chưa chốt của vị thế cross) + Σ (`iw` + `ur`) của vị thế isolated.
// - Giá thanh lý, PnL chưa chốt lấy nguyên từ SoDEX; không tự ước tính (SCREENS.md mục 9.5).

export const STABLE_COINS = ["vUSDC", "USDC", "vUSDT", "USDT"] as const;

export interface SpotBalanceInput {
  coin: string;
  total: string;
  locked: string;
}

export interface PerpsStateInput {
  av: string;
  am: string;
  /** Margin dùng được cho Isolated (chỉ USDC); null khi SoDEX không trả. */
  ami?: string | null;
  im: string;
  cm: string;
  /** Tài sản thế chấp (Multi-Asset Margin): wb, px (index), mr (collateral ratio), wm (tính vào margin). */
  B?: readonly {
    a: string;
    wb: string;
    px?: string | null;
    mr?: string | null;
    wm?: string | null;
  }[];
  P: readonly {
    s: string;
    m: string;
    sz: string;
    iw: string | null;
    ep: string;
    ur: string;
    l: number;
    lp: string;
  }[];
}

export interface Holding {
  coin: string;
  total: string;
  available: string;
  inOrders: string;
  /** null khi không có giá. */
  value: string | null;
}

export interface OpenPosition {
  market: string;
  side: "long" | "short";
  size: string;
  entryPrice: string;
  /** Giá mark gần nhất; null khi chưa có. */
  markPrice: string | null;
  unrealizedPnl: string;
  leverage: number;
  marginMode: "cross" | "isolated";
  /** null khi SoDEX trả 0 / rỗng: UI hiện "Not provided". */
  liquidationPrice: string | null;
  /** Notional theo giá mark (để tính exposure); null khi chưa có giá. */
  notional: string | null;
}

export interface CollateralRow {
  asset: string;
  balance: string;
  /** Index price của SoDEX; null khi không có. */
  indexPrice: string | null;
  /** wb × px; null khi không có px. */
  value: string | null;
  collateralRatio: string | null;
  marginValue: string | null;
}

/** Số dư theo engine (UI_REVIEW I3, DEC-58): mọi số lấy nguyên từ SoDEX, thiếu thì null. */
export interface AccountsBreakdown {
  spot: {
    /** Σ giá trị các coin đã định giá. */
    value: string;
    /** Stablecoin chưa khoá. */
    available: string;
    /** Stablecoin đang khoá trong lệnh. */
    inOrders: string;
    unpricedCoins: string[];
  };
  perps: {
    /** `av` (+ isolated iw + ur): giá trị theo index, chưa haircut. */
    accountValue: string;
    /** `am`: margin dùng được cho Cross, đã haircut. */
    availableMargin: string;
    /** `ami`: chỉ USDC, dùng cho Isolated. */
    availableIsolated: string | null;
    marginInUse: string;
    unrealizedPnl: string;
    openPositions: number;
    collateral: CollateralRow[];
  } | null;
}

export interface PortfolioValue {
  equity: string;
  available: string;
  /** % margin đang dùng trên equity Perps; null khi equity Perps = 0. */
  marginInUsePct: string | null;
  marginInUse: string;
  unrealizedPnl: string;
  holdings: Holding[];
  positions: OpenPosition[];
  /** Coin có số dư nhưng không có giá: không được tính vào equity. */
  unpriced: string[];
  /** Coin Spot định giá bằng index price `px` của SoDEX (không có market `<coin>_vUSDC`). */
  indexPriced: string[];
  accounts: AccountsBreakdown;
}

const isStable = (coin: string) => (STABLE_COINS as readonly string[]).includes(coin);

export function spotPriceKey(coin: string): string {
  return `${coin.startsWith("v") ? coin : `v${coin}`}_vUSDC`;
}

export function valuePortfolio(
  spot: readonly SpotBalanceInput[],
  perps: PerpsStateInput | null,
  /** Giá gần nhất theo market (spot `vBTC_vUSDC`, perps `BTC-USD`). */
  prices: Readonly<Record<string, string>>,
): PortfolioValue {
  let equity = new Decimal(0);
  let available = new Decimal(0);
  let spotValue = new Decimal(0);
  let spotLocked = new Decimal(0);
  const unpriced: string[] = [];
  const indexPriced: string[] = [];
  const holdings: Holding[] = [];
  // Index price của tài sản thế chấp Perps (`B[].px`): định giá coin Spot không có market `<coin>_vUSDC`.
  const indexPx = new Map((perps?.B ?? []).flatMap((x) => (x.px == null ? [] : [[x.a, x.px]])));
  for (const b of spot) {
    const total = dec(b.total);
    if (total.isZero()) continue;
    const free = total.sub(b.locked);
    const stable = (STABLE_COINS as readonly string[]).includes(b.coin);
    const market = stable ? "1" : (prices[spotPriceKey(b.coin)] ?? null);
    const index = market === null ? (indexPx.get(b.coin) ?? null) : null;
    const price = market ?? index;
    const value = price === null ? null : total.mul(price);
    if (value === null) unpriced.push(b.coin);
    else {
      equity = equity.add(value);
      spotValue = spotValue.add(value);
      if (index !== null) indexPriced.push(b.coin);
    }
    if (stable) {
      available = available.add(free);
      spotLocked = spotLocked.add(b.locked);
    }
    holdings.push({
      coin: b.coin,
      total: plain(total),
      available: plain(free),
      inOrders: plain(dec(b.locked)),
      value: value === null ? null : plain(value),
    });
  }
  const spotAvailable = available;
  const positions: OpenPosition[] = [];
  let unrealized = new Decimal(0);
  let marginInUse = new Decimal(0);
  let perpsEquity = new Decimal(0);
  if (perps !== null) {
    perpsEquity = dec(perps.av);
    for (const p of perps.P) {
      const size = dec(p.sz);
      if (size.isZero()) continue;
      const isolated = p.m.toUpperCase() === "ISOLATED";
      if (isolated) perpsEquity = perpsEquity.add(p.iw ?? "0").add(p.ur);
      unrealized = unrealized.add(p.ur);
      const mark = prices[p.s] ?? null;
      positions.push({
        market: p.s,
        side: size.gt(0) ? "long" : "short",
        size: plain(size.abs()),
        entryPrice: p.ep,
        markPrice: mark,
        unrealizedPnl: p.ur,
        leverage: p.l,
        marginMode: isolated ? "isolated" : "cross",
        liquidationPrice: dec(p.lp).gt(0) ? p.lp : null,
        notional: mark === null ? null : plain(size.abs().mul(mark)),
      });
    }
    marginInUse = dec(perps.cm).add(perps.im);
    available = available.add(perps.am);
    equity = equity.add(perpsEquity);
  }
  const accounts: AccountsBreakdown = {
    spot: {
      value: plain(spotValue),
      available: plain(spotAvailable),
      inOrders: plain(spotLocked),
      unpricedCoins: unpriced,
    },
    perps:
      perps === null
        ? null
        : {
            accountValue: plain(perpsEquity),
            availableMargin: plain(dec(perps.am)),
            availableIsolated: perps.ami == null ? null : plain(dec(perps.ami)),
            marginInUse: plain(marginInUse),
            unrealizedPnl: plain(unrealized),
            openPositions: positions.length,
            // USDC đứng đầu (UI_REVIEW I3).
            collateral: [...(perps.B ?? [])]
              .filter((x) => !dec(x.wb).isZero())
              .sort((x, y) => Number(isStable(y.a)) - Number(isStable(x.a)))
              .map((x) => ({
                asset: x.a,
                balance: plain(dec(x.wb)),
                indexPrice: x.px ?? null,
                value: x.px == null ? null : plain(dec(x.wb).mul(x.px)),
                collateralRatio: x.mr ?? null,
                marginValue: x.wm ?? null,
              })),
          },
  };
  return {
    accounts,
    indexPriced,
    equity: plain(equity),
    available: plain(available),
    marginInUsePct: perpsEquity.gt(0)
      ? plain(marginInUse.div(perpsEquity).mul(100).toDecimalPlaces(4))
      : null,
    marginInUse: plain(marginInUse),
    unrealizedPnl: plain(unrealized),
    holdings,
    positions,
    unpriced,
  };
}
