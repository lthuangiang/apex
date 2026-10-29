import type { MetadataRoute } from "next";

// Chỉ Landing được index (UI_REVIEW K, DEC-73); mọi trang khác còn có `noindex` trong metadata.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/$", disallow: "/" } };
}
