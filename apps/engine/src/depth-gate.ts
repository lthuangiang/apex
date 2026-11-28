import { dec, depthCapApplies, depthCapLabel } from "@drift/shared";
import {
  capEntryOrder,
  depthReducedWhy,
  depthWaitWhy,
  isEntryCandidate,
  DEPTH_EMPTY_DECISION,
  DEPTH_REDUCED_DECISION,
  DEPTH_THIN_DECISION,
  type BookTop,
  type EntryCapResult,
  type MarketRules,
  type OrderIntent,
  type StrategyAction,
} from "@drift/strategies";

// Cổng độ sâu sổ lệnh của engine (DEC-402 mục 5, #590). Hàm thuần: engine đọc sổ 10 mức (cache ngắn) rồi gọi `planDepth`
// trên các hành động của một bước chiến lược. Chỉ lệnh khớp ngay để VÀO / TĂNG vị thế bị xét; lệnh đóng, reduce-only,
// stop loss, Stop và lệnh maker không bao giờ bị cắt hay giữ lại vì quy tắc này.

/** Sổ 10 mức của một market: BookTop, `null` khi một phía rỗng, `"error"` khi không đọc được (không rõ độ sâu). */
export type DepthRead = BookTop | null | "error";

export const depthKey = (o: Pick<OrderIntent, "engine" | "market">): string =>
  `${o.engine}:${o.market}`;

/**
 * Lệnh của bước có làm tăng |vị thế| không (cùng quy tắc với `opensPosition` của engine, DEC-303): Perps reduce-only và Spot
 * bán không bao giờ mở; lệnh ngược chiều vị thế (cộng các lệnh giảm trước nó trong cùng bước) không vượt |vị thế| là giảm.
 * Không biết vị thế (`null`) thì coi là mở.
 */
type Opens = (
  o: Pick<OrderIntent, "engine" | "side" | "reduceOnly" | "quantity">,
  position: string | null,
  reducing: string,
) => boolean;

/** Lệnh VÀO khớp ngay trong bước (theo thứ tự), kèm các lệnh khác. */
function classify(
  actions: readonly StrategyAction[],
  positionOf: (market: string, engine: "spot" | "perps") => string | null,
  opens: Opens,
  inScope: (market: string) => boolean,
): { entries: OrderIntent[]; exits: OrderIntent[] } {
  const reducing = new Map<string, string>();
  const entries: OrderIntent[] = [];
  const exits: OrderIntent[] = [];
  for (const a of actions) {
    if (a.type !== "place") continue;
    const o = a.order;
    const key = `${o.market}:${o.side}`;
    const before = reducing.get(key) ?? "0";
    const opening = opens(o, positionOf(o.market, o.engine), before);
    // Market ngoài `DEPTH_CAP_MARKETS` (DEC-402 bổ sung 2026-11-28): lệnh vào không bị xét, không cần đọc sổ.
    if (opening && isEntryCandidate(o)) {
      if (inScope(o.market)) entries.push(o);
    } else if (!opening || o.reduceOnly || o.stop !== undefined) exits.push(o);
    reducing.set(key, dec(before).add(o.quantity).toString());
  }
  return { entries, exits };
}

/** Sổ cần đọc cho bước này: mỗi market trong phạm vi có lệnh VÀO khớp ngay. Ngoài phạm vi: rỗng, không đọc sổ. */
export function depthNeeds(
  actions: readonly StrategyAction[],
  positionOf: (market: string, engine: "spot" | "perps") => string | null,
  opens: Opens,
  inScope: (market: string) => boolean,
): { market: string; engine: "spot" | "perps" }[] {
  const seen = new Map<string, { market: string; engine: "spot" | "perps" }>();
  for (const o of classify(actions, positionOf, opens, inScope).entries)
    seen.set(depthKey(o), { market: o.market, engine: o.engine });
  return [...seen.values()];
}

export interface DepthWait {
  order: OrderIntent;
  /** `error`: không đọc được sổ (không ghi Decisions vì không biết nguyên nhân). */
  result: Extract<EntryCapResult, { kind: "wait" }> | "error" | "linked";
}

export type DepthPlan =
  /** Không có gì đổi: không có lệnh vào khớp ngay, hoặc mọi lệnh vào đều qua (market đủ sâu / dưới trần). */
  | { kind: "pass"; clear: string[] }
  /**
   * Giữ CẢ bước (state không đổi, không gửi gì), như khi lệch vị thế (DEC-306): sự kiện thị trường kế tiếp chiến lược quyết
   * lại. Chỉ khi bước không có lệnh giảm / đóng / stop / pause và sự kiện không phải fill / ack / kết thúc lệnh.
   */
  | { kind: "hold"; waits: DepthWait[]; clear: string[] }
  /**
   * Gửi bước với `actions` đã sửa: lệnh vào bị cắt về trần (kèm dòng Decisions "Order reduced"), lệnh vào phải chờ thì bỏ
   * khỏi bước (`stripped`, engine báo `orderDone` cho chiến lược như lệnh IOC không khớp gì). `clear`: market đã qua cổng.
   */
  | {
      kind: "apply";
      actions: StrategyAction[];
      stripped: DepthWait[];
      clear: string[];
    };

