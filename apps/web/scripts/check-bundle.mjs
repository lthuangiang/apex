// Chặn rò logic chiến lược vào bundle trình duyệt: quét `.next/static` (chunk ai cũng tải được) sau `next build` và
// fail nếu thấy chuỗi chỉ có trong logic bước của chiến lược hoặc ngưỡng engine đề xuất. Chạy: `pnpm check:bundle`.
// Mỗi marker lấy từ code server (step / signal / reco), không trùng câu chữ UI hay field API; thêm marker khi thêm chiến lược.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STATIC = fileURLToPath(new URL("../.next/static", import.meta.url));

const MARKERS = {
  "volume farm (signal / entry / exit)": [
    "candleMomentum",
    "wickRejection",
    "volumeAcceleration",
    "SPREAD_TOO_WIDE",
    "COUNTER_TREND_BLOCKED",
    "exitUnfilled",
    "Signal pointed",
    "INSUFFICIENT_CANDLES",
  ],
  "volume maker": ["warming up price data", "smartHold", "fairBp", "clampBp"],
  "grid bots": ["waiting_trigger", "Order size per level is below SoDEX minimum"],
  "dca bots": ["waiting_base", "Base order is below SoDEX minimum"],
  "adaptive dca": ["NOT_ENOUGH_DATA: waiting for 5-minute candles"],
  "copy trade": ["reduceAttempts", "Signal too old to open a position"],
  "funding arb": ["Part of a leg is still open", "Leg size is below SoDEX minimum"],
  rebalancing: ["waiting_prices", "Bought each asset up to its target weight"],
  twap: ["Slice is below SoDEX minimum order size"],
  "recurring buy": ["Amount is below SoDEX minimum order size"],
  "paper / step events": ["POST_ONLY_WOULD_TRADE", "positionSync"],
  "reco engine thresholds": ["gridMinRangeScore", "highLeverageLossShare", "dcaSigmaMinPct"],
};

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".js") ? [p] : [];
  });
}

let chunks;
try {
  chunks = files(STATIC);
} catch {
  console.error(`check-bundle: ${STATIC} not found; run \`pnpm --filter @drift/web build\` first.`);
  process.exit(1);
}
if (chunks.length === 0) {
  console.error("check-bundle: no chunks under .next/static");
  process.exit(1);
}

const found = [];
for (const file of chunks) {
  const src = readFileSync(file, "utf8");
  for (const [area, markers] of Object.entries(MARKERS)) {
    for (const m of markers) if (src.includes(m)) found.push(`${area}: "${m}" in ${file}`);
  }
}

if (found.length > 0) {
  console.error("check-bundle: server-only strategy / reco logic found in browser chunks:");
  for (const f of found) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-bundle: ${String(chunks.length)} chunks clean`);
