import { signalContexts, type Db } from "@drift/db";
import {
  ContextSource,
  h1Of,
  h2Of,
  h3Of,
  btcTrendOf,
  hourlyMovesPct,
  MARKET_STATE_RULES,
  MARKET_STATE_VERSION,
  midOf,
  NEWS_RULES,
  pctChange,
  rangeBreakoutOf,
  SIGNAL_CONTEXT_RULES,
  SIGNAL_CONTEXT_VERSION,
  typicalMovePct,
  volatilityOf,
  volumeVs24h,
  volWindowComplete,
  type Decimal,
  type DecimalInput,
  type Quote,
  type TradeDirection,
} from "@drift/shared";
import { sql } from "drizzle-orm";

import { movedBeforeEntry } from "./store";

// Bước 4 · Context (#329; #330 snapshot + H3, #331 H1, #332 H2). Chụp ngữ cảnh của MỘT tín hiệu đúng lúc quyết định, ghi
// một dòng `signal_contexts` (không bao giờ tính lại: insert-or-nothing + trigger chặn UPDATE). Chỉ ghi: không có giá trị nào
// ở đây đi vào Filter / Decide.
// Không nhìn trước: mọi truy vấn chỉ lấy dữ liệu có timestamp < `decidedAt` (leader_events.seen_at, lần xếp hạng xong trước
// đó, research_wallet_sets.created_at, funding_time, nến 1 phút đã ĐÓNG trước đó). Giá lúc quyết định là giá giữa của báo giá
// mà chu kỳ dùng để vào lệnh. Chỉ đọc bảng do marketdata / scheduler ghi (leader_events, leader_wallets, research_wallet_sets,
// research_wallet_set_members, leaderboard_runs, leader_stats_daily, funding_rates, candles_1m); không gọi SoDEX, Hyperliquid
// hay dịch vụ ngoài nào.

type Exec = Db;

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

export interface ContextSignal {
  articleId: string;
  market: string;
  direction: TradeDirection;
  /**
   * Giờ đăng của bài ĐẦU TIÊN của story (mốc "giá đã chạy" của H3), cùng mốc với `moved_before_entry` của lệnh (#312,
   * review PR #349). Bài mở story thì là giờ đăng của chính bài đó.
   */
  storyStartAt: number;
}

const rowsOf = <T>(r: { rows: T[] }) => r.rows;
const toMs = (v: Date | string) => (v instanceof Date ? v.getTime() : Date.parse(v));

/** Nến 1 phút đã đóng TRƯỚC `t` (giờ đóng = ts + 1 phút < t): điều kiện `ts < closedBefore(t)`. */
const closedBefore = (t: number) => new Date(t - MIN_MS);

/**
 * H1 context-v2 (#353): tập ví = TẬP VÍ NGHIÊN CỨU có hiệu lực lúc quyết định (version mới nhất có `created_at` < quyết định,
 * chọn từ một lần xếp hạng `ok` đã XONG trước quyết định: chống survivorship #263, ví vào top sau quyết định không tính).
 * N = số ví của tập mà marketdata đọc THÀNH CÔNG trong 60 phút trước quyết định (`leader_wallets.last_polled_at` ≥ quyết định
 * − 60 phút; poll lỗi hay ví nhường khi chạm rate limit không đổi mốc này). Không chặn trên: bước 4 chạy ngay sau giờ quyết
 * định của chu kỳ (sau phân loại), marketdata có thể vừa poll lại ví trong khoảng đó và mốc chỉ tiến lên; sự kiện vẫn chỉ tính
 * khi `seen_at` < quyết định. Tài sản có trên Hyperliquid = có trong `markets` của một ví ở lần xếp hạng `ok` gần nhất xong
 * trước quyết định, hoặc đã có sự kiện cá voi trên market đó thấy trước quyết định. Sự kiện tính: của các ví được kiểm, loại
 * mở / tăng, trong 60 phút trước, thấy trước quyết định.
 */
