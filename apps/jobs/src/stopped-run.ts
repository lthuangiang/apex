import { botEvents, botRuntime, bots, botVersions, orders, type Db } from "@drift/db";
import {
  BotState,
  dec,
  MARKET_MAKING_STOPPED_ALL,
  ReasonCode,
  Strategy,
  type ReasonCode as ReasonCodeT,
} from "@drift/shared";
import {
  botCostPerMillion,
  costUsed,
  farmNet,
  settledNet,
  volumeMakerStopCause,
  type VolumeFarmState,
  type VolumeMakerState,
} from "@drift/strategies";
import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";

// Số liệu phiên chạy cho tin Telegram khi bot dừng ĐÚNG KẾ HOẠCH (#566). Jobs đọc lại lúc dựng tin, cùng fact và cùng
// hàm với màn Trading Agent (`botDetail` của api): state runtime + config của version đang chạy + sự kiện Running /
// dừng. Engine không đổi (đường tiền thật giữ nguyên). Thiếu số nào thì để null, tin bỏ dòng đó (quy tắc 1.8).

/**
 * Dừng đúng kế hoạch, không phải sự cố (DEC-180, cùng nhóm với `isIncident` của panel chuông ở web): hết budget, đủ
 * volume target / hết giờ, take profit.
 */
export const PLANNED_STOP_NOTIFY_REASONS: readonly ReasonCodeT[] = [
  ReasonCode.budgetDone,
  ReasonCode.maxCycles,
  ReasonCode.takeProfit,
];

export function isPlannedStop(data: Record<string, unknown>): boolean {
  return (
    data.paper !== true &&
    typeof data.reasonCode === "string" &&
    (PLANNED_STOP_NOTIFY_REASONS as readonly string[]).includes(data.reasonCode)
  );
}

export interface StoppedRun {
  strategy: string;
  /** Khối lượng phiên (USD) của Market Making / Volume Builder; chiến lược khác không có ô này ở Trading Agent → null. */
  volume: string | null;
  /** Volume target của config (Market Making), để chọn nhãn lý do khi thiếu sự kiện dừng. */
  volumeTarget: string | null;
  /** Market Making: chi phí đã dùng (`costUsed`) và "Stop when costs reach" (`costBudget`). */
  cost: { value: string; limit: string | null } | null;
  /** Chiến lược khác Market Making: lãi / lỗ (`settledNet`), đơn vị; Volume Builder kèm `maxLoss`. */
  pnl: { value: string; unit: string; limit: string | null } | null;
  /** Chi phí / $1M (chỉ Market Making và Volume Builder, `botCostPerMillion`). */
  costPerMillion: string | null;
  /** Thời gian chạy của lần chạy vừa dừng: từ "Running" tới lần dừng đầu tiên sau đó. */
  ranMs: number | null;
  /** Market Making dừng với MAX_CYCLES: lý do cụ thể từ nhật ký chiến lược lúc dừng. */
  stopDetail: "volume_target" | "end_time" | null;
}

/** Đơn vị lãi như Strategy Lab (bot-profit.tsx, `/status` của api): perps và bot hai engine USDC; spot theo quote. */
export function pnlUnit(engine: string, market: string): string {
  if (engine !== "spot") return "USDC";
  const quote = market.split(/[_/-]/).at(-1) ?? "";
  // Ký hiệu SoDEX `vUSDC` hiển thị là `USDC` (apps/web/src/lib/markets.ts).
  return /^v[A-Z]/.test(quote) ? quote.slice(1) : quote;
}

const POSITIVE = /^\d+(\.\d+)?$/;
const positive = (v: unknown): string | null => {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
  return typeof s === "string" && POSITIVE.test(s) && dec(s).gt(0) ? s : null;
};

export interface RunInput {
  strategy: string;
  engine: string;
  market: string;
  state: unknown;
  config: unknown;
  /** Số lệnh đã khớp (filled / partially filled), như ô Profit của Trading Agent. */
  fills: number;
  runningSince: Date | null;
  runningUntil: Date | null;
  stopWhy: string | null;
}

/** Hàm thuần: fact → số liệu phiên. */
export function runFacts(i: RunInput): StoppedRun {
  const config = (i.config ?? {}) as Record<string, unknown>;
  const hasState = i.state !== null && i.state !== undefined;
  const mm = i.strategy === Strategy.volumeMaker;
  const vb = i.strategy === Strategy.volumeFarm;
  let volume: string | null = null;
  let cost: StoppedRun["cost"] = null;
  let pnl: StoppedRun["pnl"] = null;
  if (mm && hasState) {
    const st = i.state as VolumeMakerState;
    volume = st.volume;
    // Cùng số với thẻ Market Making của Trading Agent (`vmStats`): cost 4 chữ số, budget của config.
    cost = {
      value: costUsed(st).toDecimalPlaces(4).toString(),
      limit: positive(config.costBudget),
    };
  } else if (hasState) {
    if (vb) volume = (i.state as VolumeFarmState).volume;
    // Profit since start của bot đã dừng (`netOf`); chưa có lệnh khớp thì Trading Agent ghi "No fills yet" → bỏ dòng.
    const net = vb ? farmNet(i.state as VolumeFarmState).toString() : settledNet(i.state);
    if (net !== null && i.fills > 0)
      pnl = {
        value: net,
        unit: pnlUnit(i.engine, i.market),
        limit: vb ? positive(config.maxLoss) : null,
      };
  }
  const ranMs =
    i.runningSince === null || i.runningUntil === null
      ? null
      : Math.max(0, i.runningUntil.getTime() - i.runningSince.getTime());
  return {
    strategy: i.strategy,
    volume: volume !== null && POSITIVE.test(volume) ? volume : null,
    volumeTarget: positive(config.volumeTarget),
    cost,
    pnl,
    costPerMillion: mm || vb ? botCostPerMillion(i.strategy, i.state) : null,
    ranMs,
    stopDetail: mm ? volumeMakerStopCause(i.stopWhy) : null,
  };
}

