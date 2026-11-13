import type { HlClearinghouse, HlFill, HlPriority } from "@drift/hyperliquid";
import { toLeaderFill } from "@drift/hyperliquid";
import {
  dec,
  groupLeaderEvents,
  leaderSubject,
  HIP3_MAPPED_DEXES,
  sodexMarketOf,
  type CoinIndex,
  type LeaderEvent,
  type LeaderFillMessage,
  type LeaderPositionMessage,
  type TidFill,
} from "@drift/shared";

// Copy Trading v1 (DEC-163 mục 10–11, docs/COPY_TRADING_DATA.md): ví leader Hyperliquid, chỉ đọc.
// - T0: ví có bot copy đang chạy → WS `userFills` (≤ 8 ví / IP), đọc lại vị thế mỗi vòng sync; publish tín hiệu cho engine
//   với market đã đổi sang symbol SoDEX (coin SoDEX không có thì không publish).
// - T1: ví có người theo dõi (không thuộc T0) → poll `userFillsByTime` từ con trỏ, mỗi 2 phút, ≤ 40 ví.
// - Fill của cả hai tầng gộp 60 giây thành sự kiện (Trader profile, Following, big move).
// Mỗi ví chỉ được theo dõi một lần cho cả hệ thống: tracker chạy trong bản marketdata đang giữ lease.

export const HL_TRACKER = {
  maxStreams: 8,
  maxPolled: 40,
} as const;

export interface HlStream {
  setUsers(users: readonly string[]): void;
}

export interface HlLeaderTrackerDeps {
  copied(): Promise<string[]>;
  followed(): Promise<string[]>;
  stream: HlStream;
  hl: {
    clearinghouseState(user: string, priority: HlPriority, dex?: string): Promise<HlClearinghouse>;
    userFillsByTime(user: string, startTime: number, priority: HlPriority): Promise<HlFill[]>;
  };
  index(): CoinIndex;
  publish(subject: string, payload: LeaderFillMessage | LeaderPositionMessage): void;
  /** Fill mới nhất đã đọc (ms UTC); null = chưa đọc lần nào. */
  getCursor(address: string): Promise<number | null>;
  setCursor(address: string, ms: number): Promise<void>;
  /** Ghi sự kiện đã khép (bỏ trùng theo `lastTid`) rồi chạy kiểm tra big move. */
  onEvents(address: string, events: LeaderEvent[], seenAt: number): Promise<void>;
  now(): number;
  warn(detail: object, message: string): void;
  maxStreams?: number;
  maxPolled?: number;
}

export class HlLeaderTracker {
  readonly #d: HlLeaderTrackerDeps;
  /** Ví đang ở T0 (WS). */
  #t0: string[] = [];
  /** Fill chờ gộp theo ví. */
  readonly #pending = new Map<string, TidFill[]>();

  constructor(deps: HlLeaderTrackerDeps) {
    this.#d = deps;
  }

  get streaming(): readonly string[] {
    return this.#t0;
  }

