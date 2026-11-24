import { describe, expect, it } from "vitest";

import {
  SR_EXPORT_EXCERPT_CHARS,
  SR_EXPORT_SCHEMA_VERSION,
  srExportArticleSchema,
  srExportExcerpt,
} from "../api/signal-research-export";

// #509: đoạn đầu nội dung cho bài không có tiêu đề trong file Export data; ngắn, đã chuẩn hoá, không bao giờ là nguyên bài.

describe("srExportExcerpt", () => {
  it("collapses whitespace and keeps a short post whole", () => {
    expect(srExportExcerpt("  $LIT   unlock\n\n tomorrow:\t 12% of supply  ")).toBe(
      "$LIT unlock tomorrow: 12% of supply",
    );
  });

  it("cuts at 280 Unicode characters including the ellipsis", () => {
    const long = "x".repeat(400);
    const out = srExportExcerpt(long) ?? "";
    expect(Array.from(out)).toHaveLength(SR_EXPORT_EXCERPT_CHARS);
    expect(out.endsWith("…")).toBe(true);
    // Cắt ngay sau một từ: bỏ khoảng trắng cuối trước "…", không bao giờ quá 280.
    const words = srExportExcerpt("token unlock ".repeat(40)) ?? "";
    expect(Array.from(words).length).toBeLessThanOrEqual(SR_EXPORT_EXCERPT_CHARS);
    expect(words).toMatch(/\S…$/);
    // Đúng 280 ký tự: không cắt, không thêm "…".
    const exact = `${"word ".repeat(55)}word`;
    expect(Array.from(exact)).toHaveLength(279);
    expect(srExportExcerpt(`${exact}s`)).toBe(`${exact}s`);
    // Emoji / ký tự ngoài BMP tính là một ký tự, không bị cắt đôi.
    const emoji = srExportExcerpt("🚀".repeat(300)) ?? "";
    expect(Array.from(emoji)).toHaveLength(SR_EXPORT_EXCERPT_CHARS);
    expect(emoji.slice(0, 2)).toBe("🚀");
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("removes URLs, emails, wallet addresses, long hex and HTML tags", () => {
    const raw =
      "<p>Unlock <b>LIT</b> https://example.test/a?apikey=SECRET123 www.foo.test/x mail me@desk.test " +
      "wallet 0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db sig " +
      `${"ab".repeat(40)} sol 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU done</p>`;
    const out = srExportExcerpt(raw) ?? "";
    expect(out).toBe("Unlock LIT mail wallet sig sol done");
    for (const bad of ["http", "www.", "SECRET123", "@", "0x4E1e", "abab", "7xKXtg", "<", ">"])
      expect(out.includes(bad), bad).toBe(false);
  });

  it("null content or nothing left → null", () => {
    expect(srExportExcerpt(null)).toBeNull();
    expect(srExportExcerpt("   ")).toBeNull();
    expect(srExportExcerpt("https://only.a.link/x")).toBeNull();
  });
});

describe("export schema v2", () => {
  it("bumps schemaVersion and accepts excerpt null or ≤ 280 characters only", () => {
    expect(SR_EXPORT_SCHEMA_VERSION).toBe(2);
    const excerpt = srExportArticleSchema.shape.excerpt;
    expect(excerpt.safeParse(null).success).toBe(true);
    expect(excerpt.safeParse("x".repeat(280)).success).toBe(true);
    expect(excerpt.safeParse("x".repeat(281)).success).toBe(false);
    expect(excerpt.safeParse("🚀".repeat(280)).success).toBe(true);
  });
});
