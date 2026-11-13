// Phạm vi trả lời v1 (DEC-165e, AI_DESK_BPLUS_PROMPT mục 5.6): giải thích, an toàn tiền, so sánh bot của user, tạo bot.
// Dự đoán giá hay khuyên mua bán coin cụ thể → từ chối bằng câu mẫu, không gọi LLM. Luật từ khoá tất định; câu nào
// không rõ thì để LLM trả lời trong phạm vi system prompt (vẫn qua kiểm tra số).

export type DeskAiIntent =
  "out_of_scope" | "safety" | "create" | "loss" | "strategy" | "market" | "general";

const OUT_OF_SCOPE = [
  /\b(price|prices)\b.*\b(will|going to|tomorrow|next week|predict|forecast|target)\b/i,
  /\b(will|going to)\b.*\b(go up|go down|pump|dump|moon|crash|rise|fall)\b/i,
  /\b(predict|prediction|forecast)\b/i,
  /\bshould i (buy|sell|short|long)\b/i,
  /\b(buy|sell) (some |more )?[A-Z]{2,10}\b/,
  /\bwhich (coin|token|crypto)\b/i,
  /\bbest (coin|token|crypto)\b/i,
];

/** `asksMarket`: câu hỏi nhắc một market SoDEX (BTC, ETH-USD…), xem `marketsInQuestion`. */
export function intentOf(question: string, opts: { asksMarket?: boolean } = {}): DeskAiIntent {
  if (OUT_OF_SCOPE.some((r) => r.test(question))) return "out_of_scope";
  if (/\b(safe|withdraw|steal|move my money|lose everything|security)\b/i.test(question))
    return "safety";
  if (/\b(start|create|make|set up|new) (a |my )?(first )?bot\b/i.test(question)) return "create";
  // Hỏi vì sao lỗ: câu mẫu chỉ hiện lãi / lỗ và phí (khi LLM tắt / lỗi).
  if (/\b(lose|lost|losing|loss|losses)\b/i.test(question)) return "loss";
  // Hỏi về thị trường (đã qua luật dự đoán ở trên): câu mẫu liệt kê số 24 giờ qua.
  // Hỏi chọn chiến lược ("Which strategy fits a sideways market?") không phải hỏi số thị trường.
  if (/\b(strategy|strategies|bot type|which bot)\b/i.test(question)) return "strategy";
  if (/\b(market|markets|volatile|volatility|sideways|choppy)\b/i.test(question)) return "market";
  if (opts.asksMarket === true) return "market";
  return "general";
}
