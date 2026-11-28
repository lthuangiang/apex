// Mẫu response SoDEX Wealth cho test (#589). Hình dạng chép từ response công khai thật ngày 2026-11-28 (`/funds`,
// `/funds/{id}`, `trading-status`, và các route user với địa chỉ zero); số liệu vị thế và mọi địa chỉ là GIẢ.

export const FAKE_WALLET = "0x1111111111111111111111111111111111111111";
const FAKE_TOKEN = "0x2222222222222222222222222222222222222222";

export const fundsFixture = {
  code: 0,
  timestamp: 1795837918664,
  data: [
    {
      fundId: "antb",
      name: "ANT Believers Index",
      fundType: "ssi-v2",
      fundStatus: "live",
      nav: "9.579385871038354",
      asOf: "2026-11-28T03:50:58Z",
      share: { coin: "ANTB.ssi", address: FAKE_TOKEN, decimals: 18 },
    },
    {
      fundId: "CXMT",
      name: "CXMT",
      fundType: "escrow_vault",
      fundStatus: "live",
      nav: "4.937955756657073554",
      aum: "18066.980495",
      asOf: "2026-11-27T08:45:16Z",
      share: { coin: "aCXMT", address: FAKE_TOKEN, decimals: 18 },
    },
    {
      fundId: "vVOO",
      name: "vVOO Fund",
      fundType: "clob",
      fundStatus: "live",
      asOf: "2026-11-28T03:51:53Z",
      share: { coin: "vVOO", address: FAKE_TOKEN, decimals: 8 },
      spot: {
        symbol: "vVOO_vUSDC",
        symbolId: 39,
        displayName: "VOO/USDC",
        quote: { coin: "vUSDC", decimals: 6 },
      },
    },
  ],
};

export const tradingStatusFixtures = {
  antb: {
    code: 0,
    timestamp: 1795837930427,
    data: {
      fundId: "antb",
      vault: "",
      channel: "ssi-v2-rfq",
      closedReason: null,
      nextChannel: null,
      nextChannelAt: null,
      sessionMode: "auto",
      rfq: {
        address: FAKE_TOKEN,
        quotable: true,
        pausedByMaker: false,
        minBuyAmount: "",
        minSellAmount: "",
        expectedDeliveryAt: null,
      },
      batch: null,
      subscription: null,
    },
  },
  CXMT: {
    code: 0,
    timestamp: 1795837930715,
    data: {
      fundId: "CXMT",
      vault: FAKE_TOKEN,
      channel: "closed",
      closedReason: "batch_cutoff",
      nextChannel: "batch",
      nextChannelAt: 1795998600,
      sessionMode: "auto",
      rfq: null,
      batch: { opensAt: 1795762620, cutoffAt: 1795998600, expectedDeliveryAt: 1796022000 },
      subscription: null,
    },
  },
};

export const fundInfoFixture = {
  code: 0,
  timestamp: 1795837929584,
  data: {
    ...fundsFixture.data[1],
    contracts: { vault: FAKE_TOKEN },
    chainConfig: {
      assetDecimals: 6,
      minDeposit: "1",
      minRedeemShares: "0.5",
      mgmtFeeRate: "0",
      perfFeeRate: "0",
      exchangeRate: "4937955756657073554",
      paused: false,
      asOfBlock: 17447073,
    },
    subscription: {
      subscribeDeadline: 1785803400,
      unsubscribeDeadline: 1785112200,
      totalSubscribed: "181692.07",
      minimumSubscribeAmount: "0",
    },
  },
};

/** Ví rỗng: đúng response thật cho địa chỉ zero (địa chỉ thay bằng địa chỉ giả). */
export const emptyUser = {
  positions: {
    code: 0,
    timestamp: 1795837919478,
    data: {
      address: FAKE_WALLET,
      asOfBlock: 17480711,
      summary: { processingCost: "0", pendingProceeds: "0", predepositAssets: "0" },
      positions: [],
      predeposit: { status: "syncing", asOfBlock: 17480711, updatedAt: "2026-11-28T03:51:58Z" },
    },
  },
  pnl: {
    code: 0,
    timestamp: 1795837920018,
    data: {
      address: FAKE_WALLET,
      currency: "USD",
      settledValue: "0",
      totalCost: "0",
      totalPnl: "0",
      totalRealizedPnl: "0",
      totalUnrealizedPnl: "0",
      totalPnl24h: "0",
      inFlightValue: "0",
      totalValue: "0",
      totalWealth: "0",
      complete: true,
      bridgeStatus: "ready",
      positions: [],
    },
  },
  inFlight: { code: 0, timestamp: 1795837920480, data: { address: FAKE_WALLET, funds: [] } },
  fundDetails: {
    code: 0,
    timestamp: 1795837921448,
    data: { address: FAKE_WALLET, totals: [], entries: [] },
  },
  /** Gateway trả lỗi cho ví không có kế hoạch mua định kỳ (thật, 2026-11-28). */
  recurringBuys: { code: -1, timestamp: 1795837921778, error: "internal error" },
  pnlHistory: {
    code: 0,
    timestamp: 1795837922527,
    data: {
      address: FAKE_WALLET,
      currency: "USD",
      interval: "1d",
      range: "1M",
      points: [
        {
          ts: "2026-11-28T03:52:02Z",
          pnl: "0",
          settledValue: "0",
          inFlightValue: "0",
          totalValue: "0",
        },
      ],
      bridgeStatus: "ready",
      accountingFrom: "2026-11-28T03:52:02Z",
    },
  },
  tvl: {
    code: 0,
    timestamp: 1795837976423,
    data: { address: FAKE_WALLET, currency: "USD", settledValue: "", incomplete: false },
  },
};

