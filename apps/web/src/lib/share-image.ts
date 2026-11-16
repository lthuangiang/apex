import type { Metadata } from "next";

/**
 * Ảnh xem trước khi chia sẻ link (Open Graph / X card, DEC-156, DEC-281): file tĩnh ở `public/og/`,
 * proxy cho qua (matcher bỏ `og/`). Nguồn: `docs/mockups/share-images/` (bản tối). Ảnh không có số live.
 */
export const SHARE_IMAGES = {
  landing: {
    url: "/og/desklabs.jpg",
    width: 1200,
    height: 630,
    alt: "DeskLabs: Market Making and Volume Builder bots on SoDEX. Powered by SoDEX Builder Code.",
  },
  claude: {
    url: "/og/claude.jpg",
    width: 1200,
    height: 630,
    alt: "DeskLabs for Claude: ask about your bots in plain words.",
  },
} as const;

export type ShareImageKey = keyof typeof SHARE_IMAGES;

/** Khối `openGraph` + `twitter` của một trang. Next không gộp sâu `openGraph`, nên mỗi trang trả đủ cả khối. */
export function shareMetadata(
  key: ShareImageKey,
  title: string,
  description: string,
): Pick<Metadata, "openGraph" | "twitter"> {
  const image = SHARE_IMAGES[key];
  return {
    openGraph: { title, description, type: "website", siteName: "DeskLabs", images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}
