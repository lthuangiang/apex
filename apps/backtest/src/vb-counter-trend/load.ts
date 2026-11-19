import type { DbTx } from "@drift/db";
import { BotState, dec, Decimal } from "@drift/shared";
import { volumeFarmSchema, type Candle, type VolumeFarmConfig } from "@drift/strategies";
import { sql } from "drizzle-orm";

import { inferTick } from "../signal-replay/costs";

import { WARMUP_MS, type StudyMarketInput } from "./study";

// Bộ nạp cho nghiên cứu bộ chặn ngược xu hướng VB (#282). Chỉ đọc, chạy trong `readOnlyTx` (READ ONLY, statement timeout,
// trần thời gian tổng như DEC-316): nến `candles_1m` của từng market và config đang chạy của bot Volume Builder tiền thật.
// Không gọi REST SoDEX: tick suy ra từ lưới giá của nến (như DEC-321).

const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 14;
/** Trần nến mỗi market: 14 ngày + khởi động, dư một chút. */
export const MAX_CANDLES = 25_000;
export const MAX_MARKETS = 10;
const MAX_BOTS = 1_000;
export const BASE_MARKETS = ["ETH-USD", "BTC-USD"] as const;
/** Bot "đang chạy" để thêm market của nó vào nghiên cứu. */
const ACTIVE: readonly string[] = [
  BotState.starting,
  BotState.running,
  BotState.pausing,
  BotState.paused,
  BotState.resuming,
];

/** Config nghiên cứu khi market không có bot VB tiền thật: theo các bot đang chạy (giữ 180–300 s, 25×, 200–500 USDC). */
export const STUDY_DEFAULT_CONFIG = {
  leverage: 25,
  marginMode: "cross",
  orderSizeMinUsd: "200",
  orderSizeMaxUsd: "500",
  minHoldSecs: 180,
  maxHoldSecs: 300,
  slMarginPct: "10",
  cooldownSecs: 30,
  maxLoss: "1000000000",
} as const;

export class StudyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudyLimitError";
  }
}

export function checkRange(from: Date, to: Date, now: number): void {
  if (to <= from) throw new StudyLimitError("--to must be after --from");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS)
    throw new StudyLimitError(
      `range is longer than ${String(MAX_RANGE_DAYS)} days; run several shorter ranges instead`,
    );
  if (to.getTime() > now + 60_000) throw new StudyLimitError("--to is in the future");
}

/**
 * Config dùng cho mô phỏng: parse lại bằng schema của người dùng (điền mặc định), rồi bỏ những gì làm bot dừng hoặc
 * không vào lệnh vì lý do khác bộ chặn đang nghiên cứu: max loss rất lớn, không volume target, không giờ chặn, tắt "Only
 * trade sideways" (bật thì không còn lượt vào khi có xu hướng để so). Reverse do nghiên cứu đặt.
 */
export function studyConfig(market: string, raw: unknown): VolumeFarmConfig | null {
  const base = typeof raw === "object" && raw !== null ? raw : {};
  const r = volumeFarmSchema.safeParse({ ...base, market });
  if (!r.success) return null;
  const c: VolumeFarmConfig = { ...r.data };
  delete c.volumeTarget;
  return { ...c, maxLoss: "1000000000", sidewaysOnly: false, blockedHoursUtc: [] };
}

interface BotRow {
  id: string;
  market: string;
  state: string;
  config: unknown;
}

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;

export interface LoadOptions {
  from: Date;
  to: Date;
  now: number;
  /** Market thêm vào ngoài ETH-USD, BTC-USD và market có bot VB đang chạy. */
  extra?: readonly string[];
  /** `bots`: config của bot VB tiền thật mới nhất trên market (mặc định); `default`: luôn dùng config nghiên cứu. */
  configFrom?: "bots" | "default";
  checkDeadline?: () => void;
}

export interface LoadResult {
  markets: StudyMarketInput[];
  notes: string[];
}

export async function loadStudy(q: DbTx, o: LoadOptions): Promise<LoadResult> {
  checkRange(o.from, o.to, o.now);
  const check = o.checkDeadline ?? (() => undefined);
  const notes: string[] = [];
  const bots = rows<BotRow>(
    await q.execute(sql`
      select b.id, b.market, b.state, v.config
        from bots b
        join bot_versions v on v.id = b.active_version_id
       where b.strategy = 'volume_farm' and b.mode = 'live' and b.archived_at is null
       order by b.created_at desc
       limit ${MAX_BOTS}`),
  );
  const active = bots.filter((b) => ACTIVE.includes(b.state));
  const names = [...new Set([...BASE_MARKETS, ...active.map((b) => b.market), ...(o.extra ?? [])])];
  if (names.length > MAX_MARKETS)
    throw new StudyLimitError(
      `${String(names.length)} markets is more than ${String(MAX_MARKETS)}; pass fewer --markets`,
    );
  const markets: StudyMarketInput[] = [];
  for (const market of names) {
    check();
    const cs = rows<{
      ts: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>(
      await q.execute(sql`
        select ts, open, high, low, close, volume
          from candles_1m
         where market = ${market}
           and ts >= ${new Date(o.from.getTime() - WARMUP_MS)} and ts < ${o.to}
         order by ts
         limit ${MAX_CANDLES + 1}`),
    );
    if (cs.length > MAX_CANDLES)
      throw new StudyLimitError(
        `${market}: more than ${String(MAX_CANDLES)} candles in range; shorten the range`,
      );
    const candles: Candle[] = cs.map((r) => ({
      t: new Date(r.ts).getTime(),
      o: dec(r.open).toFixed(),
      h: dec(r.high).toFixed(),
      l: dec(r.low).toFixed(),
      c: dec(r.close).toFixed(),
      v: dec(r.volume).toFixed(),
    }));
    if (candles.length < 200) {
      notes.push(`${market}: only ${String(candles.length)} candles in range, skipped.`);
      continue;
    }
    const tick = inferTick(
      candles.slice(0, 5_000).flatMap((k) => [k.o, k.h, k.l, k.c].map((p) => new Decimal(p))),
    );
    if (tick === null) {
      notes.push(`${market}: tick size could not be inferred from prices, skipped.`);
      continue;
    }
    const mine = bots.filter((b) => b.market === market);
    const latest = o.configFrom === "default" ? undefined : mine[0];
    let config = latest === undefined ? null : studyConfig(market, latest.config);
    let configSource =
      latest === undefined
        ? "study default"
        : `latest live VB bot ··${latest.id.slice(-8)} on this market`;
    if (config === null) {
      if (latest !== undefined)
        notes.push(
          `${market}: config of bot ··${latest.id.slice(-8)} did not parse; used the study default.`,
        );
      config = studyConfig(market, STUDY_DEFAULT_CONFIG);
      configSource = "study default";
    }
    if (config === null) throw new Error("study default config does not parse");
    markets.push({
      market,
      candles,
      // Lô khối lượng không đọc từ SoDEX: bước rất nhỏ, kết quả tính theo bp nên không đổi đáng kể.
      rules: {
        tickSize: tick.toFixed(),
        stepSize: "0.00000001",
        minQuantity: "0",
        minNotional: "0",
      },
      config,
      configSource,
      liveBots: mine.filter((b) => ACTIVE.includes(b.state)).length,
    });
  }
  return { markets, notes };
}
