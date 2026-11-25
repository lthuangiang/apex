import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  etfOnMajorAsset,
  listingOnMajorAsset,
  NEWS_CLASSIFIER,
  treasuryOnMajorAsset,
} from "@drift/shared";
import { z } from "zod";

import {
  addUsage,
  anthropicClassifier,
  emptyUsage,
  type ClassifyOutcome,
  type ClaudeUsage,
} from "../signal-research/classifier";
import { CLASSIFIER_SYSTEM } from "../signal-research/prompt";

import { overBudget, parseMaxUsd, usageUsd } from "./eval-budget";

// Đánh giá prompt classifier trước khi ship (#395). KHÔNG chạy trong CI: gọi Claude thật, tốn tiền.
//
//   DESK_AI_API_KEY=… pnpm --filter @drift/scheduler signals:eval-classifier -- \
//     --sample <bài.json>[,<bài2.json>] --baseline <prompt-cũ.ts> --universe <markets.json> [--max-calls 110] \
//     [--max-usd 1] [--out <kết quả.json>]
//
// Mỗi bài được phân loại hai lần trên cùng đường gọi của scheduler (tool, user message, kiểm câu trả lời): một lần với
// `CLASSIFIER_SYSTEM` của file prompt cũ (`--baseline`, vd bản `git show origin/main:…/prompt.ts` lưu ra ngoài repo), một lần
// với prompt hiện tại. Mỗi bài một lần gọi cho mỗi prompt, không thử lại; dừng khi chạm `--max-calls`, hoặc (#530) khi
// chi phí cộng dồn vượt `--max-usd` (kiểm sau MỖI lần gọi, không gọi tiếp; bài dở không vào bảng). Bài có id
// `synthetic-*` (bài tự soạn để thử, không phải bài thật) có tiền tố "[synthetic]" trong bảng. In bảng khác biệt
// (chỉ tiêu đề và kết quả, không in nội dung bài) và chi phí theo `NEWS_CLASSIFIER.pricing`. File bài và kết quả nằm ngoài
// repo (nội dung bài có bản quyền). Không bao giờ in hay ghi API key.

const candidateSchema = z.union([
  z.object({ market: z.string(), symbol: z.string(), kind: z.enum(["crypto", "stock"]) }),
  // File bài prod chỉ có tên market ("BTC-USD"): coi là coin.
  z
    .string()
    .transform((m) => ({ market: m, symbol: m.replace(/-USD$/, ""), kind: "crypto" as const })),
]);
const articleSchema = z.object({
  id: z.string(),
  source: z.string().default("unknown"),
  title: z.string().nullable(),
  content: z.string().nullable().default(""),
  publishedAt: z.string(),
  candidates: z.array(candidateSchema),
});
type Article = z.infer<typeof articleSchema>;

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const key = (process.env.DESK_AI_API_KEY ?? "").trim();
if (key === "") {
  console.error("DESK_AI_API_KEY is not set");
  process.exit(2);
}
const samplePaths = (arg("--sample") ?? "").split(",").filter((p) => p !== "");
const baselinePath = arg("--baseline");
const universePath = arg("--universe");
if (samplePaths.length === 0 || baselinePath === null || universePath === null) {
  console.error(
    "usage: --sample <a.json>[,<b.json>] --baseline <prompt.ts> --universe <markets.json>",
  );
  process.exit(2);
}
const maxCalls = Number(arg("--max-calls") ?? "110");
const maxUsdArg = parseMaxUsd(arg("--max-usd"));
if (!maxUsdArg.ok) {
  console.error("--max-usd must be a positive number of USD");
  process.exit(2);
}
const maxUsd = maxUsdArg.value;
const outPath = arg("--out");

const articles: Article[] = samplePaths.flatMap((p) =>
  z.array(articleSchema).parse(JSON.parse(readFileSync(resolve(p), "utf8"))),
);
const universe = z.array(z.string()).parse(JSON.parse(readFileSync(resolve(universePath), "utf8")));
const allMarkets = [
  ...new Set([...universe, ...articles.flatMap((a) => a.candidates.map((c) => c.market))]),
].sort();
const baseline = z
  .object({ CLASSIFIER_SYSTEM: z.string().min(1) })
  .parse(await import(pathToFileURL(resolve(baselinePath)).href)).CLASSIFIER_SYSTEM;
if (baseline === CLASSIFIER_SYSTEM) {
  console.error("baseline prompt is the same as the current prompt");
  process.exit(2);
}

const old = anthropicClassifier(key, undefined, { system: baseline });
const cur = anthropicClassifier(key);

interface Row {
  id: string;
  title: string;
  base: string;
  next: string;
  nextRule: string | null;
}

