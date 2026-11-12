import { dec, Decimal, hyperliquidMapKey, type HyperliquidMap } from "@drift/shared";
import { z } from "zod";

// Bản đồ thanh lý từ dữ liệu công khai của Hyperliquid (IMP-05, DEC-92). Cách quét theo HyperData Terminal
// (Apache-2.0), viết lại bằng TypeScript: lấy ví từ `recentTrades`, đọc `clearinghouseState` theo vòng, gộp
// giá thanh lý thành dải. Chỉ đọc API công khai có tài liệu, không dùng key. Dữ liệu chỉ để hiển thị, không đi
// vào strategy, reco hay quyết định đặt lệnh. Đây là mẫu các ví đang giao dịch, không phải toàn bộ thị trường.

export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const WALLETS_KEY = "liq:hl:wallets";

export const SCAN_CONFIG = {
  /** Chu kỳ quét. Weight: 150 ví × 2 + allMids 2 + 6 coin × 20 = 422 mỗi phút, dưới hạn 1200 của mỗi IP. */
  cycleMs: 60_000,
  walletsPerCycle: 150,
  batchSize: 10,
  batchGapMs: 1_000,
  maxWallets: 5_000,
  discoveryCoins: ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE"],
  /** Bỏ vị thế có giá thanh lý xa hơn ngần này so với giá hiện tại. */
  maxDistancePct: 20,
  /** Ít vị thế hơn thì chưa ghi map: mẫu quá nhỏ, tab vẫn ẩn. */
  minPositions: 20,
  /** Quá hạn thì map tự biến mất nếu scanner dừng. */
  mapTtlSeconds: 3_600,
} as const;

const positionSchema = z.object({
  coin: z.string(),
  liquidationPx: z.string().nullable(),
  positionValue: z.string(),
});
const clearinghouseSchema = z.object({
  assetPositions: z.array(z.object({ position: positionSchema })),
});
const tradesSchema = z.array(z.object({ users: z.array(z.string()).optional() }));
const midsSchema = z.record(z.string(), z.string());

export interface ScannedPosition {
  coin: string;
  liquidationPx: string;
  value: string;
}

/** Bước giá gọn (1 · 2 · 2.5 · 5 × 10ⁿ), khoảng 0.2% giá hiện tại. */
export function bandStep(mid: Decimal): Decimal {
  const target = mid.mul("0.002");
  const pow = new Decimal(10).pow(Math.floor(target.log(10).toNumber()));
  const step = [1, 2, 2.5, 5, 10].find((m) => pow.mul(m).gte(target)) ?? 10;
  return pow.mul(step);
}

/** Gộp vị thế của một coin thành dải giá theo giá thanh lý; hàm thuần để test. */
export function toBands(
  positions: readonly ScannedPosition[],
  mid: string,
): HyperliquidMap["bands"] {
  const m = dec(mid);
  if (!m.gt(0)) return [];
  const step = bandStep(m);
  const reach = m.mul(SCAN_CONFIG.maxDistancePct).div(100);
  const totals = new Map<string, Decimal>();
  for (const p of positions) {
    const px = dec(p.liquidationPx);
    if (!px.gt(0) || px.sub(m).abs().gt(reach)) continue;
    const bucket = px.div(step).floor().mul(step).toString();
    totals.set(bucket, (totals.get(bucket) ?? new Decimal(0)).add(p.value));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => dec(a).comparedTo(b))
    .map(([price, value]) => ({ price, value: value.toDecimalPlaces(2).toString() }));
}

export interface ScannerStore {
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

export interface ScannerDeps {
  store: ScannerStore;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  warn: (detail: object, message: string) => void;
}

export class LiquidationScanner {
  readonly #d: ScannerDeps;
  readonly #cache = new Map<string, ScannedPosition[]>();
  #wallets: string[] = [];
  #cursor = 0;
  #running = false;
  readonly #isRunning = (): boolean => this.#running;

  constructor(deps: ScannerDeps) {
    this.#d = deps;
  }