/** Ví có vị thế: số liệu giả theo các trường của tài liệu Wealth API. */
export const heldUser = {
  pnl: {
    code: 0,
    timestamp: 1795837920018,
    data: {
      address: FAKE_WALLET,
      currency: "USD",
      settledValue: "1162.70",
      totalCost: "1200",
      totalPnl: "-37.30",
      totalRealizedPnl: "0",
      totalUnrealizedPnl: "-37.30",
      totalPnl24h: "11.87",
      inFlightValue: "50",
      totalValue: "1212.70",
      complete: true,
      positions: [
        {
          fundId: "antb",
          source: "vault",
          shares: "104.2",
          avgCostWithAirdrop: "9.6",
          price: "9.57",
          priceAsOf: "2026-11-28T03:50:58Z",
          marketValue: "996.65",
          unrealizedPnl: "-3.35",
          realizedPnl: "0",
          pnl24h: "14.10",
          price24hAgo: "9.43",
          priced: true,
        },
        {
          fundId: "CXMT",
          source: "vault",
          shares: "33.63",
          avgCostWithAirdrop: "5.95",
          price: "4.94",
          marketValue: "166.05",
          unrealizedPnl: "-33.95",
          realizedPnl: "0",
          pnl24h: "-2.23",
          priced: true,
        },
        { fundId: "NEWFUND", source: "vault", shares: "1", priced: false },
      ],
    },
  },
  positions: {
    code: 0,
    timestamp: 1795837919478,
    data: {
      address: FAKE_WALLET,
      asOfBlock: 1,
      summary: { processingCost: "50", pendingProceeds: "0" },
      positions: [
        {
          fundId: "CXMT",
          source: "vault",
          pendingRedeemShares: "10",
          pendingDepositShares: "0",
          processingCost: "0",
          pendingProceeds: "0",
          costBasis: "200",
          ledgerShares: "43.63",
          subscribeShares: "0",
          completedCost: "200",
          redeemedShares: "0",
          asset: { decimals: 6 },
        },
      ],
    },
  },
  inFlight: {
    code: 0,
    timestamp: 1,
    data: {
      address: FAKE_WALLET,
      funds: [
        {
          fundId: "CXMT",
          nav: "",
          inFlight: [
            {
              kind: "redeem",
              stage: "processing",
              direction: "out",
              unit: "shares",
              amount: "10",
              count: 1,
            },
          ],
        },
      ],
    },
  },
  fundDetails: {
    code: 0,
    timestamp: 1,
    data: {
      address: FAKE_WALLET,
      totals: [],
      entries: [
        {
          fundId: "CXMT",
          kind: "redeem",
          status: "processing",
          requestedAt: "2026-11-27T10:02:00Z",
          at: "2026-11-27T10:02:00Z",
          requestedShares: "10",
        },
        {
          fundId: "antb",
          kind: "subscribe",
          transactionType: "recurring_buy",
          source: "recurring_buy",
          status: "completed",
          at: "2026-11-24T09:30:00Z",
          cost: "25",
          shares: "2.6",
        },
      ],
    },
  },
  recurringBuys: {
    code: 0,
    timestamp: 1,
    data: {
      address: FAKE_WALLET,
      availableAssets: "100",
      plans: [
        {
          chainId: "1",
          dcaAddress: FAKE_TOKEN,
          planIndex: "0",
          fundId: "antb",
          target: FAKE_TOKEN,
          amount: "25",
          planType: "WEEKLY",
          dayOfPeriod: 1,
          createdAt: "2026-11-01T00:00:00Z",
          status: "ACTIVE",
          successfulExecutionCount: 3,
          nextScheduledAt: "2026-12-01T09:30:00Z",
          share: { coin: "ANTB.ssi", address: FAKE_TOKEN, decimals: 18 },
          totalBuyAmount: "75",
          totalBuyShares: "7.8",
          avgCost: "9.61",
          processingAmount: "0",
          statisticsComplete: true,
          totalsAllocated: true,
          anomalyCount: 0,
        },
      ],
    },
  },
  executions: {
    code: 0,
    timestamp: 1,
    data: {
      address: FAKE_WALLET,
      chainId: "1",
      dcaAddress: FAKE_TOKEN,
      planIndex: "0",
      executions: [
        {
          scheduledLocalDate: "2026-11-24",
          status: "completed",
          amount: "25",
          executedAt: "2026-11-24T09:30:00Z",
        },
        {
          scheduledLocalDate: "2026-11-17",
          status: "skipped",
          reasonCode: "non_trading_day",
          amount: "25",
        },
      ],
    },
  },
};