/**
 * Kế hoạch cho một bước chiến lược. `books` phải có mọi khoá của `depthNeeds` (engine đọc trước). `rules` theo market;
 * thiếu quy tắc market thì không cắt (không làm tròn được).
 */
export function planDepth(input: {
  actions: readonly StrategyAction[];
  positionOf: (market: string, engine: "spot" | "perps") => string | null;
  opens: Opens;
  books: ReadonlyMap<string, DepthRead>;
  rules: Readonly<Record<string, MarketRules>>;
  /** Market trong `DEPTH_CAP_MARKETS`. */
  inScope: (market: string) => boolean;
  /** Sự kiện là fill / ack / reject / kết thúc lệnh / positionSync: không bao giờ giữ cả bước. */
  accounting: boolean;
}): DepthPlan {
  const { entries, exits } = classify(input.actions, input.positionOf, input.opens, input.inScope);
  if (entries.length === 0) return { kind: "pass", clear: [] };
  const reduced = new Map<string, Extract<EntryCapResult, { kind: "reduce" }>>();
  const waits: DepthWait[] = [];
  const clear = new Set<string>();
  for (const o of entries) {
    const book = input.books.get(depthKey(o));
    if (book === undefined || book === "error") {
      waits.push({ order: o, result: "error" });
      continue;
    }
    if (!depthCapApplies(depthCapLabel(book))) {
      clear.add(o.market);
      continue;
    }
    const rules = input.rules[o.market];
    // Không có quy tắc market thì không làm tròn / so min size được: chờ như khi không đọc được sổ.
    if (rules === undefined) {
      waits.push({ order: o, result: "error" });
      continue;
    }
    const r = capEntryOrder(o, book, rules);
    if (r.kind === "pass") clear.add(o.market);
    else if (r.kind === "wait") waits.push({ order: o, result: r });
    else {
      reduced.set(o.clOrdID, r);
      clear.add(o.market);
    }
  }
  // Hai chân có hedge (Funding Arb: Spot + Perps trong cùng bước): không bao giờ gửi hai chân lệch nhau. Một chân bị cắt
  // hay phải chờ thì cả hai chờ.
  const linked = new Set(entries.map((o) => o.engine)).size > 1;
  if (linked && (reduced.size > 0 || waits.length > 0)) {
    const own = new Map(waits.map((w) => [w.order.clOrdID, w]));
    waits.splice(
      0,
      waits.length,
      ...entries.map((o) => own.get(o.clOrdID) ?? { order: o, result: "linked" as const }),
    );
    reduced.clear();
    for (const o of entries) clear.delete(o.market);
  }
  if (reduced.size === 0 && waits.length === 0) return { kind: "pass", clear: [...clear] };
  const holdable =
    !input.accounting &&
    exits.length === 0 &&
    !input.actions.some((a) => a.type === "pause" || a.type === "stop");
  if (waits.length > 0 && holdable) return { kind: "hold", waits, clear: [...clear] };
  const drop = new Set(waits.map((w) => w.order.clOrdID));
  const actions: StrategyAction[] = [];
  for (const a of input.actions) {
    if (a.type !== "place") {
      actions.push(a);
      continue;
    }
    if (drop.has(a.order.clOrdID)) continue;
    const r = reduced.get(a.order.clOrdID);
    if (r === undefined) {
      actions.push(a);
      continue;
    }
    actions.push({ ...a, order: { ...a.order, quantity: r.quantity } });
    actions.push({
      type: "log",
      decision: DEPTH_REDUCED_DECISION,
      why: depthReducedWhy(a.order.market, a.order.side, r),
    });
  }
  return { kind: "apply", actions, stripped: waits, clear: [...clear] };
}

/** Dòng Decisions cho một lệnh phải chờ; null khi không ghi (không đọc được sổ: không rõ nguyên nhân). */
export function depthWaitDecision(w: DepthWait): { decision: string; why: string } | null {
  if (w.result === "error") return null;
  if (w.result === "linked")
    return {
      decision: DEPTH_THIN_DECISION,
      why: `${w.order.market}: the order book is too thin to fill every leg at full size. The bot won't open or add until it is deeper. Closing orders still go.`,
    };
  return {
    decision: w.result.reason === "empty" ? DEPTH_EMPTY_DECISION : DEPTH_THIN_DECISION,
    why: depthWaitWhy(w.order.market, w.order.side, w.result),
  };
}

/** Khoá chống ghi lặp dòng "Waiting…" (một lần mỗi đợt, tới khi market qua cổng). */
export const depthWaitKey = (w: DepthWait): string =>
  `${w.order.market}:${w.order.side}:${typeof w.result === "string" ? w.result : w.result.reason}`;