async function whaleInputs(db: Exec, market: string, t: number) {
  const at = new Date(t);
  const from = new Date(t - SIGNAL_CONTEXT_RULES.h1WindowMinutes * MIN_MS);
  const kinds = sql.join(
    SIGNAL_CONTEXT_RULES.h1Kinds.map((k) => sql`${k}`),
    sql`, `,
  );
  const [set] = rowsOf(
    await db.execute<{ version: number; size: number }>(sql`
      select s.version, s.size from research_wallet_sets s
        join leaderboard_runs r on r.date = s.run_date and r.status = 'ok' and r.finished_at is not null
       where s.created_at < ${at} and r.finished_at < ${at}
       order by s.version desc limit 1`),
  );
  const setVersion = set === undefined ? null : set.version;
  const tracked = sql`
    select distinct lower(m.address) as address
      from research_wallet_set_members m
      join leader_wallets w
        on w.source = 'hyperliquid' and lower(w.address) = lower(m.address) and w.last_polled_at >= ${from}
     where m.set_version = ${setVersion ?? -1}`;
  const [head] = rowsOf(
    await db.execute<{ wallets: number | string; on_hl: boolean }>(sql`
      with tracked as (${tracked}),
           last_run as (
             select date from leaderboard_runs
              where status = 'ok' and finished_at is not null and finished_at < ${at}
              order by finished_at desc limit 1)
      select
        (select count(*) from tracked) as wallets,
        (exists(select 1 from leader_stats_daily s join last_run lr on lr.date = s.date
                 where s.source = 'hyperliquid' and s.stats->'markets' @> jsonb_build_array(${market}::text))
         or exists(select 1 from leader_events e
                    where e.source = 'hyperliquid' and e.market = ${market} and e.seen_at < ${at})) as on_hl`),
  );
  const moves = rowsOf(
    await db.execute<{
      address: string;
      position_after: string;
      notional: string;
      at: Date | string;
    }>(sql`
      with tracked as (${tracked})
      select e.address, e.position_after::text as position_after, e.notional::text as notional, e.at
        from leader_events e
        join tracked k on k.address = lower(e.address)
       where e.source = 'hyperliquid' and e.market = ${market}
         and e.kind in (${kinds})
         and e.at >= ${from} and e.at < ${at} and e.seen_at < ${at}
       order by e.at, e.id`),
  );
  return {
    setVersion,
    setSize: set === undefined ? null : set.size,
    walletsChecked: Number(head?.wallets ?? 0),
    assetOnHyperliquid: head?.on_hl === true,
    moves: moves.map((m) => ({
      address: m.address,
      positionAfter: m.position_after,
      notional: m.notional,
      at: toMs(m.at),
    })),
  };
}

/** H2: funding SoDEX của market trong 30 ngày trước `t` (funding_time < t). */
async function fundingPoints(db: Exec, market: string, t: number) {
  const rows = rowsOf(
    await db.execute<{ funding_time: Date | string; rate: string }>(sql`
      select funding_time, rate::text as rate from funding_rates
       where market = ${market}
         and funding_time >= ${new Date(t - SIGNAL_CONTEXT_RULES.h2LookbackDays * DAY_MS)}
         and funding_time < ${new Date(t)}
       order by funding_time`),
  );
  return rows.map((r) => ({ at: toMs(r.funding_time), rate: r.rate }));
}

/**
 * Biến động 1 giờ thường gặp (%) như `typicalMove` của Decide, nhưng chặn trên chặt: chỉ nến đã đóng trước `t` và không
 * dùng cache dùng chung (cache của Decide không đổi gì vì hàm này).
 */
async function typicalMoveBefore(db: Exec, market: string, t: number): Promise<Decimal | null> {
  return typicalMovePct(
    await hourlyClosesBefore(db, market, t),
    SIGNAL_CONTEXT_RULES.h3TypicalHours,
  );
}

/** Giá đóng mỗi giờ (nến cuối của giờ) trong 30 ngày trước `t`, chỉ nến đã đóng trước `t`. */
async function hourlyClosesBefore(db: Exec, market: string, t: number) {
  const since = new Date(t - NEWS_RULES.volatilityLookbackDays * DAY_MS);
  const rows = rowsOf(
    await db.execute<{ hour: Date | string; close: string }>(sql`
      select distinct on (date_trunc('hour', ts)) date_trunc('hour', ts) as hour, close::text as close
        from candles_1m
       where market = ${market} and ts >= ${since} and ts < ${closedBefore(t)}
       order by date_trunc('hour', ts), ts desc`),
  );
  return rows.map((r) => ({ hour: toMs(r.hour), close: r.close }));
}

/**
 * Giá "lúc `t`" cho trạng thái thị trường: giá đóng của nến 1 phút cuối cùng ĐÃ ĐÓNG trước `t` (giờ đóng = ts + 1 phút < t),
 * tìm lùi tối đa `priceMaxAgeMinutes`; không có → null (không bao giờ dùng nến đóng đúng lúc hay sau `t`).
 */
