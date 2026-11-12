import { decimalStringSchema, type TidFill } from "@drift/shared";
import { z } from "zod";

// Schema các response Hyperliquid mà DeskLabs dùng (docs/COPY_TRADING_DATA.md, đo 2026-11-11). Chỉ khai báo field
// cần; field thừa bị bỏ qua. Chỉ đọc: không có endpoint `exchange`, không có key.

/** Hyperliquid trả số dạng chuỗi thập phân; vài trường (`startPosition`) có thể là "-0.0". */
const num = z.string().transform((v, ctx) => {
  const t = v === "-0.0" || v === "-0" ? "0" : v;
  const r = decimalStringSchema.safeParse(t);
  if (!r.success) {
    ctx.addIssue({ code: "custom", message: "Not a decimal" });
    return z.NEVER;
  }
  return r.data;
});

export const hlFillSchema = z.object({
  coin: z.string(),
  px: num,
  sz: num,
  side: z.enum(["B", "A"]),
  time: z.number().int(),
  startPosition: num,
  dir: z.string(),
  closedPnl: num,
  fee: num,
  feeToken: z.string().optional(),
  tid: z.union([z.number(), z.string()]).transform(String),
  liquidation: z
    .object({
      liquidatedUser: z.string(),
      markPx: z.string().optional(),
      method: z.string().optional(),
    })
    .nullish(),
});
export type HlFill = z.infer<typeof hlFillSchema>;

export const hlFillsSchema = z.array(hlFillSchema);

export const hlFundingSchema = z.array(
  z.object({
    time: z.number().int(),
    delta: z.object({ type: z.string(), coin: z.string(), usdc: num }),
  }),
);

export const hlClearinghouseSchema = z.object({
  assetPositions: z.array(
    z.object({
      position: z.object({
        coin: z.string(),
        szi: num,
        entryPx: num.nullish(),
        unrealizedPnl: num.nullish(),
        leverage: z.object({ type: z.string(), value: z.number() }).nullish(),
      }),
    }),
  ),
  time: z.number().int().optional(),
});
export type HlClearinghouse = z.infer<typeof hlClearinghouseSchema>;

export const hlRoleSchema = z.object({ role: z.string() });

export const hlLeaderboardRowSchema = z.object({
  ethAddress: z.string(),
  accountValue: num,
  displayName: z.string().nullish(),
  windowPerformances: z.array(z.tuple([z.string(), z.object({ pnl: num, roi: num, vlm: num })])),
});
export type HlLeaderboardRow = z.infer<typeof hlLeaderboardRowSchema>;

/** Fill Hyperliquid → `LeaderFill` (kèm `tid`) của `@drift/shared`. `liquidatedSelf` chỉ khi chính ví bị thanh lý. */
export function toLeaderFill(f: HlFill, user: string): TidFill {
  return {
    tid: f.tid,
    coin: f.coin,
    px: f.px,
    sz: f.sz,
    side: f.side,
    time: f.time,
    startPosition: f.startPosition,
    closedPnl: f.closedPnl,
    // Phí perp luôn là USDC; phí token khác (spot) không cộng vào USD.
    fee: f.feeToken === undefined || f.feeToken === "USDC" ? f.fee : "0",
    liquidatedSelf: f.liquidation?.liquidatedUser.toLowerCase() === user.toLowerCase(),
  };
}

/** Số liệu một cửa sổ của leaderboard (`day` / `week` / `month` / `allTime`); null khi dòng không có cửa sổ đó. */
export function windowOf(
  row: HlLeaderboardRow,
  window: "day" | "week" | "month" | "allTime",
): { pnl: string; roi: string; vlm: string } | null {
  return row.windowPerformances.find(([w]) => w === window)?.[1] ?? null;
}

/** PnL 30 ngày theo leaderboard (chỉ để chọn ứng viên; số hiển thị tính lại từ fill). */
export function monthPnlOf(row: HlLeaderboardRow): string | null {
  return row.windowPerformances.find(([w]) => w === "month")?.[1].pnl ?? null;
}
