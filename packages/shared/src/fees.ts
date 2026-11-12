import { Decimal, type DecimalInput } from "./money";

/**
 * Builder fee cố định của DRIFT (DEC-46, thay DEC-04): `maxFeeRate = 10`.
 * Đơn vị của SoDEX là phần mười basis point, nên 10 = 1 bp = 0.01%.
 */
export const DRIFT_BUILDER_FEE_RATE = 10;

/**
 * Builder fee theo chiến lược (DEC-94): Market Making 0.003%, Volume Farming 0.005%, còn lại 0.01%. Approval vẫn là
 * `DRIFT_BUILDER_FEE_RATE` (mức tối đa); lệnh chỉ gắn mức thấp hơn hoặc bằng, nên không phải ký lại.
 */
export const BUILDER_FEE_RATE_BY_STRATEGY: Readonly<Record<string, number>> = {
  volume_maker: 3,
  volume_farm: 5,
};

/** Builder fee mặc định của một chiến lược (phần mười bp). */
export function builderFeeRateOf(strategy: string): number {
  return BUILDER_FEE_RATE_BY_STRATEGY[strategy] ?? DRIFT_BUILDER_FEE_RATE;
}

/** Mức riêng theo chiến lược mà team đặt cho một user (DEC-159); thiếu key = mặc định. */
export type BuilderFeeOverrides = Readonly<Record<string, number>>;

/**
 * Builder fee gắn vào lệnh của user cho một chiến lược: mức team đặt riêng nếu có, không thì mặc định. Luôn kẹp trong
 * 0…`DRIFT_BUILDER_FEE_RATE` vì SoDEX từ chối lệnh có builder fee trên mức user đã approve (DEC-46).
 */
export function builderFeeRateFor(strategy: string, overrides?: BuilderFeeOverrides): number {
  const rate = overrides?.[strategy] ?? builderFeeRateOf(strategy);
  return Math.min(Math.max(rate, 0), DRIFT_BUILDER_FEE_RATE);
}

/** Giá trị approval khi người dùng revoke (DEC-04). */
export const BUILDER_FEE_REVOKED_RATE = 0;

const TENTHS_BP_PER_PERCENT = 1000;

/** Đổi phần mười bp sang phần trăm, ví dụ 50 → 0.05. */
export function feeRateToPercent(rate: number): Decimal {
  if (!Number.isInteger(rate) || rate < 0) {
    throw new RangeError("Fee rate must be a non-negative integer in tenths of a basis point");
  }
  return new Decimal(rate).dividedBy(TENTHS_BP_PER_PERCENT);
}

/** Đổi phần mười bp sang tỷ lệ, ví dụ 50 → 0.0005. */
export function feeRateToFraction(rate: number): Decimal {
  return feeRateToPercent(rate).dividedBy(100);
}

/**
 * Account SoDEX của chính builder (primaryAccountID = DRIFT_BUILDER_ID): không thu builder fee của chính mình,
 * không cần approve (DEC-47). Chỉ master wallet của builder điều khiển được account này.
 * `exempt = false` (env `DRIFT_BUILDER_ACCOUNT_EXEMPT=false`, DEC-124): account builder bị thu phí như mọi account.
 */
export function isBuilderAccount(
  sodexAccountId: bigint,
  builderId: bigint,
  exempt = true,
): boolean {
  return exempt && sodexAccountId === builderId;
}

/**
 * Approval đủ cho DRIFT khi mức đã approve ≥ mức DRIFT gửi trên lệnh. SoDEX thu min(approve, phí trên lệnh),
 * nên người đã approve mức cao hơn (ví dụ 50 từ trước DEC-46) vẫn chỉ trả 0.01% (DEC-46).
 */
export function isBuilderFeeApproved(maxFeeRate: number | null): boolean {
  return maxFeeRate !== null && maxFeeRate >= DRIFT_BUILDER_FEE_RATE;
}

/**
 * Phí cơ bản của SoDEX (%), chỉ là dự phòng khi không đọc được `makerFee` / `takerFee` của market từ
 * `/{spot,perps}/markets/symbols` và chưa đo được phí thực của người dùng. Nguồn: `/symbols` mainnet (tra ngày
 * 2026-11-04; DEC-112). Phí thật theo tier 14 ngày của từng người (DEC-39/40).
 */
export const SODEX_BASE_FEE_PCT = {
  spot: { maker: "0.035", taker: "0.065" },
  perps: { maker: "0.012", taker: "0.04" },
} as const;

/**
 * Phần builder fee rơi vào một lần khớp trung bình (DEC-112): Perps thu cả hai chiều, Spot chỉ thu chiều bán
 * (SODEX.md mục 5.3), nên một vòng mua + bán Spot chịu builder fee một lần.
 */
const BUILDER_LEGS_PER_ROUND_TRIP = { spot: 1, perps: 2 } as const;

export interface FeeInput {
  engine: "spot" | "perps";
  /** Phí maker SoDEX (%) của market hoặc của người dùng; không có thì dùng `SODEX_BASE_FEE_PCT`. */
  makerPct?: DecimalInput | null | undefined;
  /** Builder fee của chiến lược (phần mười bp), thường là `builderFeeRateOf(strategy)`; 0 với account builder. */
  builderRate: number;
}

/** Phí khứ hồi (%) của một vòng vào + ra bằng lệnh maker: 2 × SoDEX maker + builder fee theo số chiều bị thu. */
export function roundTripFeePct(input: FeeInput): Decimal {
  const maker = new Decimal(input.makerPct ?? SODEX_BASE_FEE_PCT[input.engine].maker);
  return maker
    .mul(2)
    .add(feeRateToPercent(input.builderRate).mul(BUILDER_LEGS_PER_ROUND_TRIP[input.engine]));
}

/** Phí một chiều trung bình (tỷ lệ thô, ví dụ "0.00017") = nửa phí khứ hồi; là `StepContext.feeRate` của bot. */
export function oneWayFeeFraction(input: FeeInput): Decimal {
  return roundTripFeePct(input).div(200);
}

/**
 * Phí một chiều trung bình của lệnh taker (tỷ lệ thô, ví dụ "0.00045"): SoDEX taker + builder fee chia theo số chiều
 * như `oneWayFeeFraction`. Là `StepContext.takerFeeRate` (DEC-117).
 */
export function oneWayTakerFeeFraction(
  input: Omit<FeeInput, "makerPct"> & { takerPct?: DecimalInput | null | undefined },
): Decimal {
  const taker = new Decimal(input.takerPct ?? SODEX_BASE_FEE_PCT[input.engine].taker);
  return taker
    .mul(2)
    .add(feeRateToPercent(input.builderRate).mul(BUILDER_LEGS_PER_ROUND_TRIP[input.engine]))
    .div(200);
}

/** Builder fee thật sự gắn trên một lần khớp (phần mười bp): Spot mua không bị thu (DEC-112). */
export function builderRateOnFill(
  engine: "spot" | "perps",
  side: "buy" | "sell",
  rate: number,
): number {
  return engine === "spot" && side === "buy" ? 0 : rate;
}