/** Số nến 1 phút và tổng khối lượng của cửa sổ 4 h trước `t` (nến đóng trong (t − 4 h, t)). */
async function volWindow(db: Exec, market: string, t: number) {
  const end = closedBefore(t);
  const from = new Date(end.getTime() - MARKET_STATE_RULES.volHours * HOUR_MS);
  const [r] = rowsOf(
    await db.execute<{ n: number | string; vol: string | null }>(sql`
      select count(*) as n, sum(volume)::text as vol from candles_1m
       where market = ${market} and ts >= ${from} and ts < ${end}`),
  );
  return { candles: Number(r?.n ?? 0), volume: r?.vol ?? null };
}

async function closeBefore(db: Exec, market: string, t: number): Promise<string | null> {
  const end = closedBefore(t);
  const from = new Date(end.getTime() - MARKET_STATE_RULES.priceMaxAgeMinutes * MIN_MS);
  const [r] = rowsOf(
    await db.execute<{ close: string }>(sql`
      select close::text as close from candles_1m
       where market = ${market} and ts < ${end} and ts >= ${from}
       order by ts desc limit 1`),
  );
  return r?.close ?? null;
}

/**
 * Trạng thái thị trường lúc `t` (Catalyst P0, #376): BTC trend = % đổi BTC-USD trong 24 h; volatility = biến động 4 h của
 * chính tài sản, xếp phân vị (hạng giữa) trong các biến động 4 h mỗi giờ của 30 ngày trước (cùng chuỗi giờ với biến động
 * thường gặp của Decide). Chỉ nến đã đóng trước `t`; thiếu → null. Không đổi gì ở Filter / Decide.
 */
async function marketStateAt(db: Exec, market: string, t: number) {
  const r = MARKET_STATE_RULES;
  const btcChange = pctChange(
    await closeBefore(db, r.btcMarket, t - r.btcHours * HOUR_MS),
    await closeBefore(db, r.btcMarket, t),
  );
  // Thiếu nến trong cửa sổ 4 h (hổng / không giao dịch) → volatility null, không bao giờ "0%".
  const win = await volWindow(db, market, t);
  const move = !volWindowComplete(win)
    ? null
    : pctChange(
        await closeBefore(db, market, t - r.volHours * HOUR_MS),
        await closeBefore(db, market, t),
      );
  const vol = volatilityOf(
    move === null ? null : move.abs(),
    hourlyMovesPct(await hourlyClosesBefore(db, market, t), r.volHours),
  );
  return {
    btcChange,
    btcTrend: btcTrendOf(btcChange),
    vol,
  };
}

/** Chỉ số khám phá từ nến đã đóng trong 24 giờ trước `t`. */
async function exploratory(db: Exec, market: string, t: number) {
  const end = closedBefore(t);
  const lastHourFrom = new Date(t - HOUR_MS);
  const [r] = rowsOf(
    await db.execute<{
      n: number | string;
      vol_day: string | null;
      vol_hour: string | null;
      hi: string | null;
      lo: string | null;
      last: string | null;
    }>(sql`
      select count(*) as n,
             sum(volume)::text as vol_day,
             (sum(volume) filter (where ts >= ${lastHourFrom}))::text as vol_hour,
             (max(high) filter (where ts < ${lastHourFrom}))::text as hi,
             (min(low) filter (where ts < ${lastHourFrom}))::text as lo,
             ((array_agg(close order by ts desc))[1])::text as last
        from candles_1m
       where market = ${market} and ts >= ${new Date(t - DAY_MS)} and ts < ${end}`),
  );
  if (r === undefined || Number(r.n) === 0) return { volume: null, breakout: null };
  return {
    volume: volumeVs24h(r.vol_hour, r.vol_day),
    breakout: rangeBreakoutOf({ last: r.last, high: r.hi, low: r.lo }),
  };
}

type ContextValues = Omit<typeof signalContexts.$inferInsert, "id" | "createdAt">;

/**
 * Tính giá trị ngữ cảnh của một tín hiệu tại `decidedAt` (chưa ghi). `decisionPrice` = giá lúc quyết định để đo H3 (live: giá
 * giữa của báo giá chu kỳ; backfill: giá đóng nến 1 phút đã đóng trước quyết định); null → H3 `na`. `whales = false` (backfill
 * #333 / #354): không tái dựng được lần poll ví trong quá khứ một cách trung thực (`last_polled_at` chỉ giữ lần mới nhất), nên
 * H1 `na` và mọi số H1 null (không phải 0).
 */
