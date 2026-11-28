import type {
  UsMarketRow,
  UsMarketsResponse,
  WealthFundRow,
  WealthMeResponse,
} from "@drift/shared";

// Dữ liệu giả cho test US Market (#591): số theo bản phác màn 02 (dữ liệu mẫu), không địa chỉ ví.

export const NOW = Date.parse("2026-11-28T12:00:00.000Z");
export const READ_AT = "2026-11-28T11:59:40.000Z";

export const antPerps = (over: Partial<UsMarketRow> = {}): UsMarketRow => ({
  symbol: "ANT-USD",
  engine: "perps",
  displayName: "ANT-USD",
  fundId: null,
  fundName: null,
  maxLeverage: 10,
  lastPrice: "91.38",
  volume24h: "129004.1",
  lastTradeAt: "2026-11-28T11:58:00.000Z",
  bookStatus: "trading",
  depth: {
    bidsNotional: "2449",
    asksNotional: "1955",
    bidLevels: 10,
    askLevels: 10,
    label: "thin",
    maxPositionUsd: "1955",
  },
  ...over,
});

export const antSpot = (over: Partial<UsMarketRow> = {}): UsMarketRow => ({
  symbol: "vANT_vUSDC",
  engine: "spot",
  displayName: "ANT/USDC",
  fundId: null,
  fundName: null,
  maxLeverage: null,
  lastPrice: "91.42",
  volume24h: "6812.4",
  lastTradeAt: "2026-11-28T11:00:00.000Z",
  bookStatus: "trading",
  depth: {
    bidsNotional: "410",
    asksNotional: "4990",
    bidLevels: 6,
    askLevels: 10,
    label: "very_thin",
    maxPositionUsd: "410",
  },
  ...over,
});

const token = (symbol: string, fundName: string, daysAgo: number): UsMarketRow => ({
  symbol,
  engine: "spot",
  displayName: null,
  fundId: `${symbol}-fund`,
  fundName,
  maxLeverage: null,
  lastPrice: null,
  volume24h: null,
  lastTradeAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
  bookStatus: "empty",
  depth: {
    bidsNotional: "0",
    asksNotional: "0",
    bidLevels: 0,
    askLevels: 0,
    label: "very_thin",
    maxPositionUsd: "0",
  },
});

export const fund = (over: Partial<WealthFundRow> = {}): WealthFundRow => ({
  fundId: "unitree",
  name: "UNITREE FUND",
  fundType: "Vault",
  fundStatus: "active",
  nav: "99",
  aum: "202644.9",
  asOf: null,
  spotSymbol: null,
  requests: {
    channel: "open",
    open: true,
    closedReason: null,
    nextChannel: null,
    nextChannelAt: null,
  },
  ...over,
});

export const markets = (over: Partial<UsMarketsResponse> = {}): UsMarketsResponse => ({
  readAt: READ_AT,
  anthropic: [antPerps(), antSpot()],
  fundTokens: {
    status: "ok",
    items: [
      token("vVOO_vUSDC", "vVOO Fund", 3),
      token("vQQQ_vUSDC", "QQQ Fund", 1),
      token("vSCHD_vUSDC", "vSCHD Fund", 11),
      token("vSMH_vUSDC", "vSMH Fund", 2),
      token("vVGT_vUSDC", "vVGT Fund", 4),
    ],
  },
  funds: {
    status: "ok",
    items: [
      fund(),
      fund({
        fundId: "cxmt",
        name: "CXMT",
        nav: "4.94",
        aum: null,
        requests: {
          channel: "closed",
          open: false,
          closedReason: null,
          nextChannel: "open",
          nextChannelAt: "2026-11-30T09:00:00.000Z",
        },
      }),
    ],
  },
  ...over,
});

export const wealthOk = (): WealthMeResponse => ({
  status: "ok",
  readAt: READ_AT,
  summary: {
    currency: "USD",
    totalValue: "2662.72",
    settledValue: null,
    totalCost: "2680",
    totalPnl: "201.39",
    totalRealizedPnl: null,
    totalUnrealizedPnl: null,
    totalPnl24h: "-12.05",
    inFlightValue: null,
    complete: true,
  },
  holdings: [
    {
      fundId: "cxmt",
      name: "CXMT",
      fundType: "Vault",
      shares: "33.63",
      price: "4.94",
      marketValue: "166.05",
      avgCost: null,
      unrealizedPnl: null,
      realizedPnl: null,
      pnl24h: null,
      pendingRedeemShares: null,
      pendingDepositShares: null,
      priced: true,
    },
  ],
  inFlight: { status: "not_provided" },
  activity: { status: "not_provided" },
  recurringBuys: { status: "not_provided" },
  pnlHistory: { status: "not_provided" },
});
