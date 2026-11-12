import {
  dec,
  leaderSubject,
  type LeaderFillMessage,
  type LeaderPositionMessage,
} from "@drift/shared";

// Copy Trade (DEC-161): theo dõi ví leader có bot copy đang chạy. Mỗi ví một WS `accountTrade` (Perps, không cần xác
// thực); fill của SoDEX không kèm vị thế, nên giữ vị thế từng market ở đây: mốc từ REST, cộng dồn từng fill, và đọc lại
// REST định kỳ để tự sửa lệch (fill trùng hoặc lỡ quanh lúc đọc mốc, stream rớt). Chỉ đọc, không bao giờ ký.

export interface LeaderTrade {
  /** Symbol Perps của SoDEX. */
  market: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  at: number;
}

/** Vị thế (có dấu) theo market của từng ví leader. Thuần, không I/O. */
export class LeaderBook {
  readonly #pos = new Map<string, Map<string, string>>();

  /** Thay toàn bộ vị thế của ví bằng bản đọc từ REST. */
  reset(address: string, positions: Readonly<Record<string, string>>): void {
    const m = new Map<string, string>();
    for (const [market, size] of Object.entries(positions))
      if (!dec(size).isZero()) m.set(market, dec(size).toString());
    this.#pos.set(address, m);
  }

  has(address: string): boolean {
    return this.#pos.has(address);
  }

  forget(address: string): void {
    this.#pos.delete(address);
  }

  /** Áp một fill; trả vị thế sau fill. */
  apply(address: string, t: LeaderTrade): string {
    const m = this.#pos.get(address) ?? new Map<string, string>();
    const next = dec(m.get(t.market) ?? "0").add(dec(t.quantity).mul(t.side === "buy" ? 1 : -1));
    if (next.isZero()) m.delete(t.market);
    else m.set(t.market, next.toString());
    this.#pos.set(address, m);
    return next.toString();
  }

  positions(address: string): Record<string, string> {
    return Object.fromEntries(this.#pos.get(address) ?? []);
  }
}

export interface LeaderStream {
  close(): void;
}

export interface LeaderWatcherDeps {
  /** Ví leader (chữ thường) có bot copy nguồn SoDEX đang chạy. */
  activeLeaders(): Promise<string[]>;
  /** Vị thế Perps hiện tại của ví (REST). */
  readPositions(address: string): Promise<Record<string, string>>;
  /** Mở WS `accountTrade` cho ví. */
  openStream(
    address: string,
    handlers: { onTrades(trades: LeaderTrade[]): void; onReconnect(): void },
  ): LeaderStream;
  publish(subject: string, payload: LeaderFillMessage | LeaderPositionMessage): void;
  now(): number;
  warn(detail: object, message: string): void;
  /**
   * Số WS leader tối đa. SoDEX chỉ cho 10 user khác nhau mỗi IP trên WS (OPEN_QUESTIONS 6), nên ví vượt mức chỉ được
   * đọc vị thế qua REST: vẫn bù đóng / giảm, không copy được lệnh mở.
   */
  maxStreams: number;
}

export class LeaderWatcher {
  readonly #d: LeaderWatcherDeps;
  readonly #book = new LeaderBook();
  readonly #streams = new Map<string, LeaderStream>();

  constructor(deps: LeaderWatcherDeps) {
    this.#d = deps;
  }

  /** Một vòng: mở / đóng stream theo danh sách ví, đọc lại vị thế và publish. Gọi định kỳ (mỗi 30 s). */
  async sync(): Promise<void> {
    const wanted = new Set(await this.#d.activeLeaders());
    for (const [address, stream] of this.#streams)
      if (!wanted.has(address)) {
        stream.close();
        this.#streams.delete(address);
        this.#book.forget(address);
      }
    for (const address of wanted) {
      try {
        await this.#refresh(address);
        if (this.#streams.has(address)) continue;
        if (this.#streams.size < this.#d.maxStreams) this.#open(address);
        else this.#d.warn({ address }, "leader stream limit reached; reading positions only");
      } catch (error) {
        this.#d.warn({ err: error, address }, "leader read failed");
      }
    }
  }

  stop(): void {
    for (const s of this.#streams.values()) s.close();
    this.#streams.clear();
  }

  #open(address: string): void {
    const stream = this.#d.openStream(address, {
      onTrades: (trades) => {
        // Chưa có mốc vị thế thì không suy ra được vị thế sau fill: bỏ, vòng `sync` kế tiếp sẽ đọc lại.
        if (!this.#book.has(address)) return;
        for (const t of trades) {
          const positionAfter = this.#book.apply(address, t);
          this.#d.publish(leaderSubject("sodex", address, "fill"), {
            source: "sodex",
            address,
            market: t.market,
            side: t.side,
            price: t.price,
            quantity: t.quantity,
            positionAfter,
            at: t.at,
          });
        }
      },
      onReconnect: () => {
        void this.#refresh(address).catch((error: unknown) => {
          this.#d.warn({ err: error, address }, "leader read after reconnect failed");
        });
      },
    });
    this.#streams.set(address, stream);
  }

  async #refresh(address: string): Promise<void> {
    const positions = await this.#d.readPositions(address);
    this.#book.reset(address, positions);
    this.#d.publish(leaderSubject("sodex", address, "position"), {
      source: "sodex",
      address,
      positions: this.#book.positions(address),
      at: this.#d.now(),
    });
  }
}
