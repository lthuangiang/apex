import Anthropic from "@anthropic-ai/sdk";
import { NEWS_CATALYSTS, NEWS_CLASSIFIER, type Candidate, type NewsCatalyst } from "@drift/shared";
import { z } from "zod";

import { CLASSIFIER_SYSTEM } from "./prompt";

// Bước Understand (#271, #269 v3.4): Claude chỉ trả lời bằng các lựa chọn cố định qua một tool bắt buộc. Tool liệt kê
// mọi market SoDEX (ổn định giữa các lần gọi để prompt cache được); token phải nằm trong danh sách ứng viên của bài, sai là
// "Not understood". Lỗi API hoặc câu trả lời ngoài lựa chọn → thử lại một lần, rồi "Not understood".

const TOOL_NAME = "record_classification";
const TIMEOUT_MS = 20_000;
const TREASURY_AMOUNT_MAX = 80;

export interface ClassifyInput {
  title: string | null;
  content: string;
  source: string;
  publishedAt: number;
  candidates: readonly Candidate[];
  /** Mọi market perps của SoDEX (danh sách enum của tool, sắp xếp để prefix không đổi). */
  universe: readonly string[];
}

export interface Classification {
  catalyst: NewsCatalyst;
  /** Market ứng viên, hoặc null khi Claude trả "NONE". */
  market: string | null;
  /**
   * #530 (news-classifier-v7): mọi market của MỘT sự kiện, theo thứ tự bài nêu: `market` trước rồi `other_markets` (chỉ
   * ứng viên của bài, bỏ trùng). Rỗng khi `market` null. Thiếu ở bài phân loại trước v7 = chỉ `market`.
   */
  markets?: string[];
  relevance: "direct" | "passing_mention";
  promotional: boolean;
  eventDate: string | null;
  /**
   * news-v3 (#298): số tiền treasury mua / bán đúng như bài viết ("4,225 BTC", "$472M"); null = Claude không trích được
   * (hoặc không phải tin treasury). Không bao giờ tự đoán. Thiếu = null.
   */
  treasuryAmount?: string | null;
}

