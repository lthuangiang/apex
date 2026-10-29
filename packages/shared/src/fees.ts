import { Decimal } from "./money";

/**
 * Builder fee cố định của DRIFT (DEC-46, thay DEC-04): `maxFeeRate = 10`.
 * Đơn vị của SoDEX là phần mười basis point, nên 10 = 1 bp = 0.01%.
 */
export const DRIFT_BUILDER_FEE_RATE = 10;

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
 */
export function isBuilderAccount(sodexAccountId: bigint, builderId: bigint): boolean {
  return sodexAccountId === builderId;
}

/**
 * Approval đủ cho DRIFT khi mức đã approve ≥ mức DRIFT gửi trên lệnh. SoDEX thu min(approve, phí trên lệnh),
 * nên người đã approve mức cao hơn (ví dụ 50 từ trước DEC-46) vẫn chỉ trả 0.01% (DEC-46).
 */
export function isBuilderFeeApproved(maxFeeRate: number | null): boolean {
  return maxFeeRate !== null && maxFeeRate >= DRIFT_BUILDER_FEE_RATE;
}

/**
 * Phí cơ bản của SoDEX (%), dùng khi chưa đo được phí thực của người dùng (reco, backtest). Nguồn: SoDEX
 * support "Trading Experience" (tra ngày 2026-10-28). Phí thật theo tier 14 ngày của từng người (DEC-39/40).
 */
export const SODEX_BASE_FEE_PCT = {
  spot: { maker: "0.04", taker: "0.07" },
  perps: { maker: "0.015", taker: "0.045" },
} as const;
