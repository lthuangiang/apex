import Anthropic from "@anthropic-ai/sdk";
import { DESK_AI_CONFIG } from "@drift/shared";

// Desk AI (DEC-165): gọi Claude API trực tiếp. Chỉ một việc: viết lời quanh fact. Không có tool, không thực thi gì.
// Key chỉ nằm trong client này (từ DESK_AI_API_KEY), không log, không trả về client. Test và dev dùng client giả.

export interface DeskLlmUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DeskLlm {
  complete(input: { system: string; user: string }): Promise<{
    text: string;
    model: string;
    /** `end_turn` là xong; `max_tokens` (bị cắt), `refusal`… → câu mẫu. */
    stopReason: string | null;
    usage: DeskLlmUsage;
  }>;
}

/** Hết giờ thì coi như LLM lỗi: dùng câu mẫu, không chờ lâu. */
const TIMEOUT_MS = 20_000;

export function anthropicLlm(apiKey: string): DeskLlm {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  return {
    async complete({ system, user }) {
      const r = await client.messages.create({
        model: DESK_AI_CONFIG.model,
        max_tokens: DESK_AI_CONFIG.maxAnswerTokens,
        // Chỉ viết lời quanh fact: không cần suy nghĩ dài. Model này mặc định bật thinking (effort high) và thinking
        // ăn vào max_tokens; `disabled` bị từ chối (400), nên dùng `between_tools` (không có tool → không nghĩ) và effort thấp.
        thinking: { type: "between_tools" },
        output_config: { effort: "low" },
        // System prompt cố định: cache để lượt sau chỉ trả giá đọc cache (mục 5.11).
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
      });
      const text = r.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      return {
        text,
        model: r.model,
        stopReason: r.stop_reason,
        usage: {
          input: r.usage.input_tokens,
          output: r.usage.output_tokens,
          cacheRead: r.usage.cache_read_input_tokens ?? 0,
          cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