/**
 * "etf_approved · BTC-USD" / "none · NONE" / lỗi. #530 (reader v7): sự kiện nhiều coin ghi mọi market theo thứ tự trả về
 * ("listing · AAVE-USD + LINK-USD + UNI-USD"), để eval thấy bài nào đổi số coin.
 */
function text(o: ClassifyOutcome): string {
  if (!o.ok) return `error (${o.error})`;
  const markets = o.value.markets ?? [];
  const m = markets.length > 1 ? markets.join(" + ") : (o.value.market ?? "NONE");
  return `${o.value.catalyst} · ${m}`;
}

/** Luật cố định của Rules sau Claude (chỉ các luật BTC / ETH; các kiểm khác của bước Score không chạy ở đây). */
function ruleOf(o: ClassifyOutcome): string | null {
  if (!o.ok || o.value.catalyst === "none" || o.value.market === null) return null;
  const c = o.value.catalyst;
  if (etfOnMajorAsset(c, o.value.market)) return "ETF_MAJOR_ASSET";
  if (treasuryOnMajorAsset(c, o.value.market)) return "TREASURY_MAJOR_ASSET";
  if (listingOnMajorAsset(c, o.value.market)) return "LISTING_MAJOR_ASSET";
  return null;
}

let calls = 0;
let usage: ClaudeUsage = emptyUsage();
let unknownUsage = 0;
const rows: Row[] = [];
/** #530: lý do dừng theo `--max-usd` (in cuối bảng); null = không dừng vì chi phí. */
let budgetStop: string | null = null;
for (const a of articles) {
  if (calls + 2 > maxCalls) {
    console.error(
      `stopped at --max-calls ${String(maxCalls)} (${String(rows.length)} articles done)`,
    );
    break;
  }
  const input = {
    title: a.title,
    content: a.content ?? "",
    source: a.source,
    publishedAt: Date.parse(a.publishedAt),
    candidates: a.candidates,
    universe: allMarkets,
  };
  const outcomes: ClassifyOutcome[] = [];
  for (const c of [old, cur]) {
    const o = await c.classify(input, 1);
    outcomes.push(o);
    calls += Math.max(1, o.usage.calls);
    usage = addUsage(usage, o.usage);
    if (o.usageKnown === false) unknownUsage += 1;
    if (overBudget(usageUsd(usage), maxUsd)) break;
  }
  const [b, n] = outcomes;
  const complete = b !== undefined && n !== undefined;
  if (complete) {
    rows.push(rowOf(a, b, n));
    console.error(`${String(rows.length)}/${String(articles.length)}`);
  }
  if (overBudget(usageUsd(usage), maxUsd)) {
    budgetStop =
      `stopped at --max-usd ${maxUsd?.toFixed() ?? ""} on article ${a.id} (${a.title ?? "no title"}): ` +
      `${String(rows.length)} complete articles, cost $${usageUsd(usage).toFixed(4)}` +
      (complete ? "" : "; this article only has the baseline call and is not in the table");
    console.error(budgetStop);
    break;
  }
}

function rowOf(a: Article, b: ClassifyOutcome, n: ClassifyOutcome): Row {
  return {
    id: a.id,
    title: `${a.id.startsWith("synthetic-") ? "[synthetic] " : ""}${a.title ?? `(no title, id ${a.id})`}`,
    base: text(b),
    next: text(n),
    nextRule: ruleOf(n),
  };
}

const usd = usageUsd(usage);

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const diff = rows.filter((r) => r.base !== r.next || r.nextRule !== null);
const lines = [
  `Model ${NEWS_CLASSIFIER.model} · baseline vs ${NEWS_CLASSIFIER.promptVersion} · ${String(rows.length)} articles · ${String(calls)} calls`,
  "",
  "| Article | Baseline | Current | Rules after Claude |",
  "|---|---|---|---|",
  ...diff.map(
    (r) => `| ${cell(r.title)} | ${cell(r.base)} | ${cell(r.next)} | ${r.nextRule ?? "—"} |`,
  ),
  "",
  `Same result: ${String(rows.length - diff.length)} / ${String(rows.length)}`,
  `Tokens: input ${String(usage.input)}, cache write ${String(usage.cacheWrite)}, cache read ${String(usage.cacheRead)}, output ${String(usage.output)}`,
  `Cost: $${usd.toFixed(4)}${unknownUsage > 0 ? ` (+${String(unknownUsage)} calls with unknown usage)` : ""}`,
  ...(budgetStop === null ? [] : [budgetStop]),
];
console.log(lines.join("\n"));
if (outPath !== null)
  writeFileSync(
    resolve(outPath),
    JSON.stringify({ rows, calls, usage, usd: usd.toFixed(6), budgetStop }, null, 2),
  );
