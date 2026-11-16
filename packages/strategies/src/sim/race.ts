import { dec } from "@drift/shared";

import type { OrderIntent, StepContext, StrategyEvent, StrategyModule } from "../core/types";

// Harness tranh chấp thuần (không DB, không mạng; DEC-270): một SoDEX giả có độ trễ ngẫu nhiên theo seed,
// đảo thứ tự tin trả về, `OrderNotFound` khi lệnh huỷ tới trước khi lệnh vào sổ (lệnh vẫn vào sổ sau đó và khớp được),
// cộng phần "engine" tối thiểu: thử huỷ lại lệnh chưa vào sổ như engine (DEC-254). Chạy một chiến lược qua nhiều phút
// giả lập rồi kiểm các bất biến về tiền:
//   1. |vị thế thật trên SoDEX| × giá ≤ giới hạn của bot (cộng sai số giá);
//   3. không lệnh nào nằm trên SoDEX mà chiến lược đã coi là xong quá `orphanGraceMs`;
//   4. mỗi fill vào sổ cái đúng một lần (cuối kịch bản: vị thế của chiến lược = vị thế trên SoDEX);
//   5. bot đang chạy không có khoảng nào quá `maxGapMs` không xét báo giá lại.
// Bất biến 2 (không lệnh mở sau khi Stop) cần engine và DB: nằm ở apps/engine/test.

/** Số ngẫu nhiên tái hiện được theo seed (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RaceLatency {
  /** Độ trễ một chiều thường gặp (ms). */
  minMs: number;
  maxMs: number;
  /** Xác suất một tin đi chậm hẳn (lệnh đặt tới sau lệnh huỷ của chính nó). */
  slowProb: number;
  slowMinMs: number;
  slowMaxMs: number;
}

/** Những gì harness cần đọc từ state của chiến lược. */
export interface RaceProbe<S> {
  /** Vị thế theo sổ cái của chiến lược (base, có dấu). */
  position: (s: S) => string;
  /** Lúc chiến lược xét báo giá lần gần nhất; null = chưa. */
  lastRefresh: (s: S) => number | null;
  /** Chiến lược đã coi lệnh này là xong (không còn sống, không chờ huỷ). Lệnh không biết = xong. */
  isDone: (s: S, clOrdID: string) => boolean;
  /** Chiến lược đã tự dừng / tự pause: kết thúc kịch bản. */
  halted: (s: S) => boolean;
}

export interface RaceOptions<S> {
  seed: number;
  durationMs: number;
  market: string;
  startPrice: number;
  /** Bước giá. */
  tickSize: number;
  /** Giới hạn vị thế (notional, quote) của bot. */
  positionLimit: string;
  probe: RaceProbe<S>;
  tickEveryMs?: number;
  /** Giá đi ngẫu nhiên mỗi tick tối đa chừng này bp; thỉnh thoảng (`jumpProb`) nhảy tới `jumpBp`. */
  walkBp?: number;
  jumpBp?: number;
  jumpProb?: number;
  /** Xu hướng: giá cộng thêm chừng này bp mỗi tick (Binance đi trước theo cùng hướng). */
  driftBp?: number;
  timerEveryMs?: number;
  /** Giá Binance (sự kiện `fair`, Market Making) mỗi chừng này ms; lệch giá SoDEX ngẫu nhiên tới `fairNoiseBp`. */
  fairEveryMs?: number;
  fairNoiseBp?: number;
  /** Bất biến 6: số request (lệnh mới + lệnh huỷ) trong bất kỳ 60 s nào không quá chừng này. */
  maxRequestsPerMinute?: number;
  latency?: Partial<RaceLatency>;
  /** Engine thử huỷ lại lệnh chưa vào sổ sau chừng này (CANCEL_NOT_BOOKED, DEC-254) và bỏ sau `cancelGiveUpMs`. */
  cancelRetryMs?: number;
  cancelGiveUpMs?: number;
  maxGapMs?: number;
  orphanGraceMs?: number;
  /** Sai số giá cho bất biến 1 (fill ở giá đặt, giá đánh dấu có thể lệch). */
  limitTolerance?: number;
  makerFee?: string;
}

