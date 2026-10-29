// Enum số của SoDEX (request dùng số, response dùng chuỗi). Nguồn: docs/SODEX.md mục 5.6.

export const SodexSide = { buy: 1, sell: 2 } as const;
export type SodexSide = (typeof SodexSide)[keyof typeof SodexSide];

export const SodexOrderType = { limit: 1, market: 2 } as const;
export type SodexOrderType = (typeof SodexOrderType)[keyof typeof SodexOrderType];

/** FOK=2 không được hỗ trợ. GTX là post-only. */
export const SodexTimeInForce = { gtc: 1, ioc: 3, gtx: 4 } as const;
export type SodexTimeInForce = (typeof SodexTimeInForce)[keyof typeof SodexTimeInForce];

export const SodexOrderModifier = { normal: 1, stop: 2, bracket: 3, attachedStop: 4 } as const;
export type SodexOrderModifier = (typeof SodexOrderModifier)[keyof typeof SodexOrderModifier];

/** Lệnh chỉ nhận BOTH. */
export const SodexPositionSide = { both: 1, long: 2, short: 3 } as const;
export type SodexPositionSide = (typeof SodexPositionSide)[keyof typeof SodexPositionSide];

export const SodexStopType = { stopLoss: 1, takeProfit: 2 } as const;
export type SodexStopType = (typeof SodexStopType)[keyof typeof SodexStopType];

/** Lệnh chỉ nhận MARK_PRICE. */
export const SodexTriggerType = { lastPrice: 1, markPrice: 2, indexPrice: 3 } as const;
export type SodexTriggerType = (typeof SodexTriggerType)[keyof typeof SodexTriggerType];

export const SodexMarginMode = { isolated: 1, cross: 2 } as const;
export type SodexMarginMode = (typeof SodexMarginMode)[keyof typeof SodexMarginMode];

/** Action type được hash. Spot dùng tên batch theo cả hai SDK chính thức (docs/SODEX.md mục 5.5). */
export const SodexActionType = {
  spotNewOrder: "batchNewOrder",
  spotCancelOrder: "batchCancelOrder",
  perpsNewOrder: "newOrder",
  perpsCancelOrder: "cancelOrder",
  /** `POST /perps/trade/leverage` (Go SDK `UpdateLeverageRequest`). */
  perpsUpdateLeverage: "updateLeverage",
} as const;
