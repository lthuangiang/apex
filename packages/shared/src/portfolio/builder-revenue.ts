import { dec, toDecimalString as plain } from "../money";

// Đối soát builder revenue (SODEX.md mục 5.4): tổng `builderFee` trên fill của DRIFT so với biến động số dư
// tài khoản builder trong ngày. Khớp → `matched`; lệch hoặc thiếu số dư → `pending`, phần chênh không tính
// vào doanh thu. Builder revenue không bao giờ trộn vào equity / PnL của người dùng.

/** Sai số làm tròn cho phép khi so (đơn vị quote). */
export const RECONCILE_TOLERANCE = "0.000001";

export interface ReconcileInput {
  date: string;
  engine: "spot" | "perps";
  fromFills: string;
  /** Số dư cuối ngày − đầu ngày; null khi thiếu snapshot. */
  balanceDelta: string | null;
}

export interface ReconcileRow extends ReconcileInput {
  difference: string | null;
  status: "matched" | "pending";
  /** Doanh thu được ghi nhận: chỉ phần giải thích được bằng fill. */
  recognized: string;
}

export function reconcileBuilderDay(r: ReconcileInput): ReconcileRow {
  if (r.balanceDelta === null)
    return { ...r, difference: null, status: "pending", recognized: "0" };
  const diff = dec(r.balanceDelta).sub(r.fromFills);
  const matched = diff.abs().lte(RECONCILE_TOLERANCE);
  return {
    ...r,
    difference: plain(diff),
    status: matched ? "matched" : "pending",
    // Lệch thì chỉ ghi nhận phần nhỏ hơn giữa fill và số dư thực tăng (không ghi nhận phần không giải thích được).
    recognized: matched
      ? r.fromFills
      : dec(r.fromFills).lt(r.balanceDelta)
        ? r.fromFills
        : dec(r.balanceDelta).lt(0)
          ? "0"
          : r.balanceDelta,
  };
}

/** Biến động số dư theo ngày từ snapshot cuối ngày (ngày d = snapshot(d) − snapshot(d−1)). */
export function balanceDeltas(
  snapshots: readonly { date: string; engine: "spot" | "perps"; balance: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const engine of ["spot", "perps"] as const) {
    const list = snapshots
      .filter((s) => s.engine === engine)
      .sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev === undefined || cur === undefined) continue;
      out.set(`${cur.date}:${engine}`, plain(dec(cur.balance).sub(prev.balance)));
    }
  }
  return out;
}
