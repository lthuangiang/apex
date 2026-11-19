import { dec, Decimal } from "../money";

import { NEWS_CLASSIFIER } from "./rules";

// Chi phí Claude của lane tin tức theo từng bài (#290, DEC-TBD-sr-article-usage). Hàm thuần, Decimal; không làm tròn
// (UI tự định dạng). Thiếu số thì trả null, không bao giờ coi là 0.

export interface ClaudeTokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Bảng giá USD / 1M token, cùng dạng `NEWS_CLASSIFIER.pricing` (chuỗi thập phân). */
export interface ClaudePricing {
  inputPerM: string;
  outputPerM: string;
  /** Ghi cache = bội số của giá đầu vào (TTL 1 giờ: 2×). */
  cacheWriteMultiple: string;
  /** Đọc cache = bội số của giá đầu vào (0.1×). */
  cacheReadMultiple: string;
}

const MILLION = new Decimal(1_000_000);

function tokens(n: number, name: string): Decimal {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(`${name} must be a non-negative integer`);
  return new Decimal(n);
}

/**
 * Chi phí USD của một lượng token: (đầu vào + ghi cache × bội số ghi + đọc cache × bội số đọc) × giá đầu vào / 1M
 * + đầu ra × giá đầu ra / 1M.
 */
export function claudeCostUsd(
  t: ClaudeTokens,
  pricing: ClaudePricing = NEWS_CLASSIFIER.pricing,
): Decimal {
  const inputSide = tokens(t.input, "input")
    .add(tokens(t.cacheWrite, "cacheWrite").mul(dec(pricing.cacheWriteMultiple)))
    .add(tokens(t.cacheRead, "cacheRead").mul(dec(pricing.cacheReadMultiple)));
  return inputSide
    .mul(dec(pricing.inputPerM))
    .add(tokens(t.output, "output").mul(dec(pricing.outputPerM)))
    .div(MILLION);
}

/** Cột usage Claude của một dòng `signal_articles` (mọi cột nullable). */
export interface ArticleUsageColumns {
  claudeCalls: number | null;
  claudeInputTokens: number | null;
  claudeCacheWriteTokens: number | null;
  claudeCacheReadTokens: number | null;
  claudeOutputTokens: number | null;
  claudeModel: string | null;
  claudePromptVersion: string | null;
}

export interface ArticleClaudeUsage {
  /** Số lần gọi API cho bài (kể cả thử lại và lần lỗi). */
  calls: number;
  /** Null khi có lần gọi không nhận được phản hồi (không biết token). */
  tokens: ClaudeTokens | null;
  model: string | null;
  promptVersion: string | null;
  /** Chuỗi thập phân USD; null khi không có token hoặc model không có trong bảng giá. */
  costUsd: string | null;
}

/**
 * Usage của một bài để hiển thị. Null = bài không qua Claude hoặc bài cũ trước khi lưu usage ("Not available").
 * Chỉ tính $ khi model của bài đúng model có bảng giá (`NEWS_CLASSIFIER.model`), không đoán giá model khác.
 */
export function articleClaudeUsage(
  row: ArticleUsageColumns,
  priced: { model: string; pricing: ClaudePricing } = {
    model: NEWS_CLASSIFIER.model,
    pricing: NEWS_CLASSIFIER.pricing,
  },
): ArticleClaudeUsage | null {
  if (row.claudeCalls === null) return null;
  const t =
    row.claudeInputTokens === null ||
    row.claudeCacheWriteTokens === null ||
    row.claudeCacheReadTokens === null ||
    row.claudeOutputTokens === null
      ? null
      : {
          input: row.claudeInputTokens,
          cacheWrite: row.claudeCacheWriteTokens,
          cacheRead: row.claudeCacheReadTokens,
          output: row.claudeOutputTokens,
        };
  return {
    calls: row.claudeCalls,
    tokens: t,
    model: row.claudeModel,
    promptVersion: row.claudePromptVersion,
    costUsd:
      t === null || row.claudeModel !== priced.model
        ? null
        : claudeCostUsd(t, priced.pricing).toFixed(),
  };
}
