// Desk AI (DEC-164, DEC-165, AI_DESK_BPLUS_PROMPT mục 5): code tạo fact có cấu trúc, LLM chỉ viết lời quanh fact.
// Mỗi fact có id ổn định để ghi nhật ký lượt LLM và để kiểm tra mọi con số trong câu trả lời.

export const DESK_AI_CONFIG = {
  /** Model Claude (DEC-165a). */
  model: "claude-sonnet-5-5",
  /** Đổi khi sửa system prompt, ghi vào nhật ký mỗi lượt. */
  promptVersion: "desk-ai-v4",
  /** Câu hỏi mỗi user mỗi ngày (DEC-165b); báo cáo sáng không tính. */
  dailyQuestions: 20,
  /** Bot archived trong bấy nhiêu ngày gần nhất vẫn vào fact của Desk AI (DEC-193). */
  archivedDays: 30,
  /** Lưu chat (DEC-165c). */
  retentionDays: 90,
  /** Giờ địa phương có báo cáo sáng (DEC-165d). */
  briefHour: 8,
  /** Giới hạn độ dài câu hỏi và câu trả lời. */
  maxQuestionChars: 500,
  maxAnswerTokens: 600,
  /** Giá `claude-sonnet-5-5` (USD / 1M token; cache write loại 5 phút) để ghi chi phí ước tính từng lượt. */
  priceUsdPerMillion: { input: "2", output: "10", cacheRead: "0.1", cacheWrite: "2.5" },
} as const;

export type DeskAiFactUnit = "usdc" | "pct" | "x" | "count" | "text";

export const DESK_AI_FACT_KEYS = [
  "bot_state",
  "bot_net",
  "bot_fees",
  "bot_max_loss",
  "bot_leverage",
  "bot_stop_pct",
  "bot_liquidation_pct",
  "bot_taker_share_pct",
  "goal_limit",
  "goal_used",
  "questions_left",
  "decision",
  "decision_why",
  "decision_result",
  "market_change_24h_pct",
  "market_range_24h_pct",
  "market_price",
] as const;
export type DeskAiFactKey = (typeof DESK_AI_FACT_KEYS)[number];

export interface DeskAiFact {
  /** Id ổn định để ghi nhật ký, ví dụ `bot_net:<botId>`. */
  id: string;
  key: DeskAiFactKey;
  /** Tên bot do user đặt: là dữ liệu, không phải chỉ dẫn (mục 5.5). */
  bot: string | null;
  /** Market của fact thị trường (dữ liệu hệ thống, không phải văn bản user nhập). */
  market?: string | null;
  value: string;
  unit: DeskAiFactUnit;
  /** Nguồn hiện trên chip: `config`, `bot_state`, `fills`, `estimate`, `goals`, `risk`. */
  source: string;
}
