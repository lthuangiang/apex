import { mentionsAsset, type AssetAlias, type Candidate } from "./logic";
import { AssetKind, COMPANY_NEWS_MARKETS } from "./rules";

// #593 (DEC-402 mục 6, DEC-403): tin về một công ty trong `COMPANY_NEWS_MARKETS` (Anthropic → ANT-USD). Chỉ tin CÔNG TY
// (vốn, định giá, gọi vốn, pháp lý, doanh thu, đối tác lớn) được giao dịch; tin sản phẩm / model / công cụ được đọc nhưng
// không giao dịch. Hàm thuần, tất định, chỉ đọc TIÊU ĐỀ: tên công ty xuất hiện trong rất nhiều bài sản phẩm, nên luật chặt:
// không chắc là tin công ty thì không giao dịch.

/** `company`: tin công ty (giao dịch được); `product`: tin sản phẩm / công cụ; `unclear`: không rõ, không giao dịch. */
export const CompanyNewsKind = {
  company: "company",
  product: "product",
  unclear: "unclear",
} as const;
export type CompanyNewsKind = (typeof CompanyNewsKind)[keyof typeof CompanyNewsKind];

/**
 * Dấu hiệu MẠNH của tin công ty. Thắng dấu hiệu sản phẩm ("Regulator opens inquiry into new model" là tin pháp lý).
 * Từ dễ nhầm với tin sản phẩm bị loại khỏi đây: "sales", "earnings", "profit" (bài sản phẩm hay nói tới), "fine"
 * (fine-tuning), "charge" (giá theo token), "ban" (chính sách dùng sản phẩm), "probe" đứng riêng (bài nghiên cứu), "raises"
 * đứng riêng ("raises concerns", "raises usage limits").
 */
const COMPANY_STRONG: readonly RegExp[] = [
  // Vốn / gọi vốn / định giá
  /\bfunding\b/i,
  /\bfund-?rais(e|es|ed|ing)\b/i,
  /\brais(e|es|ed|ing)\b[^.]{0,30}?(\$|€|£|\d|\bbillion\b|\bmillion\b|\bfunding\b|\bcapital\b|\bround\b)/i,
  /\bseries\s+[a-h]\b/i,
  /\bvaluations?\b/i,
  /\bvalu(ed|es|ing)\s+(it\s+)?at\b/i,
  /\binvest(s|ed|ing|ment|ments|or|ors)?\b/i,
  /\bstake\b/i,
  /\bIPO\b/,
  /\bgo(es|ing)?\s+public\b/i,
  /\bpublic\s+offering\b/i,
  /\btender\s+offer\b/i,
  // Pháp lý / quản lý
  /\blawsuits?\b/i,
  /\bsu(e|es|ed|ing)\b/i,
  /\bcourt\b/i,
  /\bjudge\b/i,
  /\bruling\b/i,
  /\bsettle(s|d|ment)?\b/i,
  /\bregulators?\b/i,
  /\bregulatory\b/i,
  /\bantitrust\b/i,
  /\b(FTC|SEC|DOJ|CMA)\b/,
  /\b(opens?|launch(es|ed)?|faces?|under)\s+(an?\s+)?(antitrust\s+|formal\s+)?(inquiry|investigation|probe)\b/i,
  /\b(inquiry|investigation|probe)\s+(into|of)\b/i,
  /\bsubpoena(s|ed)?\b/i,
  /\bfin(ed|es)\b/i,
  /\bpenalt(y|ies)\b/i,
  // Doanh thu
  /\brevenues?\b/i,
  /\brun[-\s]rate\b/i,
  /\bARR\b/,
  // M&A
  /\bacquir(e|es|ed|ing)\b/i,
  /\bacquisitions?\b/i,
  /\bmerger\b/i,
  /\btakeover\b/i,
  /\bbuyout\b/i,
];

