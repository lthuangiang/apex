import { dec } from "../../money";

import type { DeskAiFact } from "./facts";

// Câu mẫu của Desk AI (LLM tắt / lỗi / số không khớp) chỉ hiện số liên quan tới câu hỏi, không đổ cả bảng mọi bot:
// - câu hỏi nhắc tên bot → chỉ bot đó;
// - không nhắc → bỏ bot archived, tối đa 3 bot, lỗ / lãi lớn nhất trước;
// - mỗi bot chỉ trạng thái, lãi / lỗ và phí (bảng ngắn; đòn bẩy, stop… để LLM giải thích khi được hỏi).
// Hàm thuần, không I/O (DEC-193).

const MAX_BOTS = 3;
const SHORT_KEYS: readonly DeskAiFact["key"][] = ["bot_state", "bot_net", "bot_fees"];

const botIdOf = (f: DeskAiFact): string | null =>
  f.bot === null ? null : (f.id.split(":")[1] ?? null);

export function templateFacts(question: string, facts: readonly DeskAiFact[]): DeskAiFact[] {
  const byBot = new Map<string, DeskAiFact[]>();
  for (const f of facts) {
    const id = botIdOf(f);
    if (id === null) continue;
    byBot.set(id, [...(byBot.get(id) ?? []), f]);
  }
  const q = question.toLowerCase();
  const nameOf = (fs: DeskAiFact[]) => fs[0]?.bot ?? "";
  const valueOf = (fs: DeskAiFact[], key: DeskAiFact["key"]) =>
    fs.find((f) => f.key === key)?.value ?? null;
  const all = [...byBot.entries()];
  const mentioned = all.filter(([, fs]) => {
    const name = nameOf(fs).trim().toLowerCase();
    return name.length >= 2 && q.includes(name);
  });
  const chosen =
    mentioned.length > 0
      ? mentioned
      : all
          .filter(([, fs]) => valueOf(fs, "bot_state") !== "archived")
          .sort(([, a], [, b]) => {
            const size = (fs: DeskAiFact[]) => {
              const n = valueOf(fs, "bot_net");
              return n === null ? -1 : dec(n).abs().toNumber();
            };
            return size(b) - size(a);
          })
          .slice(0, MAX_BOTS);
  return chosen.flatMap(([, fs]) => fs.filter((f) => SHORT_KEYS.includes(f.key)));
}
