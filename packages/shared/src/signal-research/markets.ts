import { z } from "zod";

// Danh sách market SoDEX cho Signal research (#305, PM chọn phương án (a) ở review #324). Module Signal research của api
// không được chạm SoDEX (DEC-322 / DEC-327), nên scheduler (đã đọc danh sách perps khi nhận lease và mỗi vòng
// `mmModelTick`) ghi bản chụp vào Redis `sr:markets`; api chỉ đọc bản chụp đó. Hàm ở đây thuần, không I/O.

export const SR_MARKETS_KEY = "sr:markets";
/** Bản chụp cũ hơn ngần này là "stale" (web ghi "Market list may be out of date"). */
export const SR_MARKETS_STALE_MS = 15 * 60_000;

export const srMarketsSnapshotSchema = z.object({
  updatedAt: z.iso.datetime(),
  markets: z.array(
    z.object({
      name: z.string().min(1),
      baseCoin: z.string().nullable(),
      displayName: z.string().nullable(),
      /** Trạng thái SoDEX (`TRADING`, `HALT`…). */
      status: z.string(),
    }),
  ),
});
export type SrMarketsSnapshot = z.infer<typeof srMarketsSnapshotSchema>;

/** Bản chụp để scheduler ghi, từ danh sách perps SoDEX. */
export function srMarketsSnapshot(
  symbols: readonly {
    name: string;
    status: string;
    baseCoin?: string | undefined;
    displayName?: string | undefined;
  }[],
  now: Date,
): SrMarketsSnapshot {
  return {
    updatedAt: now.toISOString(),
    markets: symbols.map((s) => ({
      name: s.name,
      baseCoin: s.baseCoin ?? null,
      displayName: s.displayName ?? null,
      status: s.status,
    })),
  };
}

/** Giá trị Redis → bản chụp; thiếu, JSON hỏng hoặc sai dạng → null (không bao giờ coi như "không có market nào"). */
export function parseSrMarkets(raw: string | null | undefined): SrMarketsSnapshot | null {
  if (raw == null) return null;
  try {
    const p = srMarketsSnapshotSchema.safeParse(JSON.parse(raw));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export function srMarketsStale(s: SrMarketsSnapshot, now: Date): boolean {
  return now.getTime() - Date.parse(s.updatedAt) > SR_MARKETS_STALE_MS;
}