export async function computeSignalContext(
  db: Exec,
  s: ContextSignal,
  decidedAt: number,
  decisionPrice: DecimalInput | null,
  opts: { source: ContextSource; ruleVersion: string; whales: boolean },
): Promise<ContextValues> {
  const fx = (d: Decimal | null) => (d === null ? null : d.toFixed(18));
  const h1Values = opts.whales
    ? await (async () => {
        const w = await whaleInputs(db, s.market, decidedAt);
        const h1 = h1Of({ direction: s.direction, ...w });
        return {
          h1Status: h1.status,
          h1WalletSetVersion: w.setVersion,
          h1WalletSetSize: w.setSize,
          h1WalletsChecked: h1.walletsChecked,
          h1AssetOnHyperliquid: h1.assetOnHyperliquid,
          h1AgreeingWallets: h1.agreeingWallets,
          h1OpposingWallets: h1.opposingWallets,
          h1AgreeingAddresses: h1.agreeingAddresses,
          h1OpposingAddresses: h1.opposingAddresses,
          h1AgreeingUsdc: fx(h1.agreeingUsdc),
          h1FirstAt: h1.firstAt === null ? null : new Date(h1.firstAt),
        };
      })()
    : {
        h1Status: "na" as const,
        h1WalletSetVersion: null,
        h1WalletSetSize: null,
        h1WalletsChecked: null,
        h1AssetOnHyperliquid: null,
        h1AgreeingWallets: null,
        h1OpposingWallets: null,
        h1AgreeingAddresses: null,
        h1OpposingAddresses: null,
        h1AgreeingUsdc: null,
        h1FirstAt: null,
      };
  const h2 = h2Of({
    direction: s.direction,
    decidedAt,
    points: await fundingPoints(db, s.market, decidedAt),
  });
  // Cùng hàm, cùng mốc (bài đầu story) với `moved_before_entry` của lệnh.
  const moved =
    decisionPrice === null || s.storyStartAt > decidedAt
      ? null
      : await movedBeforeEntry(db, s.market, s.storyStartAt, decisionPrice);
  const h3 = h3Of({
    direction: s.direction,
    movedPct: moved,
    typicalMovePct: await typicalMoveBefore(db, s.market, decidedAt),
  });
  const ex = await exploratory(db, s.market, decidedAt);
  const mk = await marketStateAt(db, s.market, decidedAt);
  return {
    articleId: s.articleId,
    market: s.market,
    direction: s.direction,
    decidedAt: new Date(decidedAt),
    source: opts.source,
    contextVersion: SIGNAL_CONTEXT_VERSION,
    ruleVersion: opts.ruleVersion,
    ...h1Values,
    h2Status: h2.status,
    h2FundingRate: fx(h2.rate),
    h2FundingTime: h2.rateAt === null ? null : new Date(h2.rateAt),
    h2Percentile: h2.percentile === null ? null : h2.percentile.toFixed(4),
    h2Samples: h2.samples,
    h2Payer: h2.payer,
    h2IntervalHours: h2.intervalHours === null ? null : h2.intervalHours.toFixed(2),
    h3Status: h3.status,
    h3MovedPct: fx(h3.movedPct),
    h3TypicalMovePct: fx(h3.typicalMovePct),
    volumeVs24h: fx(ex.volume),
    rangeBreakout: ex.breakout,
    marketVersion: MARKET_STATE_VERSION,
    marketBtcChange24hPct: fx(mk.btcChange),
    marketBtcTrend: mk.btcTrend,
    marketVol4hPct: mk.vol === null ? null : fx(mk.vol.movePct),
    marketVolPercentile: mk.vol === null ? null : mk.vol.percentile.toFixed(4),
    marketVolatility: mk.vol?.state ?? null,
  };
}

/** Ghi snapshot; bài đã có snapshot (live hay backfilled) thì giữ nguyên dòng cũ. Trả true khi đã ghi dòng mới. */
export async function insertSignalContext(db: Exec, values: ContextValues): Promise<boolean> {
  const rows = await db
    .insert(signalContexts)
    .values(values)
    .onConflictDoNothing({ target: [signalContexts.articleId, signalContexts.market] })
    .returning({ id: signalContexts.id });
  return rows.length > 0;
}

/**
 * Tính ngữ cảnh của một tín hiệu tại `decidedAt` và ghi (nếu bài đã có snapshot thì giữ nguyên dòng cũ). `quote` = báo giá
 * của chu kỳ (giá vào lệnh dùng cùng báo giá này); null khi market không có giá → H3 `na`.
 */
export async function captureSignalContext(
  db: Exec,
  s: ContextSignal,
  decidedAt: number,
  quote: Quote | null,
): Promise<void> {
  const values = await computeSignalContext(
    db,
    s,
    decidedAt,
    quote === null ? null : midOf(quote),
    { source: ContextSource.live, ruleVersion: NEWS_RULES.version, whales: true },
  );
  await insertSignalContext(db, values);
}