type Reader = Pick<Db, "select">;

/**
 * Đọc số liệu cho từng tin `bot_stopped` dừng đúng kế hoạch (bot tiền thật). Chỉ khi bot vẫn `stopped` với đúng mã lý do
 * của tin: người dùng đã chạy lại hay sửa bot trong lúc tin chờ gửi thì không có số (không ghi số của phiên khác).
 */
export async function loadStoppedRun(
  db: Reader,
  userId: string,
  botId: string,
  reasonCode: string,
): Promise<StoppedRun | null> {
  const [b] = await db
    .select({
      state: bots.state,
      reasonCode: bots.reasonCode,
      strategy: bots.strategy,
      market: bots.market,
      engine: bots.engine,
      activeVersionId: bots.activeVersionId,
    })
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .limit(1);
  if (b?.state !== BotState.stopped || b.reasonCode !== reasonCode) return null;
  const [rt] = await db
    .select({ state: botRuntime.state })
    .from(botRuntime)
    .where(eq(botRuntime.botId, botId))
    .limit(1);
  const [v] =
    b.activeVersionId === null
      ? []
      : await db
          .select({ config: botVersions.config })
          .from(botVersions)
          .where(eq(botVersions.id, b.activeVersionId))
          .limit(1);
  const [filled] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.botId, botId), inArray(orders.status, ["filled", "partially_filled"])));
  // Runtime như Trading Agent (BD-06): "Running" gần nhất tới lần dừng đầu tiên sau đó (Paused / Stopping / Stopped).
  const [since] = await db
    .select({ at: botEvents.occurredAt })
    .from(botEvents)
    .where(
      and(
        eq(botEvents.botId, botId),
        eq(botEvents.type, "state"),
        eq(botEvents.decision, "Running"),
      ),
    )
    .orderBy(desc(botEvents.occurredAt))
    .limit(1);
  const [until] =
    since === undefined
      ? []
      : await db
          .select({ at: botEvents.occurredAt })
          .from(botEvents)
          .where(
            and(
              eq(botEvents.botId, botId),
              eq(botEvents.type, "state"),
              inArray(botEvents.decision, ["Paused", "Stopping", "Stopped"]),
              gte(botEvents.occurredAt, since.at),
            ),
          )
          .orderBy(asc(botEvents.occurredAt))
          .limit(1);
  // Market Making + MAX_CYCLES: lý do cụ thể từ nhật ký lúc dừng (`stopDetailsOf` của api), chỉ khi mới hơn "Running".
  let stopWhy: string | null = null;
  if (b.strategy === Strategy.volumeMaker && reasonCode === ReasonCode.maxCycles) {
    const [last] = await db
      .select({ decision: botEvents.decision, why: botEvents.why })
      .from(botEvents)
      .where(
        and(
          eq(botEvents.botId, botId),
          or(
            inArray(botEvents.decision, [...MARKET_MAKING_STOPPED_ALL]),
            and(eq(botEvents.type, "state"), eq(botEvents.decision, "Running")),
          ),
        ),
      )
      .orderBy(desc(botEvents.occurredAt), desc(botEvents.createdAt))
      .limit(1);
    if (last?.decision != null && MARKET_MAKING_STOPPED_ALL.includes(last.decision))
      stopWhy = last.why;
  }
  return runFacts({
    strategy: b.strategy,
    engine: b.engine,
    market: b.market,
    state: rt?.state ?? null,
    config: v?.config ?? null,
    fills: filled?.n ?? 0,
    runningSince: since?.at ?? null,
    runningUntil: until?.at ?? null,
    stopWhy,
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gắn số liệu phiên vào các dòng `bot_stopped` dừng đúng kế hoạch trước khi dựng tin. Chỉ đọc; lỗi DB thì cả lượt gửi
 * rollback và được giao lại như lỗi gửi khác (tin Telegram gửi lại được, không phải thao tác tài chính).
 */
export async function attachStoppedRuns(
  db: Reader,
  userId: string,
  rows: { type: string; data: Record<string, unknown>; run?: StoppedRun | null }[],
): Promise<void> {
  for (const r of rows) {
    if (r.type !== "bot_stopped" || !isPlannedStop(r.data)) continue;
    const botId = r.data.botId;
    const code = r.data.reasonCode;
    if (typeof botId !== "string" || !UUID_RE.test(botId) || typeof code !== "string") continue;
    r.run = await loadStoppedRun(db, userId, botId, code);
  }
}
