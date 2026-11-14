import { z } from "zod";

// WebSocket bookTicker của Binance USDT-M futures (công khai, chỉ đọc) cho Binance guard của Market Making. Một kết nối
// gộp nhiều stream; đổi danh sách symbol thì nối lại. Đứt thì nối lại sau 1 s (Binance tự ngắt mỗi 24 giờ).

const BASE = "wss://fstream.binance.com/stream?streams=";

const messageSchema = z.object({
  data: z.object({ s: z.string(), b: z.string(), a: z.string(), T: z.number().int() }),
});

export const BINANCE_EXCHANGE_INFO = "https://fapi.binance.com/fapi/v1/exchangeInfo";

/** Symbol USDT perpetual đang giao dịch trên Binance futures. */
export async function binancePerpSymbols(): Promise<Set<string>> {
  const res = await fetch(BINANCE_EXCHANGE_INFO, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Binance exchangeInfo returned ${String(res.status)}`);
  const body = z
    .object({
      symbols: z.array(
        z.object({
          symbol: z.string(),
          contractType: z.string(),
          quoteAsset: z.string(),
          status: z.string(),
        }),
      ),
    })
    .parse(await res.json());
  return new Set(
    body.symbols
      .filter(
        (s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING",
      )
      .map((s) => s.symbol),
  );
}

export class BinanceBookStream {
  readonly #onBook: (symbol: string, bid: string, ask: string, T: number) => void;
  readonly #onError: (e: unknown) => void;
  #symbols: string[] = [];
  #ws: WebSocket | null = null;
  #closed = false;

  constructor(
    onBook: (symbol: string, bid: string, ask: string, T: number) => void,
    onError: (e: unknown) => void,
  ) {
    this.#onBook = onBook;
    this.#onError = onError;
  }

  setSymbols(symbols: readonly string[]): void {
    const next = [...new Set(symbols)].sort();
    if (next.join(",") === this.#symbols.join(",")) return;
    this.#symbols = next;
    this.#ws?.close();
    this.#ws = null;
    this.#open();
  }

  close(): void {
    this.#closed = true;
    this.#ws?.close();
  }

  #open(): void {
    if (this.#closed || this.#symbols.length === 0 || this.#ws !== null) return;
    const ws = new WebSocket(
      BASE + this.#symbols.map((s) => `${s.toLowerCase()}@bookTicker`).join("/"),
    );
    this.#ws = ws;
    ws.onmessage = (m) => {
      const r = messageSchema.safeParse(JSON.parse(String(m.data)));
      if (r.success) this.#onBook(r.data.data.s, r.data.data.b, r.data.data.a, r.data.data.T);
    };
    ws.onerror = (e) => {
      this.#onError(e);
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      setTimeout(() => {
        this.#open();
      }, 1_000);
    };
  }
}
