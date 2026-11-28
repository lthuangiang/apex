import { copyMarkets } from "./api/copy";
import { Strategy } from "./enums";
import { add, dec, Decimal, DECIMAL_STRING_PATTERN, mul } from "./money";

// Độ sâu sổ lệnh (DEC-402 mục 4–5, #588): MỘT nguồn cho ngưỡng, nhãn, phạm vi `DEPTH_CAP_MARKETS` và công thức tổng vị
// thế tối đa. Hàm thuần, không I/O: api (#589 trang US Market, #590 kiểm lúc tạo / sửa), engine (#590 trần lệnh vào, qua
// `@drift/strategies`) và web (#591 gợi ý "Largest position") cùng gọi. Không kéo `@drift/strategies` vào web.

// ── Ngưỡng ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Độ sâu = tổng notional (giá × khối lượng, đơn vị quote ≈ USD) của 10 mức giá mỗi phía (DEC-402 mục 4). */
export const DEPTH_LEVELS = 10;
/** Nhãn `Thin`: phía mỏng hơn dưới 10.000 USD. */
export const DEPTH_THIN_USD = "10000";
/** Nhãn `Very thin`: phía mỏng hơn dưới 1.000 USD. */
export const DEPTH_VERY_THIN_USD = "1000";
/** Lệnh khớp ngay để VÀO vị thế lấy tối đa phần này của notional 10 mức phía nó ăn (DEC-402 mục 5). */
export const ENTRY_DEPTH_SHARE = "0.25";

// ── Notional và nhãn ────────────────────────────────────────────────────────────────────────────────────────────────

/** Một mức giá của sổ lệnh: [giá, khối lượng] dạng chuỗi thập phân. */
export type DepthBookLevel = readonly [string, string];

/** Tổng notional `levels` mức đầu tiên (mặc định 10). Phía rỗng = "0" (đó là dữ liệu thật, không phải thiếu). */
export function sideNotional(
  levels: readonly DepthBookLevel[],
  max: number = DEPTH_LEVELS,
): string {
  let total: Decimal = dec("0");
  for (const [price, size] of levels.slice(0, max)) total = add(total, mul(price, size));
  return total.toFixed();
}

function minDec(a: string, b: string): Decimal {
  const x = dec(a);
  const y = dec(b);
  return x.lessThan(y) ? x : y;
}

/** Nhãn hiển thị của trang US Market (`GET /api/v1/markets/us`). */
export const DepthLabel = { ok: "ok", thin: "thin", veryThin: "very_thin" } as const;
export type DepthLabel = (typeof DepthLabel)[keyof typeof DepthLabel];
export const DEPTH_LABELS = [DepthLabel.ok, DepthLabel.thin, DepthLabel.veryThin] as const;

/** Nhãn theo phía mỏng hơn (DEC-402 mục 4). Hai phía 0 là `very_thin` (trạng thái sổ rỗng báo riêng qua `BookStatus`). */
export function depthLabelOf(bidsNotional: string, asksNotional: string): DepthLabel {
  const thinner = minDec(bidsNotional, asksNotional);
  if (thinner.lessThan(dec(DEPTH_VERY_THIN_USD))) return DepthLabel.veryThin;
  if (thinner.lessThan(dec(DEPTH_THIN_USD))) return DepthLabel.thin;
  return DepthLabel.ok;
}

/** Tổng notional hai phía của sổ 10 mức (khớp `BookTop` của `@drift/strategies`). */
export interface DepthSides {
  bidNotional: string;
  askNotional: string;
}

/** Nhãn dùng cho giới hạn theo sổ (engine + api): cùng ngưỡng với `depthLabelOf`, thêm `empty`. */
export type DepthCapLabel = "deep" | "thin" | "very_thin" | "empty";

/**
 * Nhãn độ sâu của market theo sổ 10 mức. `null` = một phía không có lệnh nào (engine `orderbook()` trả null khi một
 * phía rỗng), hoặc notional một phía bằng 0.
 */