  async #info(body: object): Promise<unknown> {
    const res = await this.#d.fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Hyperliquid responded ${String(res.status)}`);
    return res.json();
  }

  async #discover(): Promise<void> {
    const known = new Set(this.#wallets);
    for (const coin of SCAN_CONFIG.discoveryCoins) {
      if (known.size >= SCAN_CONFIG.maxWallets) break;
      const trades = tradesSchema.parse(await this.#info({ type: "recentTrades", coin }));
      const fresh = trades
        .flatMap((t) => t.users ?? [])
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a) && !known.has(a));
      for (const a of fresh) known.add(a);
      if (fresh.length > 0) await this.#d.store.sadd(WALLETS_KEY, ...new Set(fresh));
    }
    this.#wallets = [...known].sort().slice(0, SCAN_CONFIG.maxWallets);
  }

  async #scanWallet(address: string): Promise<void> {
    const state = clearinghouseSchema.parse(
      await this.#info({ type: "clearinghouseState", user: address }),
    );
    const open = state.assetPositions.flatMap(({ position: p }) =>
      p.liquidationPx === null
        ? []
        : [{ coin: p.coin, liquidationPx: p.liquidationPx, value: p.positionValue }],
    );
    if (open.length > 0) {
      this.#cache.set(address, open);
      return;
    }
    // Ví không còn vị thế thì bỏ, chỗ trống dành cho ví đang giao dịch.
    this.#cache.delete(address);
    this.#wallets = this.#wallets.filter((a) => a !== address);
    await this.#d.store.srem(WALLETS_KEY, address);
  }

  /** Một chu kỳ: lấy thêm ví, quét vài trăm ví theo vòng, ghi map theo coin. */
  async cycle(): Promise<void> {
    await this.#discover();
    const n = this.#wallets.length;
    const take = Math.min(SCAN_CONFIG.walletsPerCycle, n);
    const slice = Array.from(
      { length: take },
      (_, i) => this.#wallets[(this.#cursor + i) % n] ?? "",
    );
    this.#cursor = n === 0 ? 0 : (this.#cursor + take) % n;
    for (let i = 0; i < slice.length; i += SCAN_CONFIG.batchSize) {
      const batch = slice.slice(i, i + SCAN_CONFIG.batchSize);
      // Một ví lỗi thì giữ dữ liệu cũ của ví đó, không coi là hết vị thế.
      await Promise.allSettled(batch.map((a) => this.#scanWallet(a)));
      if (i + SCAN_CONFIG.batchSize < slice.length) await this.#d.sleep(SCAN_CONFIG.batchGapMs);
    }
    await this.#publish();
  }

  async #publish(): Promise<void> {
    const mids = midsSchema.parse(await this.#info({ type: "allMids" }));
    const byCoin = new Map<string, ScannedPosition[]>();
    for (const list of this.#cache.values())
      for (const p of list) byCoin.set(p.coin, [...(byCoin.get(p.coin) ?? []), p]);
    for (const [coin, positions] of byCoin) {
      const mid = mids[coin];
      if (mid === undefined || positions.length < SCAN_CONFIG.minPositions) continue;
      const map: HyperliquidMap = { updatedAt: this.#d.now(), bands: toBands(positions, mid) };
      await this.#d.store.set(
        hyperliquidMapKey(coin),
        JSON.stringify(map),
        "EX",
        SCAN_CONFIG.mapTtlSeconds,
      );
    }
  }

  /** Chạy tới khi `stop()`; lỗi một chu kỳ không dừng vòng lặp. */
  async run(): Promise<void> {
    this.#running = true;
    this.#wallets = (await this.#d.store.smembers(WALLETS_KEY)).sort();
    while (this.#isRunning()) {
      const started = this.#d.now();
      await this.cycle().catch((error: unknown) => {
        this.#d.warn({ err: String(error) }, "liquidation scan failed");
      });
      const wait = SCAN_CONFIG.cycleMs - (this.#d.now() - started);
      if (this.#isRunning() && wait > 0) await this.#d.sleep(wait);
    }
  }

  stop(): void {
    this.#running = false;
  }
}