  /** Vòng 30 s: chọn T0, đổi subscription (mới trước, cũ sau), đọc lại vị thế ví đang copy và publish. */
  async sync(): Promise<void> {
    const copied = [...new Set((await this.#d.copied()).map((a) => a.toLowerCase()))].sort();
    const max = this.#d.maxStreams ?? HL_TRACKER.maxStreams;
    // Giữ ví đang stream trước để không rớt tín hiệu của bot đang chạy.
    const keep = this.#t0.filter((a) => copied.includes(a));
    const next = [...keep, ...copied.filter((a) => !keep.includes(a))].slice(0, max);
    for (const a of copied.filter((x) => !next.includes(x)))
      this.#d.warn(
        { address: a },
        "hyperliquid leader stream limit reached; reading positions only",
      );
    this.#d.stream.setUsers(next);
    this.#t0 = next;
    for (const address of copied) {
      try {
        await this.refreshPositions(address);
      } catch (error) {
        this.#d.warn({ err: error, address }, "hyperliquid leader read failed");
      }
    }
  }

  /**
   * Đọc vị thế qua REST và publish (sau sync, sau reconnect). Chỉ market SoDEX có. Đọc cả perp gốc lẫn các dex HIP-3
   * được map (`xyz`): engine coi market thiếu trong ảnh chụp là vị thế 0, nên một lần đọc lỗi thì không publish gì
   * (không bao giờ gửi ảnh chụp thiếu).
   */
  async refreshPositions(address: string): Promise<void> {
    const states = await Promise.all([
      this.#d.hl.clearinghouseState(address, "realtime"),
      ...HIP3_MAPPED_DEXES.map((dex) => this.#d.hl.clearinghouseState(address, "realtime", dex)),
    ]);
    const index = this.#d.index();
    const positions: Record<string, string> = {};
    for (const p of states.flatMap((st) => st.assetPositions)) {
      const market = sodexMarketOf(p.position.coin, index);
      if (market === null || dec(p.position.szi).isZero()) continue;
      // `SYM` và `xyz:SYM` cùng map một market: cộng dồn (vị thế ròng của trader trên market đó).
      positions[market] = dec(positions[market] ?? "0")
        .add(p.position.szi)
        .toString();
    }
    this.#d.publish(leaderSubject("hyperliquid", address, "position"), {
      source: "hyperliquid",
      address,
      positions,
      at: this.#d.now(),
    });
  }

  /** Fill từ WS (T0): publish tín hiệu ngay, giữ lại để gộp sự kiện. */
  onWsFills(address: string, fills: readonly HlFill[]): void {
    const index = this.#d.index();
    for (const f of [...fills].sort((a, b) => a.time - b.time)) {
      const lf = toLeaderFill(f, address);
      this.#buffer(address, lf);
      const market = sodexMarketOf(f.coin, index);
      if (market === null) continue;
      const delta = f.side === "B" ? dec(f.sz) : dec(f.sz).neg();
      this.#d.publish(leaderSubject("hyperliquid", address, "fill"), {
        source: "hyperliquid",
        address,
        market,
        side: f.side === "B" ? "buy" : "sell",
        price: f.px,
        quantity: f.sz,
        positionAfter: dec(f.startPosition).add(delta).toString(),
        at: f.time,
      });
    }
  }

  /** Vòng 2 phút: poll ví được theo dõi không thuộc T0 (≤ 40). Lần đầu chỉ đặt con trỏ, không đọc lùi. */
  async poll(): Promise<void> {
    const followed = [...new Set((await this.#d.followed()).map((a) => a.toLowerCase()))]
      .filter((a) => !this.#t0.includes(a))
      .sort()
      .slice(0, this.#d.maxPolled ?? HL_TRACKER.maxPolled);
    for (const address of followed) {
      try {
        const cursor = await this.#d.getCursor(address);
        if (cursor === null) {
          await this.#d.setCursor(address, this.#d.now());
          continue;
        }
        const fills = await this.#d.hl.userFillsByTime(address, cursor + 1, "realtime");
        for (const f of fills) this.#buffer(address, toLeaderFill(f, address));
        const last = fills.at(-1);
        if (last !== undefined) await this.#d.setCursor(address, last.time);
      } catch (error) {
        this.#d.warn({ err: error, address }, "hyperliquid follow poll failed");
      }
    }
  }

  /** Vòng 10 s: khép nhóm fill đã quá 60 giây thành sự kiện. */
  async flush(): Promise<void> {
    const now = this.#d.now();
    const index = this.#d.index();
    for (const [address, fills] of this.#pending) {
      const { events, open } = groupLeaderEvents(fills, index, now);
      if (open.length > 0) this.#pending.set(address, open);
      else this.#pending.delete(address);
      if (events.length === 0) continue;
      try {
        await this.#d.onEvents(address, events, now);
        // T0 cũng đẩy con trỏ để ví chuyển sang T1 không đọc lại từ đầu.
        const last = Math.max(...events.map((e) => e.lastAt));
        if (this.#t0.includes(address)) await this.#d.setCursor(address, last);
      } catch (error) {
        this.#d.warn({ err: error, address }, "hyperliquid leader events failed");
      }
    }
  }

  #buffer(address: string, f: TidFill): void {
    const list = this.#pending.get(address) ?? [];
    if (!list.some((x) => x.tid === f.tid)) list.push(f);
    this.#pending.set(address, list);
  }
}
