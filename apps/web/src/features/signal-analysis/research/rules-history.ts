import type { ResearchArticle, ResearchFunnel, ResearchSummary } from "@drift/shared";

import { classifierShort } from "./version-text";

// #413 (DEC-TBD-sr-history-across-versions, mockup docs/mockups/signal-research/history-across-versions.html): đổi version
// Rules chỉ reset phần đếm, không ẩn dữ liệu. Hàm thuần dựng dòng ngăn cách của feed và câu "{a} articles ran on Rules v3
// (until …), {b} on Rules v4" của phễu từ số API trả về; thiếu mốc thì bỏ ngày, không đoán.

export type RulesHistory = ResearchSummary["rulesHistory"];
export type RulesStart = RulesHistory[number];

export type FeedRow =
  { kind: "article"; a: ResearchArticle } | { kind: "divider"; key: string; start: RulesStart };

/**
 * Bài mới nhất trước; giữa hai bài khác version Rules chèn một dòng "Rules vN · Claude reader … started" của version MỚI
 * hơn (bài phía trên). Không biết version đó (thiếu trong `history`) thì vẫn chèn, không có ngày / reader.
 */
export function feedRows(items: readonly ResearchArticle[], history: RulesHistory): FeedRow[] {
  const rows: FeedRow[] = [];
  let prev: ResearchArticle | null = null;
  for (const a of items) {
    if (prev !== null && prev.rulesVersion !== a.rulesVersion) {
      const v = prev.rulesVersion;
      rows.push({
        kind: "divider",
        key: `rules-${String(v)}-${a.id}`,
        start: history.find((h) => h.v === v) ?? { v, startedAt: null, reader: null },
      });
    }
    rows.push({ kind: "article", a });
    prev = a;
  }
  return rows;
}

export interface RulesSplitPart {
  v: number;
  articles: number;
  /** Mốc version kế tiếp bắt đầu (= version này kết thúc); null với version mới nhất trong khoảng hoặc khi thiếu mốc. */
  until: string | null;
}

/**
 * Các phần của câu tóm tắt phễu, cũ trước mới. Chỉ khi khoảng có từ hai version Rules trở lên (một version thì không cần
 * câu này) → null.
 */
export function rulesSplit(
  funnel: Pick<ResearchFunnel, "rules"> | null,
  history: RulesHistory,
): RulesSplitPart[] | null {
  const rules = (funnel?.rules ?? []).filter((r) => r.articles > 0);
  if (rules.length < 2) return null;
  return rules.map((r) => {
    const next = history.filter((h) => h.v > r.v).sort((a, b) => a.v - b.v)[0];
    const last = r === rules[rules.length - 1];
    return { v: r.v, articles: r.articles, until: last ? null : (next?.startedAt ?? null) };
  });
}

/** "news-classifier-v4" → "v4"; tên khác giữ nguyên; null khi không có reader. */
export function readerShort(reader: string | null): string | null {
  return reader === null ? null : classifierShort(reader);
}