/** Dấu hiệu tin sản phẩm / model / công cụ. */
const PRODUCT: readonly RegExp[] = [
  /\bmodels?\b/i,
  /\breleas(e|es|ed|ing)\b/i,
  /\blaunch(es|ed|ing)?\b/i,
  /\bunveil(s|ed|ing)?\b/i,
  /\bintroduc(e|es|ed|ing)\b/i,
  /\brolls?\s+out\b/i,
  /\brollout\b/i,
  /\bships?\b/i,
  /\bupdates?\b/i,
  /\bupgrades?\b/i,
  /\bversions?\b/i,
  /\bfeatures?\b/i,
  /\bAPIs?\b/,
  /\bSDKs?\b/,
  /\bapps?\b/i,
  /\btool(s|ing|kit)?\b/i,
  /\bagents?\b/i,
  /\bagentic\b/i,
  /\bplugins?\b/i,
  /\bextensions?\b/i,
  /\bbenchmarks?\b/i,
  /\bbeta\b/i,
  /\bpreview\b/i,
  /\bopen[-\s]sourc(e|es|ed|ing)\b/i,
  /\bavailable\b/i,
  /\bintegrat(e|es|ed|ing|ion|ions)\b/i,
  /\bchatbots?\b/i,
  /\bassistants?\b/i,
  /\bClaude\b/i,
  /\b(Opus|Sonnet|Haiku)\b/i,
  /\bMCP\b/,
  /\bcod(e|es|ing)\b/i,
  /\bcontext\s+window\b/i,
  /\bpricing\b/i,
  /\busage\s+limits?\b/i,
  /\brate\s+limits?\b/i,
  /\boutages?\b/i,
  /\bresearch(ers)?\b/i,
  /\bpapers?\b/i,
  /\bstudy\b/i,
  /\bguides?\b/i,
  /\bprompts?\b/i,
  /\bfine[-\s]?tun(e|es|ed|ing)\b/i,
];

/** Dấu hiệu đối tác lớn: chỉ là tin công ty khi tiêu đề không có dấu hiệu sản phẩm ("partners with X to bring Claude to Y" là sản phẩm). */
const PARTNERSHIP: readonly RegExp[] = [
  /\bpartnership\b/i,
  /\bpartner(s|ed|ing)?\s+with\b/i,
  /\b(strategic|multi-?year|multi-?billion|billion-dollar)\s+(deal|agreement|alliance|partnership)\b/i,
  /\bsigns?\s+(a\s+)?(deal|agreement|contract)\b/i,
];

const companyAliases = (market: string): AssetAlias[] =>
  (COMPANY_NEWS_MARKETS[market] ?? []).map((text) => ({ text, match: "word" as const }));

/** Market là market chỉ giao dịch tin công ty (`COMPANY_NEWS_MARKETS`). */
export const isCompanyNewsMarket = (market: string): boolean =>
  Object.hasOwn(COMPANY_NEWS_MARKETS, market);

/**
 * Loại tin của một bài với một market công ty, chỉ theo TIÊU ĐỀ. Tiêu đề không nêu tên công ty (hoặc không có tiêu đề) →
 * `unclear` (công ty chỉ được nhắc trong nội dung). Có dấu hiệu mạnh → `company`; không có mà có dấu hiệu sản phẩm →
 * `product`; còn lại đối tác lớn → `company`; không gì → `unclear`.
 */
export function companyNewsKindOf(title: string | null, market: string): CompanyNewsKind {
  const t = (title ?? "").replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim();
  if (t === "" || !mentionsAsset(t, companyAliases(market))) return CompanyNewsKind.unclear;
  if (COMPANY_STRONG.some((r) => r.test(t))) return CompanyNewsKind.company;
  if (PRODUCT.some((r) => r.test(t))) return CompanyNewsKind.product;
  if (PARTNERSHIP.some((r) => r.test(t))) return CompanyNewsKind.company;
  return CompanyNewsKind.unclear;
}

/**
 * Ứng viên theo tên trong bài (#593): market công ty có trên SoDEX mà tiêu đề hoặc nội dung nêu tên công ty (viết hoa chữ
 * đầu, đứng riêng một từ), dùng khi SoSoValue không gắn tag cho công ty chưa niêm yết. Kind `stock` như mọi market công ty.
 */
export function textCandidatesOf(
  title: string | null,
  content: string | null,
  markets: ReadonlySet<string>,
): Candidate[] {
  const text = `${title ?? ""}\n${content ?? ""}`;
  const out: Candidate[] = [];
  for (const market of Object.keys(COMPANY_NEWS_MARKETS)) {
    if (!markets.has(market) || !mentionsAsset(text, companyAliases(market))) continue;
    out.push({ symbol: market.replace(/-USD$/i, ""), market, kind: AssetKind.stock });
  }
  return out;
}