export function depthCapLabel(book: DepthSides | null): DepthCapLabel {
  if (book === null) return "empty";
  const thinner = Decimal.min(dec(book.bidNotional), dec(book.askNotional));
  if (!thinner.gt(0)) return "empty";
  if (thinner.lt(DEPTH_VERY_THIN_USD)) return "very_thin";
  if (thinner.lt(DEPTH_THIN_USD)) return "thin";
  return "deep";
}

/** Giới hạn theo sổ chỉ áp cho market `Thin` / `Very thin` (và sổ rỗng); market đủ sâu giữ hành vi cũ (DEC-402 mục 5). */
export const depthCapApplies = (label: DepthCapLabel): boolean => label !== "deep";

// ── Phạm vi `DEPTH_CAP_MARKETS` (engine + api) ──────────────────────────────────────────────────────────────────────

/**
 * Market áp giới hạn theo sổ lệnh trong bản đầu (DEC-402 bổ sung 2026-11-28): Anthropic (perps + spot) và 8 cặp token quỹ.
 * Ghi đè bằng `DEPTH_CAP_MARKETS` (engine + api). Market ngoài danh sách: không đọc sổ, không cắt, không kiểm lúc tạo / sửa.
 * Web không đọc danh sách này: api trả danh sách đang áp qua `features.depthCapMarkets`.
 */
export const DEFAULT_DEPTH_CAP_MARKETS: readonly string[] = [
  "ANT-USD",
  "vANT_vUSDC",
  "vVOO_vUSDC",
  "vQQQ_vUSDC",
  "vSCHD_vUSDC",
  "vSMH_vUSDC",
  "vVGT_vUSDC",
  "vVYM_vUSDC",
  "vBOXX_vUSDC",
  "vSTRC_vUSDC",
];

/** Phạm vi giới hạn theo sổ: `all` = mọi market (`*`, có hỗ trợ nhưng chưa dùng), hoặc danh sách market. */
export interface DepthCapScope {
  all: boolean;
  markets: readonly string[];
}

/**
 * Đọc `DEPTH_CAP_MARKETS`: thiếu biến hoặc `default` → danh sách mặc định; chuỗi trống → tắt hẳn; `*` → mọi market; còn
 * lại là danh sách phân cách dấu phẩy (bỏ khoảng trắng, bỏ mục trống).
 */
export function parseDepthCapMarkets(raw: string | undefined): DepthCapScope {
  if (raw === undefined || raw.trim() === "default")
    return { all: false, markets: [...DEFAULT_DEPTH_CAP_MARKETS] };
  const items = raw
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (items.includes("*")) return { all: true, markets: [] };
  return { all: false, markets: [...new Set(items)] };
}

export const inDepthCapScope = (scope: DepthCapScope, market: string): boolean =>
  scope.all || scope.markets.includes(market);

// ── Tổng vị thế tối đa lúc tạo / sửa bot ─────────────────────────────────────────────────────────────────────────

/**
 * Max open position mặc định của Volume Maker khi không đặt `maxInventory`: bội số của order size (DEC-100). Nguồn của
 * `VM_DEFAULTS.maxInventoryMultiple` trong `@drift/strategies`.
 */
export const VM_MAX_INVENTORY_MULTIPLE = 2;

export interface MaxPosition {
  market: string;
  engine: "spot" | "perps";
  /** Notional tối đa (USD) bot có thể giữ trên market này theo cấu hình. */
  notional: string;
}