export interface RaceReport {
  violations: string[];
  /** Nhật ký ngắn quanh vi phạm đầu tiên (để chẩn đoán). */
  trace: string[];
  places: number;
  cancels: number;
  notFound: number;
  fills: number;
  maxNotional: string;
  maxGapMs: number;
  /** Số request lớn nhất trong một cửa sổ 60 s. */
  maxRequestsPerMinute: number;
  endedAt: number;
}

type Job =
  | { kind: "deliver"; event: StrategyEvent }
  | { kind: "arrivePlace"; order: OrderIntent }
  | { kind: "arriveCancel"; clOrdID: string }
  | { kind: "retryCancel"; clOrdID: string }
  | { kind: "tick" }
  | { kind: "timer" }
  | { kind: "fair" };

interface Queued {
  at: number;
  seq: number;
  job: Job;
}

const DEFAULT_LATENCY: RaceLatency = {
  minMs: 30,
  maxMs: 400,
  slowProb: 0.06,
  slowMinMs: 1_200,
  slowMaxMs: 4_000,
};

/** Chạy một kịch bản tranh chấp; trả báo cáo kèm danh sách vi phạm (rỗng = đạt). */
export function runRace<C, S>(
  module: StrategyModule<C, S>,
  config: C,
  ctx: StepContext,
  o: RaceOptions<S>,
): RaceReport {
  const rnd = seededRandom(o.seed);
  const lat = { ...DEFAULT_LATENCY, ...o.latency };
  const tickEvery = o.tickEveryMs ?? 250;
  const walkBp = o.walkBp ?? 0.8;
  const jumpBp = o.jumpBp ?? 3;
  const jumpProb = o.jumpProb ?? 0.05;
  const timerEvery = o.timerEveryMs ?? 1_000;
  const retryMs = o.cancelRetryMs ?? 1_000;
  const giveUpMs = o.cancelGiveUpMs ?? 10_000;
  const maxGap = o.maxGapMs ?? 15_000;
  const grace = o.orphanGraceMs ?? 20_000;
  const tol = 1 + (o.limitTolerance ?? 0.05);
  const fee = o.makerFee ?? "0";
  const limit = dec(o.positionLimit);
  const delay = () =>
    rnd() < lat.slowProb
      ? lat.slowMinMs + rnd() * (lat.slowMaxMs - lat.slowMinMs)
      : lat.minMs + rnd() * (lat.maxMs - lat.minMs);

  const queue: Queued[] = [];
  let seq = 0;
  const push = (at: number, job: Job) => {
    const q = { at: Math.round(at), seq: (seq += 1), job };
    // Chèn giữ thứ tự (at, seq): cùng thời điểm thì theo thứ tự đưa vào.
    let i = queue.length;
    while (i > 0 && (queue[i - 1]?.at ?? 0) > q.at) i -= 1;
    queue.splice(i, 0, q);
  };

  // SoDEX giả.
  let price = o.startPrice;
  const booked = new Map<string, OrderIntent>();
  const inflight = new Map<string, OrderIntent>();
  const finished = new Set<string>();
  let exchangePos = dec("0");
  // Phần "engine": lệnh đang chờ huỷ (lúc bắt đầu chờ).
  const pendingCancel = new Map<string, number>();
  // Lúc chiến lược bắt đầu coi một lệnh còn nằm trên SoDEX là xong (bất biến 3).
  const orphanSince = new Map<string, number>();

  const report: RaceReport = {
    violations: [],
    trace: [],
    places: 0,
    cancels: 0,
    notFound: 0,
    fills: 0,
    maxNotional: "0",
    maxGapMs: 0,
    maxRequestsPerMinute: 0,
    endedAt: 0,
  };
  const log: string[] = [];
  const note = (at: number, msg: string) => {
    log.push(`${String(at)} ${msg}`);
    if (log.length > 40) log.shift();
  };
  const violate = (at: number, msg: string) => {
    if (report.trace.length === 0) report.trace = [...log];
    if (report.violations.length < 20) report.violations.push(`t=${String(at)}ms: ${msg}`);
  };

  let state = module.initialState(config);
  let gapFlagged = false;

  const crosses = (x: OrderIntent) =>
    x.price !== undefined &&
    (x.side === "buy" ? price <= Number(x.price) : price >= Number(x.price));

  const fill = (x: OrderIntent, at: number) => {
    booked.delete(x.clOrdID);
    finished.add(x.clOrdID);
    const qty = dec(x.quantity);
    exchangePos = x.side === "buy" ? exchangePos.add(qty) : exchangePos.sub(qty);
    note(
      at,
      `FILL ${x.clOrdID.slice(-10)} ${x.side} ${x.quantity}@${x.price ?? ""} pos=${exchangePos.toString()}`,
    );
    report.fills += 1;
    const notional = exchangePos.abs().mul(price);
    if (notional.gt(report.maxNotional)) report.maxNotional = notional.toString();
    if (notional.gt(limit.mul(tol)))
      violate(
        at,
        `invariant 1: position ${exchangePos.toString()} (${notional.toFixed(2)} notional) above the bot's limit ${limit.toString()}`,
      );
    const fillAt = at + delay();
    push(fillAt, {
      kind: "deliver",
      event: {
        type: "fill",
        at: 0,
        clOrdID: x.clOrdID,
        price: x.price ?? String(price),
        quantity: x.quantity,
        fee: dec(x.price ?? String(price))
          .mul(qty)
          .mul(fee)
          .toString(),
      },
    });
    // Lệnh hết khối lượng: SoDEX báo xong sau tin khớp (engine ghi fill trước, như user stream).
    push(fillAt + 1 + delay() / 4, {
      kind: "deliver",
      event: { type: "orderDone", at: 0, clOrdID: x.clOrdID },
    });
  };

  // Bất biến 6: request trong 60 s gần nhất.
  const sent: number[] = [];
  let rateFlagged = false;
  const request = (at: number) => {
    sent.push(at);
    while ((sent[0] ?? at) <= at - 60_000) sent.shift();
    if (sent.length > report.maxRequestsPerMinute) report.maxRequestsPerMinute = sent.length;
    if (
      o.maxRequestsPerMinute !== undefined &&
      sent.length > o.maxRequestsPerMinute &&
      !rateFlagged
    ) {
      rateFlagged = true;
      violate(
        at,
        `invariant 6: ${String(sent.length)} requests in 60 s (limit ${String(o.maxRequestsPerMinute)})`,
      );
    }
  };
  const sendCancel = (id: string, at: number) => {
    report.cancels += 1;
    request(at);
    push(at + delay(), { kind: "arriveCancel", clOrdID: id });
  };

  const apply = (actions: ReturnType<StrategyModule<C, S>["step"]>["actions"], at: number) => {
    for (const a of actions) {
      if (a.type === "place") {
        report.places += 1;
        request(at);
        note(
          at,
          `PLACE ${a.order.clOrdID.slice(-10)} ${a.order.side} ${a.order.reduceOnly ? "close" : "open"} @${a.order.price ?? ""}`,
        );
        inflight.set(a.order.clOrdID, a.order);
        push(at + delay(), { kind: "arrivePlace", order: a.order });
      } else if (a.type === "cancel") {
        if (!pendingCancel.has(a.clOrdID)) pendingCancel.set(a.clOrdID, at);
        note(at, `CANCEL ${a.clOrdID.slice(-10)}`);
        sendCancel(a.clOrdID, at);
      }
    }
  };

  const step = (event: StrategyEvent) => {
    const r = module.step(config, state, event, ctx);
    state = r.state;
    apply(r.actions, event.at);
  };

  push(0, { kind: "tick" });
  push(0, { kind: "timer" });
  if (o.fairEveryMs !== undefined) push(0, { kind: "fair" });

  while (queue.length > 0) {
    const q = queue.shift();
    if (q === undefined) break;
    const at = q.at;
    if (at > o.durationMs) break;
    report.endedAt = at;
    const j = q.job;
    if (j.kind === "tick") {
      // Giá đi ngẫu nhiên, thỉnh thoảng nhảy mạnh (lệnh mở bị cuốn). Làm tròn theo bước giá.
      const bp = rnd() < jumpProb ? jumpBp : walkBp;
      price = price * (1 + ((rnd() * 2 - 1) * bp + (o.driftBp ?? 0)) / 10_000);
      price = Math.max(o.tickSize, Math.round(price / o.tickSize) * o.tickSize);
      price = Number(price.toFixed(10));
      for (const x of [...booked.values()]) if (crosses(x)) fill(x, at);
      step({ type: "tick", at, market: o.market, price: String(price) });
      push(at + tickEvery, { kind: "tick" });
    } else if (j.kind === "fair") {
      const fair = price * (1 + ((rnd() * 2 - 1) * (o.fairNoiseBp ?? 2)) / 10_000);
      step({ type: "fair", at, market: o.market, fair: fair.toFixed(2), binanceAt: at - 50 });
      push(at + (o.fairEveryMs ?? 250), { kind: "fair" });
    } else if (j.kind === "timer") {
      step({ type: "timer", at });
      push(at + timerEvery, { kind: "timer" });
    } else if (j.kind === "deliver") {
      if (j.event.type !== "tick")
        note(
          at,
          `DELIVER ${j.event.type} ${"clOrdID" in j.event ? j.event.clOrdID.slice(-10) : ""}`,
        );
      step({ ...j.event, at });
    } else if (j.kind === "arrivePlace") {
      const x = j.order;
      inflight.delete(x.clOrdID);
      if (x.timeInForce === "GTX" && crosses(x)) {
        finished.add(x.clOrdID);
        push(at + delay(), {
          kind: "deliver",
          event: { type: "orderReject", at: 0, clOrdID: x.clOrdID, code: "POST_ONLY_WOULD_TRADE" },
        });
      } else {
        booked.set(x.clOrdID, x);
        note(at, `BOOKED ${x.clOrdID.slice(-10)}`);
        push(at + delay(), {
          kind: "deliver",
          event: { type: "orderAck", at: 0, clOrdID: x.clOrdID },
        });
        if (crosses(x)) fill(x, at);
      }
    } else if (j.kind === "arriveCancel") {
      const id = j.clOrdID;
      if (booked.has(id)) {
        booked.delete(id);
        finished.add(id);
        pendingCancel.delete(id);
        push(at + delay(), { kind: "deliver", event: { type: "orderDone", at: 0, clOrdID: id } });
      } else if (inflight.has(id)) {
        // Lệnh huỷ tới trước lệnh đặt: SoDEX trả OrderNotFound, lệnh vẫn vào sổ sau đó. Engine thử huỷ lại (DEC-254).
        report.notFound += 1;
        note(at, `NOTFOUND ${id.slice(-10)}`);
        push(at + delay() + retryMs, { kind: "retryCancel", clOrdID: id });
      } else {
        // Đã khớp / đã huỷ: SoDEX từ chối huỷ, không có gì để làm.
        pendingCancel.delete(id);
      }
    } else {
      const since = pendingCancel.get(j.clOrdID);
      if (since !== undefined && !finished.has(j.clOrdID) && at - since < giveUpMs)
        sendCancel(j.clOrdID, at);
    }

    // Bất biến 3: lệnh còn nằm trên SoDEX mà chiến lược đã coi là xong.
    for (const id of booked.keys()) {
      if (!o.probe.isDone(state, id)) {
        orphanSince.delete(id);
        continue;
      }
      const since = orphanSince.get(id) ?? at;
      orphanSince.set(id, since);
      if (at - since > grace) {
        violate(
          at,
          `invariant 3: order ${id} still open on SoDEX ${String(at - since)} ms after the bot stopped tracking it`,
        );
        orphanSince.set(id, Number.POSITIVE_INFINITY);
      }
    }
    for (const id of [...orphanSince.keys()]) if (!booked.has(id)) orphanSince.delete(id);

    if (o.probe.halted(state)) break;
    // Bất biến 5: khoảng không xét báo giá.
    const last = o.probe.lastRefresh(state);
    if (last !== null) {
      const gap = at - last;
      if (gap > report.maxGapMs) report.maxGapMs = gap;
      if (gap > maxGap && !gapFlagged) {
        gapFlagged = true;
        violate(at, `invariant 5: no quote for ${String(gap)} ms (limit ${String(maxGap)} ms)`);
      }
      if (gap <= maxGap) gapFlagged = false;
    }
  }

  // Bất biến 4: xả mọi tin còn đang trên đường (không có sự kiện mới), rồi so vị thế.
  const tail = queue.filter((q) => q.job.kind === "deliver");
  for (const q of tail) if (q.job.kind === "deliver") step({ ...q.job.event, at: q.at });
  const ours = dec(o.probe.position(state));
  if (!ours.eq(exchangePos))
    violate(
      report.endedAt,
      `invariant 4: bot ledger position ${ours.toString()} differs from SoDEX ${exchangePos.toString()}`,
    );
  return report;
}
