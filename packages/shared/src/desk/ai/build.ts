import { dec } from "../../money";
import type { GoalGauge } from "../goal";
import { liquidationDistance, type DeskBotFacts, type DeskStopCheck } from "../needs-you";

import { DESK_AI_CONFIG, type DeskAiFact } from "./facts";

// Fact cho Desk AI từ dữ liệu thật đã có: dữ liệu từng bot của "Needs you" (M1), thẻ Mục tiêu (M3), lượt hỏi còn lại.
// Không có số thì không có fact (LLM không được nhắc số đó; câu mẫu không hiện 0).

/** Khoảng thanh lý ước tính (DEC-172, chỉ isolated); hai chiều → chiều gần hơn. */
function liqOf(s: DeskStopCheck): string | null {
  if (s.marginMode !== "isolated") return null;
  const sides: ("long" | "short")[] = s.side === "both" ? ["long", "short"] : [s.side];
  const ds = sides
    .map((side) =>
      liquidationDistance({ tiers: s.tiers, leverage: s.leverage, notional: s.notional, side }),
    )
    .filter((d) => d !== null);
  if (ds.length === 0) return null;
  return ds.reduce((a, b) => (b.lt(a) ? b : a)).toString();
}

const usd = (v: string) => dec(v).toDecimalPlaces(2).toString();
const pct = (v: string) => dec(v).mul(100).toDecimalPlaces(2).toString();

export function deskAiFacts(input: {
  bots: readonly DeskBotFacts[];
  goal: GoalGauge | null;
  questionsUsed: number;
}): DeskAiFact[] {
  const out: DeskAiFact[] = [];
  // Hai bot trùng tên (chạy lại sau khi stop, archive) thì thêm "#2", "#3" theo thứ tự để phân biệt.
  const total = new Map<string, number>();
  for (const b of input.bots) total.set(b.name, (total.get(b.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const b of input.bots) {
    const n = (seen.get(b.name) ?? 0) + 1;
    seen.set(b.name, n);
    const name = (total.get(b.name) ?? 0) > 1 && n > 1 ? `${b.name} #${String(n)}` : b.name;
    const f = (key: DeskAiFact["key"], value: string, unit: DeskAiFact["unit"], source: string) =>
      out.push({ id: `${key}:${b.botId}`, key, bot: name, value, unit, source });
    f("bot_state", b.state, "text", "bot_state");
    if (b.net !== null) f("bot_net", usd(b.net), "usdc", "bot_state");
    if (b.fees !== null) f("bot_fees", usd(b.fees), "usdc", "fills");
    if (b.maxLoss !== null) f("bot_max_loss", usd(b.maxLoss), "usdc", "config");
    if (b.stop !== null) {
      f("bot_leverage", String(b.stop.leverage), "x", "config");
      f("bot_stop_pct", pct(b.stop.stopDistance), "pct", "config");
      const liq = liqOf(b.stop);
      if (liq !== null) f("bot_liquidation_pct", pct(liq), "pct", "estimate");
    }
    if (b.taker !== null && b.taker.trades > 0)
      f(
        "bot_taker_share_pct",
        dec(String(b.taker.takerTrades)).div(b.taker.trades).mul(100).toDecimalPlaces(0).toString(),
        "pct",
        "fills",
      );
  }
  if (input.goal !== null) {
    out.push({
      id: "goal_limit",
      key: "goal_limit",
      bot: null,
      value: input.goal.limit,
      unit: "usdc",
      source: "goals",
    });
    if (input.goal.used !== null)
      out.push({
        id: "goal_used",
        key: "goal_used",
        bot: null,
        value: input.goal.used,
        unit: "usdc",
        source: "risk",
      });
  }
  out.push({
    id: "questions_left",
    key: "questions_left",
    bot: null,
    value: String(Math.max(0, DESK_AI_CONFIG.dailyQuestions - input.questionsUsed)),
    unit: "count",
    source: "limit",
  });
  return out;
}
