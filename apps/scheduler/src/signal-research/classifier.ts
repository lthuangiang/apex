import Anthropic from "@anthropic-ai/sdk";
import { NEWS_CATALYSTS, NEWS_CLASSIFIER, type Candidate, type NewsCatalyst } from "@drift/shared";
import { z } from "zod";

import { CLASSIFIER_SYSTEM } from "./prompt";

// Bước Understand (#271, #269 v3.4): Claude chỉ trả lời bằng các lựa chọn cố định qua một tool bắt buộc. Tool liệt kê
// mọi market SoDEX (ổn định giữa các lần gọi để prompt cache được); token phải nằm trong danh sách ứng viên của bài, sai là
// "Not understood". Lỗi API hoặc câu trả lời ngoài lựa chọn → thử lại một lần, rồi "Not understood".

const TOOL_NAME = "record_classification";
const TIMEOUT_MS = 20_000;

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
  relevance: "direct" | "passing_mention";
  promotional: boolean;
  eventDate: string | null;
}

export interface ClaudeUsage {
  calls: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export type ClassifyOutcome =
  | { ok: true; value: Classification; usage: ClaudeUsage }
  | { ok: false; error: string; usage: ClaudeUsage };

export interface NewsClassifier {
  classify(input: ClassifyInput): Promise<ClassifyOutcome>;
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

/** Token đầu vào quy đổi cho ngân sách ngày: đọc từ cache tính 1/10 (đúng tỉ lệ giá). */
export function weightedInput(u: Pick<ClaudeUsage, "input" | "cacheWrite" | "cacheRead">): number {
  return u.input + u.cacheWrite + Math.ceil(u.cacheRead / 10);
}

const answerSchema = z.object({
  catalyst: z.enum(NEWS_CATALYSTS as [NewsCatalyst, ...NewsCatalyst[]]),
  market: z.string(),
  relevance: z.enum(["direct", "passing_mention"]),
  promotional: z.boolean(),
  event_date: z.string().regex(/^(\d{4}-\d{2}-\d{2}|unknown)$/),
});

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
  return {
    ok: true,
    value: {
      catalyst: a.catalyst,
      market: a.market === "NONE" ? null : a.market,
      relevance: a.relevance,
      promotional: a.promotional,
      eventDate: a.event_date === "unknown" ? null : a.event_date,
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

export function anthropicClassifier(apiKey: string): NewsClassifier {
  // Thử lại do chính lớp này quyết định (một lần), không để SDK tự thử thêm.
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });

  async function once(input: ClassifyInput): Promise<{
    usage: ClaudeUsage;
    result: { ok: true; value: Classification } | { ok: false; error: string };
  }> {
    try {
      const r = await client.messages.create({
        model: NEWS_CLASSIFIER.model,
        max_tokens: NEWS_CLASSIFIER.maxTokens,
        tools: [classifierTool(input.universe)],
        tool_choice: { type: "tool", name: TOOL_NAME },
        system: [{ type: "text", text: CLASSIFIER_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userMessage(input) }],
      });
      const usage: ClaudeUsage = {
        calls: 1,
        input: r.usage.input_tokens,
        cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
        cacheRead: r.usage.cache_read_input_tokens ?? 0,
        output: r.usage.output_tokens,
      };
      const block = r.content.find((b) => b.type === "tool_use");
      if (block === undefined)
        return { usage, result: { ok: false, error: `no_tool_use:${r.stop_reason ?? ""}` } };
      return { usage, result: parseAnswer(block.input, input.candidates) };
    } catch (e) {
      // Chỉ tên lớp lỗi + HTTP status, không bao giờ message thô (có thể kèm header / request).
      const status = e instanceof Anthropic.APIError ? String(e.status ?? "") : "";
      const name = e instanceof Error ? e.name : "error";
      return {
        usage: emptyUsage(),
        result: { ok: false, error: `api:${name}${status === "" ? "" : `:${status}`}` },
      };
    }
  }

  return {
    async classify(input) {
      const first = await once(input);
      if (first.result.ok) return { ok: true, value: first.result.value, usage: first.usage };
      const second = await once(input);
      const usage = addUsage(first.usage, second.usage);
      if (second.result.ok) return { ok: true, value: second.result.value, usage };
      return { ok: false, error: second.result.error, usage };
    },
  };
}