type Cfg = Readonly<Record<string, unknown>>;
const str = (c: Cfg, k: string): string => {
  const v = c[k];
  return typeof v === "string" || typeof v === "number" ? String(v) : "0";
};
const num = (c: Cfg, k: string): number => {
  const v = c[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
};
const marketOf = (c: Cfg, k = "market"): string => {
  const v = c[k];
  return typeof v === "string" ? v : "";
};

/**
 * Tổng vị thế tối đa (notional USD) của bot theo từng market (DEC-402 mục 5): vốn × đòn bẩy, hoặc tổng các lần mua của
 * DCA. `price` chỉ cần cho TWAP (khối lượng tính theo base). Trả mảng rỗng khi chiến lược không có market cố định lúc tạo
 * (`news_signal`: market theo tín hiệu, engine vẫn áp trần 25% cho từng lệnh vào).
 *
 * Recurring Buy dùng một lần mua (`amountPerBuy`): các lần mua cách nhau theo ngày / tuần, không mua dồn vào một sổ.
 */
export function maxPositionsOf(strategy: string, c: Cfg, price?: string): MaxPosition[] {
  const lev = (k = "leverage") => num(c, k) || 1;
  switch (strategy) {
    case Strategy.spotGrid:
      return [{ market: marketOf(c), engine: "spot", notional: str(c, "investment") }];
    case Strategy.futuresGrid:
      return [
        {
          market: marketOf(c),
          engine: "perps",
          notional: dec(str(c, "margin")).mul(lev()).toString(),
        },
      ];
    case Strategy.spotDca:
    case Strategy.futuresDca: {
      let total = dec(str(c, "baseOrder"));
      for (let k = 1; k <= num(c, "maxSafetyOrders"); k += 1)
        total = total.add(dec(str(c, "safetyOrder")).mul(dec(str(c, "sizeMultiplier")).pow(k - 1)));
      return strategy === Strategy.spotDca
        ? [{ market: marketOf(c), engine: "spot", notional: total.toString() }]
        : [{ market: marketOf(c), engine: "perps", notional: total.mul(lev()).toString() }];
    }
    case Strategy.recurringBuy:
      return [{ market: marketOf(c), engine: "spot", notional: str(c, "amountPerBuy") }];
    case Strategy.rebalancing: {
      const assets = Array.isArray(c.assets) ? (c.assets as Cfg[]) : [];
      return assets.flatMap((a) =>
        typeof a.market === "string"
          ? [
              {
                market: a.market,
                engine: "spot" as const,
                notional: dec(str(c, "investment")).mul(str(a, "weightPct")).div(100).toString(),
              },
            ]
          : [],
      );
    }
    case Strategy.fundingArb: {
      const leg = dec(str(c, "investment")).div(2).toString();
      return [
        { market: marketOf(c, "spotMarket"), engine: "spot", notional: leg },
        { market: marketOf(c, "perpMarket"), engine: "perps", notional: leg },
      ];
    }
    case Strategy.twap:
      return price === undefined
        ? []
        : [
            {
              market: marketOf(c),
              engine: c.engine === "perps" ? "perps" : "spot",
              notional: dec(str(c, "totalSize")).mul(price).toString(),
            },
          ];
    case Strategy.volumeMaker: {
      const inv =
        c.maxInventory !== undefined && c.maxInventory !== ""
          ? dec(str(c, "maxInventory"))
          : dec(str(c, "orderSize")).mul(
              typeof c.maxOrders === "number" ? c.maxOrders : VM_MAX_INVENTORY_MULTIPLE,
            );
      return [{ market: marketOf(c), engine: "perps", notional: inv.toString() }];
    }
    case Strategy.adaptiveDca:
      return [{ market: marketOf(c), engine: "perps", notional: str(c, "maxExposure") }];
    case Strategy.copyTrade:
      // `maxExposure` là trần tổng; bot có thể dồn hết vào một market, nên mỗi market kiểm với cả mức này.
      return copyMarkets(c).map((m) => ({
        market: m,
        engine: "perps" as const,
        notional: str(c, "maxExposure"),
      }));
    case Strategy.volumeFarm:
      return [{ market: marketOf(c), engine: "perps", notional: str(c, "orderSizeMaxUsd") }];
    default:
      return [];
  }
}

/** Dòng "Largest position" của form tạo bot (web #591): câu chữ theo cách tính. */
export type LargestKind = "grid_perps" | "grid_spot" | "dca_perps" | "dca_spot";

const LARGEST_FIELDS: Readonly<Record<string, { kind: LargestKind; required: readonly string[] }>> =
  {
    [Strategy.spotGrid]: { kind: "grid_spot", required: ["investment"] },
    [Strategy.futuresGrid]: { kind: "grid_perps", required: ["margin"] },
    [Strategy.spotDca]: {
      kind: "dca_spot",
      required: ["baseOrder", "safetyOrder", "maxSafetyOrders"],
    },
    [Strategy.futuresDca]: {
      kind: "dca_perps",
      required: ["baseOrder", "safetyOrder", "maxSafetyOrders"],
    },
  };

const decimalField = (c: Cfg, k: string): string | null => {
  const v = c[k];
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  return DECIMAL_STRING_PATTERN.test(s) ? s : null;
};

/**
 * Gợi ý "Largest position" lúc người dùng đang điền form (Futures / Spot Grid, Futures / Spot DCA): cùng công thức
 * `maxPositionsOf` mà api kiểm lúc tạo. null khi chiến lược không áp dụng hoặc thiếu / sai một ô bắt buộc (chưa đủ để
 * tính); ô tuỳ chọn thiếu dùng mặc định của form (đòn bẩy 1, hệ số nhân DCA 1).
 */
export function largestPositionOf(
  strategy: string,
  config: Cfg,
): { notional: string; kind: LargestKind } | null {
  const spec = LARGEST_FIELDS[strategy];
  if (spec === undefined) return null;
  const filled: Record<string, unknown> = {
    leverage: decimalField(config, "leverage") ?? "1",
    sizeMultiplier: decimalField(config, "sizeMultiplier") ?? "1",
  };
  for (const k of spec.required) {
    const v = decimalField(config, k);
    if (v === null) return null;
    filled[k] = v;
  }
  const [p] = maxPositionsOf(strategy, filled);
  return p === undefined ? null : { notional: dec(p.notional).toString(), kind: spec.kind };
}

export type PositionDepthIssue =
  | { kind: "empty"; market: string }
  | { kind: "too_large"; market: string; limit: string; notional: string };

/**
 * So tổng vị thế tối đa với phía mỏng hơn của sổ 10 mức (DEC-402 mục 5). Market đủ sâu (cả hai phía ≥ 10.000 USD) không
 * bị kiểm. Sổ rỗng một phía → `empty`.
 */
export function positionDepthIssue(
  p: MaxPosition,
  book: DepthSides | null,
): PositionDepthIssue | null {
  const label = depthCapLabel(book);
  if (!depthCapApplies(label)) return null;
  if (label === "empty" || book === null) return { kind: "empty", market: p.market };
  const thinner = Decimal.min(dec(book.bidNotional), dec(book.askNotional));
  if (dec(p.notional).lte(thinner)) return null;
  return {
    kind: "too_large",
    market: p.market,
    limit: thinner.toDecimalPlaces(0, Decimal.ROUND_DOWN).toString(),
    notional: dec(p.notional).toDecimalPlaces(2).toString(),
  };
}

/**
 * Bản sửa có làm tăng tổng vị thế tối đa ở market nào không (chỉ khi đó api kiểm lại theo sổ, DEC-402: bot đang chạy không
 * bị chặn khi sửa mà không tăng vốn). Market mới (không có ở bản cũ) tính là tăng.
 */
export function raisedPositions(
  before: readonly MaxPosition[],
  after: readonly MaxPosition[],
): MaxPosition[] {
  return after.filter((p) => {
    const old = before.find((b) => b.market === p.market && b.engine === p.engine);
    return old === undefined || dec(p.notional).gt(old.notional);
  });
}