export interface ClaudeUsage {
  calls: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * `usageKnown` (#290): false khi có lần gọi không biết token (lỗi mạng / timeout, không có phản hồi HTTP: request có thể
 * đã chạy và tính tiền). Lỗi có HTTP status (4xx / 5xx) không tính tiền nên token 0 là số thật. Thiếu = true.
 */
export type ClassifyOutcome =
  | { ok: true; value: Classification; usage: ClaudeUsage; usageKnown?: boolean }
  | { ok: false; error: string; usage: ClaudeUsage; usageKnown?: boolean };

export interface NewsClassifier {
  /** `maxAttempts` (1 hoặc 2): số lần gọi API tối đa, kể cả thử lại (trần mỗi chu kỳ đếm lần gọi). */
  classify(input: ClassifyInput, maxAttempts?: number): Promise<ClassifyOutcome>;
}

export const emptyUsage = (): ClaudeUsage => ({
  calls: 0,
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
});

export function addUsage(a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage {
  return {
    calls: a.calls + b.calls,
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

/**
 * Đơn vị ngân sách ngày = token đầu vào quy đổi theo giá (`NEWS_CLASSIFIER.pricing`): đầu vào 1×, ghi cache TTL 1 giờ 2×,
 * đọc cache 0.1×, đầu ra 5×. 2M đơn vị ≈ 2 USD với Haiku 4.5.
 */
export function weightedInput(
  u: Pick<ClaudeUsage, "input" | "cacheWrite" | "cacheRead" | "output">,
): number {
  const p = NEWS_CLASSIFIER.pricing;
  const out = Number(p.outputPerM) / Number(p.inputPerM);
  return Math.ceil(
    u.input +
      u.cacheWrite * Number(p.cacheWriteMultiple) +
      u.cacheRead * Number(p.cacheReadMultiple) +
      u.output * out,
  );
}

/** Cột usage của `signal_articles` (#290). */
export interface ArticleUsageValues {
  claudeCalls: number;
  claudeInputTokens: number | null;
  claudeCacheWriteTokens: number | null;
  claudeCacheReadTokens: number | null;
  claudeOutputTokens: number | null;
  claudeModel: string;
  claudePromptVersion: string;
}

/**
 * Usage của MỘT bài từ kết quả classify của bài đó (#290, DEC-326). Mỗi request chỉ chứa một bài nên
 * gán thẳng, không chia; thử lại cộng vào cùng bài. Không biết token của một lần gọi (`usageKnown` false) → mọi cột token
 * null, không ghi một phần. Model / prompt version là giá trị đã gửi trong request.
 */
export function articleUsageValues(
  out: Pick<ClassifyOutcome, "usage" | "usageKnown">,
): ArticleUsageValues {
  const known = out.usageKnown !== false;
  return {
    claudeCalls: out.usage.calls,
    claudeInputTokens: known ? out.usage.input : null,
    claudeCacheWriteTokens: known ? out.usage.cacheWrite : null,
    claudeCacheReadTokens: known ? out.usage.cacheRead : null,
    claudeOutputTokens: known ? out.usage.output : null,
    claudeModel: NEWS_CLASSIFIER.model,
    claudePromptVersion: NEWS_CLASSIFIER.promptVersion,
  };
}

const answerSchema = z.object({
  catalyst: z.enum(NEWS_CATALYSTS as [NewsCatalyst, ...NewsCatalyst[]]),
  market: z.string(),
  relevance: z.enum(["direct", "passing_mention"]),
  promotional: z.boolean(),
  event_date: z.string().regex(/^(\d{4}-\d{2}-\d{2}|unknown)$/),
  treasury_amount: z.string().optional(),
  other_markets: z.array(z.string()).optional(),
});

/** Số tiền treasury như bài viết; rỗng / "unknown" / thiếu → null. Cắt ngắn để không lưu cả đoạn văn. */
function amountOf(raw: string | undefined): string | null {
  const a = (raw ?? "").trim();
  if (a === "" || a.toLowerCase() === "unknown") return null;
  return a.slice(0, TREASURY_AMOUNT_MAX);
}

/** Kiểm câu trả lời của Claude: đúng schema, market là "NONE" hoặc một ứng viên của bài. */
export function parseAnswer(
  raw: unknown,
  candidates: readonly Candidate[],
): { ok: true; value: Classification } | { ok: false; error: string } {
  const p = answerSchema.safeParse(raw);
  if (!p.success) return { ok: false, error: "invalid_answer" };
  const a = p.data;
  if (a.market !== "NONE" && !candidates.some((c) => c.market === a.market))
    return { ok: false, error: "market_not_candidate" };
  const market = a.market === "NONE" ? null : a.market;
  // #530: coin khác của cùng sự kiện. Market không thuộc ứng viên thì bỏ riêng market đó (không làm hỏng cả câu trả lời):
  // market chính vẫn giữ.
  const markets =
    market === null
      ? []
      : [
          ...new Set([
            market,
            ...(a.other_markets ?? []).filter((m) => candidates.some((c) => c.market === m)),
          ]),
        ];
  return {
    ok: true,
    value: {
      catalyst: a.catalyst,
      market,
      markets,
      relevance: a.relevance,
      promotional: a.promotional,
      eventDate: a.event_date === "unknown" ? null : a.event_date,
      treasuryAmount: amountOf(a.treasury_amount),
    },
  };
}

export function classifierTool(universe: readonly string[]): Anthropic.Tool {
  return {
    name: TOOL_NAME,
    description:
      "Record the classification of one news article. Call exactly once. Use only the allowed values; market must be one of this request's candidate markets or NONE.",
    input_schema: {
      type: "object",
      properties: {
        catalyst: {
          type: "string",
          enum: [...NEWS_CATALYSTS],
          description: "Event type from the catalyst list, or none.",
        },
        market: {
          type: "string",
          enum: [...[...universe].sort(), "NONE"],
          description: "The candidate market the event is directly about, or NONE.",
        },
        relevance: { type: "string", enum: ["direct", "passing_mention"] },
        promotional: { type: "boolean" },
        event_date: {
          type: "string",
          description: "UTC date YYYY-MM-DD when the event happened, or unknown.",
        },
        other_markets: {
          type: "array",
          items: { type: "string", enum: [...universe].sort() },
          description:
            "Other candidate markets the same single event is directly about, in the order the article names them. Empty when the event is about one asset.",
        },
        treasury_amount: {
          type: "string",
          description:
            'Only for treasury_buy or treasury_sell: the amount bought or sold, copied exactly as the article states it (for example "4,225 BTC" or "$472M"), or unknown if the article states no amount. Never estimate. Leave it out for other catalysts.',
        },
      },
      required: ["catalyst", "market", "relevance", "promotional", "event_date"],
      additionalProperties: false,
    },
  };
}

export function userMessage(input: ClassifyInput): string {
  const candidates = input.candidates.map((c) => `${c.market} (${c.symbol}, ${c.kind})`).join(", ");
  return [
    `Source: ${input.source}`,
    `Published (UTC): ${new Date(input.publishedAt).toISOString()}`,
    `Candidate markets: ${candidates}`,
    `Title: ${input.title ?? "(no title)"}`,
    "Article text:",
    "<article>",
    input.content.slice(0, NEWS_CLASSIFIER.maxContentChars),
    "</article>",
  ].join("\n");
}

export interface ClassifierLog {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/** Phần cố định của request (tools + system có `cache_control`), dùng chung cho gọi thật và đếm token. */
function prefixOf(universe: readonly string[], system: string = CLASSIFIER_SYSTEM) {
  return {
    tools: [classifierTool(universe)],
    system: [
      {
        type: "text" as const,
        text: system,
        cache_control: { type: "ephemeral" as const, ttl: NEWS_CLASSIFIER.cacheTtl },
      },
    ],
  };
}

/**
 * Đếm token của prefix được cache (tools + system) bằng `messages.countTokens` (miễn phí), với một tin nhắn user tối thiểu.
 * Haiku 4.5 chỉ cache prefix ≥ 4 096 token.
 */
export async function countPrefixTokens(
  apiKey: string,
  universe: readonly string[],
): Promise<{ prefixPlusMinimalUser: number }> {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  const r = await client.messages.countTokens({
    model: NEWS_CLASSIFIER.model,
    ...prefixOf(universe),
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: "." }],
  });
  return { prefixPlusMinimalUser: r.input_tokens };
}

/**
 * Tự kiểm prompt cache theo ngày UTC: lần gọi thành công đầu tiên mỗi ngày log `cacheWrite` / `cacheRead` và số token của
 * prefix được cache; sau ≥ 2 lần gọi mà `cacheRead` vẫn 0 thì warn một lần (prefix dưới ngưỡng 4 096 token hoặc có thứ làm
 * đổi prefix).
 */
export function cacheSelfCheck(log: ClassifierLog, now: () => number = Date.now) {
  let day = "";
  let calls = 0;
  let read = 0;
  let warned = false;
  return (u: ClaudeUsage) => {
    if (u.calls === 0) return;
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      calls = 0;
      read = 0;
      warned = false;
    }
    calls += u.calls;
    read += u.cacheRead;
    if (calls === u.calls)
      log.info(
        {
          cacheWrite: u.cacheWrite,
          cacheRead: u.cacheRead,
          cachedPrefixTokens: u.cacheWrite + u.cacheRead,
        },
        "signal research claude cache check",
      );
    else if (calls >= 2 && read === 0 && !warned) {
      warned = true;
      log.warn({ calls }, "signal research claude prompt cache is not being read");
    }
  };
}

/**
 * `system` chỉ dùng cho script đánh giá so prompt cũ / mới (#395, `src/cli/classifier-eval.ts`); scheduler luôn dùng prompt
 * hiện tại `CLASSIFIER_SYSTEM`.
 */
export function anthropicClassifier(
  apiKey: string,
  log?: ClassifierLog,
  opts: { system?: string } = {},
): NewsClassifier {
  // Thử lại do chính lớp này quyết định (một lần), không để SDK tự thử thêm.
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  const check = log === undefined ? null : cacheSelfCheck(log);

  async function once(input: ClassifyInput): Promise<{
    usage: ClaudeUsage;
    known: boolean;
    result: { ok: true; value: Classification } | { ok: false; error: string };
  }> {
    try {
      const r = await client.messages.create({
        model: NEWS_CLASSIFIER.model,
        max_tokens: NEWS_CLASSIFIER.maxTokens,
        ...prefixOf(input.universe, opts.system),
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [{ role: "user", content: userMessage(input) }],
      });
      const usage: ClaudeUsage = {
        calls: 1,
        input: r.usage.input_tokens,
        cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
        cacheRead: r.usage.cache_read_input_tokens ?? 0,
        output: r.usage.output_tokens,
      };
      check?.(usage);
      const block = r.content.find((b) => b.type === "tool_use");
      if (block === undefined)
        return {
          usage,
          known: true,
          result: { ok: false, error: `no_tool_use:${r.stop_reason ?? ""}` },
        };
      return { usage, known: true, result: parseAnswer(block.input, input.candidates) };
    } catch (e) {
      // Chỉ tên lớp lỗi + HTTP status, không bao giờ message thô (có thể kèm header / request). Lần gọi lỗi vẫn tính là
      // một lần gọi API cho trần mỗi chu kỳ.
      const status = e instanceof Anthropic.APIError ? String(e.status ?? "") : "";
      const name = e instanceof Error ? e.name : "error";
      return {
        usage: { ...emptyUsage(), calls: 1 },
        // Có HTTP status = API đã trả lỗi, không tính tiền; không có (mạng / timeout) = không biết token.
        known: status !== "",
        result: { ok: false, error: `api:${name}${status === "" ? "" : `:${status}`}` },
      };
    }
  }

  return {
    async classify(input, maxAttempts = 2) {
      const first = await once(input);
      if (first.result.ok)
        return {
          ok: true,
          value: first.result.value,
          usage: first.usage,
          usageKnown: first.known,
        };
      if (maxAttempts < 2)
        return {
          ok: false,
          error: first.result.error,
          usage: first.usage,
          usageKnown: first.known,
        };
      const second = await once(input);
      const usage = addUsage(first.usage, second.usage);
      const usageKnown = first.known && second.known;
      if (second.result.ok) return { ok: true, value: second.result.value, usage, usageKnown };
      return { ok: false, error: second.result.error, usage, usageKnown };
    },
  };
}
