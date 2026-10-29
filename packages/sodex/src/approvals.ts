import { isBuilderFeeApproved } from "@drift/shared";

import type { BuilderApprovals } from "./rest/schemas";

export interface DriftApproval {
  spot: number | null;
  perps: number | null;
  /** Cả Spot và Perps đều ≥ mức của DRIFT (DEC-46). */
  approved: boolean;
}

/** Đọc mức approval của DRIFT trên cả hai engine. `null` = chưa có approval nào. */
export function readDriftApproval(approvals: BuilderApprovals, builderId: bigint): DriftApproval {
  const find = (list: BuilderApprovals["spot"]) =>
    list.find((item) => item.builderID === builderId)?.feeRate ?? null;
  const spot = find(approvals.spot);
  const perps = find(approvals.perps);
  return {
    spot,
    perps,
    approved: isBuilderFeeApproved(spot) && isBuilderFeeApproved(perps),
  };
}
