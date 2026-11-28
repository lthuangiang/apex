import { describe, expect, it } from "vitest";

import { assetInText, companyNewsKindOf, isCompanyNewsMarket, textCandidatesOf } from "../index";
import {
  COMPANY_NEWS_MARKETS,
  NEWS_ASSET_MAP_VERSION,
  NEWS_RULES,
  SignalReason,
  STOCK_BRAND_ALIASES,
  STOCK_MARKET_SET,
} from "../signal-research/rules";

// #593 (DEC-402 mục 6, DEC-403): tin công ty Anthropic → ANT-USD; tin sản phẩm / công cụ đọc nhưng không giao dịch.
// Mọi tiêu đề dưới đây là câu mẫu tự viết, không chép từ bài báo nào.

const ANT = "ANT-USD";

describe("company news rules (DEC-403, #593)", () => {
  it("keeps Rules news-v6 (DEC-403), bumps only the asset map, lists ANT-USD as the Anthropic company market", () => {
    expect(NEWS_RULES.version).toBe("news-v6");
    expect(NEWS_RULES.versionNumber).toBe(6);
    expect(NEWS_ASSET_MAP_VERSION).toBe("assets-2026-11-28a");
    expect(COMPANY_NEWS_MARKETS).toEqual({ [ANT]: ["Anthropic"] });
    expect(STOCK_MARKET_SET.has(ANT)).toBe(true);
    expect(STOCK_BRAND_ALIASES[ANT]).toEqual(["Anthropic"]);
    expect(NEWS_RULES.bookDepthMarkets).toEqual([ANT]);
    expect(SignalReason.productNews).toBe("PRODUCT_NEWS");
    expect(SignalReason.notCompanyNews).toBe("NOT_COMPANY_NEWS");
    expect(isCompanyNewsMarket(ANT)).toBe(true);
    expect(isCompanyNewsMarket("NVDA-USD")).toBe(false);
    expect(isCompanyNewsMarket("toString")).toBe(false);
  });

  const COMPANY = [
    "Anthropic raises $13B in a Series F funding round",
    "Anthropic in talks for new funding at a $350B valuation",
    "ANTHROPIC RAISES $2 BILLION FROM NEW INVESTORS",
    "Regulator opens inquiry into Anthropic",
    "Sample headline: regulator opens inquiry into Anthropic",
    "Authors sue Anthropic over training data",
    "Court approves Anthropic settlement with authors",
    "Anthropic faces antitrust investigation in Europe",
    "Anthropic's annualized revenue run-rate tops $5B",
    "Cloud provider invests another $4B in Anthropic",
    "Anthropic signs multi-billion deal for compute capacity",
    "Anthropic announces strategic partnership with a large bank",
    "Anthropic files confidentially for an IPO",
    "Anthropic acquires a small analytics startup",
    "Employees sell shares in Anthropic tender offer",
    // Dấu hiệu mạnh thắng dấu hiệu sản phẩm: tin pháp lý / vốn về một model vẫn là tin công ty.
    "Anthropic's new model draws antitrust scrutiny",
    "Anthropic raises $5B as Claude usage grows",
  ];
  it.each(COMPANY)("company: %s", (title) => {
    expect(companyNewsKindOf(title, ANT)).toBe("company");
  });

  const PRODUCT = [
    "Anthropic releases a new Claude model",
    "Sample headline: Anthropic new model released",
    "Anthropic launches a Claude app for desktop",
    "Anthropic unveils a coding agent for developers",
    "Anthropic open-sources a protocol for AI tools",
    "Anthropic adds a memory feature to Claude",
    "Anthropic's assistant is now available in more regions",
    "Anthropic publishes research on model behavior",
    "Anthropic raises usage limits for subscribers",
    "Anthropic raises concerns about AI safety in a new paper",
    "Anthropic partners with a design startup to integrate Claude",
    "Anthropic fine-tunes Haiku for customer support",
    "Anthropic introduces new pricing for its API",
    "Anthropic ships a Claude Code update",
    "Developer tool maker integrates Anthropic models",
    "Anthropic Sonnet tops a coding benchmark",
    "Anthropic rolls out an SDK for agents",
    "Anthropic reports an outage on its chatbot",
  ];
  it.each(PRODUCT)("product (read, not traded): %s", (title) => {
    expect(companyNewsKindOf(title, ANT)).toBe("product");
  });

  const UNCLEAR = [
    // Tiêu đề không nêu công ty: chỉ nêu trong nội dung → không giao dịch.
    "AI labs race to hire researchers",
    // Chữ thường không phải tên công ty.
    "The anthropic principle explained",
    "Scientists name a new era the Anthropocene",
    "Anthropics are not a company",
    // Có tên nhưng không có dấu hiệu nào.
    "Anthropic CEO speaks at a conference",
    "",
  ];
  it.each(UNCLEAR)("unclear (not traded): %s", (title) => {
    expect(companyNewsKindOf(title, ANT)).toBe("unclear");
  });

  it("no title → unclear; another market → unclear (only listed company markets read titles)", () => {
    expect(companyNewsKindOf(null, ANT)).toBe("unclear");
    expect(companyNewsKindOf("Anthropic raises $13B", "NVDA-USD")).toBe("unclear");
  });
});

describe("text candidates (#593)", () => {
  const LIVE = new Set([ANT, "BTC-USD"]);

  it("adds ANT-USD when the title or the text names Anthropic and SoDEX lists it", () => {
    expect(textCandidatesOf("Anthropic raises $13B", null, LIVE)).toEqual([
      { symbol: "ANT", market: ANT, kind: "stock" },
    ]);
    expect(textCandidatesOf("AI funding recap", "Investors back Anthropic again.", LIVE)).toEqual([
      { symbol: "ANT", market: ANT, kind: "stock" },
    ]);
  });

  it("nothing when ANT-USD is not listed, or the name is a common word / another word", () => {
    expect(textCandidatesOf("Anthropic raises $13B", null, new Set(["BTC-USD"]))).toEqual([]);
    expect(textCandidatesOf("The anthropic principle", "anthropic reasoning", LIVE)).toEqual([]);
    expect(textCandidatesOf("Anthropocene report", null, LIVE)).toEqual([]);
    expect(textCandidatesOf("ANT token rallies", "Aragon ANT holders vote", LIVE)).toEqual([]);
  });

  it("the Anthropic name counts as the asset being in the article", () => {
    const c = { symbol: "ANT", market: ANT, kind: "stock" as const };
    expect(assetInText("Regulator opens inquiry into Anthropic", null, c, [])).toBe(true);
    expect(assetInText("AI stocks recap", null, c, [])).toBe(false);
  });
});
