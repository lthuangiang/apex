import { dec, type DeskRecordView, type WhatIfView } from "@drift/shared";

// AI Desk B+: logic hiển thị thuần của trang chủ, trang so sánh và trang Thành tích (có test).

type Option = WhatIfView["options"][number];
type Row = DeskRecordView["rows"][number];

/** Phương án hiện ở thẻ trang chủ: lựa chọn của Desk AI nếu là một cách sửa, không thì cách sửa đầu tiên có kết quả. */
export function shownFix(w: WhatIfView): Option | null {
  const fixes = w.options.filter((o) => o.key !== "keep" && o.outcome !== null);
  return fixes.find((o) => o.key === w.pick?.key) ?? fixes[0] ?? null;
}

/** Đòn bẩy / stop % sau patch (API tính từ cấu hình đúng version) cho câu chữ; thiếu thì chuỗi rỗng. */
export function optionValues(o: Option): { leverage: string; stop: string } {
  return {
    leverage: o.display?.leverage == null ? "" : String(o.display.leverage),
    stop: o.display?.stopPct ?? "",
  };
}

/** Phương án Desk AI chọn hơn "Keep" bao nhiêu USDC (lý do "better_result"); không tính được → null. */
export function pickGain(w: WhatIfView): string | null {
  const chosen = w.options.find((o) => o.key === w.pick?.key)?.outcome;
  const keep = w.options.find((o) => o.key === "keep")?.outcome;
  if (chosen == null || keep == null) return null;
  return dec(chosen.net).sub(keep.net).toString();
}

export type RecordChip = "helped" | "made_worse" | "no_clear_effect" | "measuring" | "unavailable";

export function recordChip(r: Row): RecordChip {
  if (r.status === "done" && r.verdict !== null) return r.verdict;
  return r.status === "unavailable" ? "unavailable" : "measuring";
}

/** Đòn bẩy trước / sau của lần "Lower leverage"; phương án khác hoặc thiếu dữ liệu → null. */
export function leverageChange(r: Row): { from: string; to: string } | null {
  if (r.option !== "lower_leverage") return null;
  const c = r.changes.find((x) => x.key === "leverage");
  return c?.from == null || c.to === null ? null : { from: c.from, to: c.to };
}
