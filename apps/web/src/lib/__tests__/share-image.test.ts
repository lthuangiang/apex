import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import messages from "../../../messages/en.json";
import { config } from "../../proxy";
import { SHARE_IMAGES, shareMetadata } from "../share-image";

const PUBLIC_DIR = join(__dirname, "../../../public");

/** Kích thước JPEG đọc từ marker SOFn, để không cần thêm thư viện ảnh. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < buf.length) {
    const marker = buf[i + 1] ?? 0;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error("no SOF marker");
}

describe("share images (DEC-156, DEC-TBD-share-images)", () => {
  it.each(Object.entries(SHARE_IMAGES))(
    "%s is a 1200×630 JPG under 300 KB in public/",
    (_key, image) => {
      const file = join(PUBLIC_DIR, image.url);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeLessThan(300 * 1024);
      expect(jpegSize(readFileSync(file))).toEqual({ width: image.width, height: image.height });
    },
  );

  it("keeps the approved alt texts", () => {
    expect(SHARE_IMAGES.landing.alt).toBe(
      "DeskLabs: Market Making and Volume Builder bots on SoDEX. Powered by SoDEX Builder Code.",
    );
    expect(SHARE_IMAGES.claude.alt).toBe(
      "DeskLabs for Claude: ask about your bots in plain words.",
    );
  });

  it("keeps the approved share copy", () => {
    expect(messages.landing.shareTitle).toBe(
      "{brand} · Volume on SoDEX, built mostly with maker orders",
    );
    expect(messages.landing.shareDescription).toBe(
      "Market Making and Volume Builder on your own SoDEX account. Every decision logged; it can never withdraw your funds.",
    );
    expect(messages.claudeGuide.shareTitle).toBe("Ask Claude about your DeskLabs bots");
    expect(messages.claudeGuide.shareDescription).toBe(
      "Connect DeskLabs to Claude and ask about your bots, portfolio and risk. Claude reads; you decide.",
    );
  });

  it("puts the same title, description and image on Open Graph and the X card", () => {
    const meta = shareMetadata("claude", "T", "D");
    expect(meta.openGraph).toMatchObject({
      title: "T",
      description: "D",
      images: [SHARE_IMAGES.claude],
    });
    expect(meta.twitter).toMatchObject({
      card: "summary_large_image",
      title: "T",
      description: "D",
      images: [SHARE_IMAGES.claude],
    });
  });

  it("serves every share image without going through the proxy (public, no sign-in)", () => {
    const source = config.matcher[0]?.source ?? "";
    const re = new RegExp(`^${source}$`);
    expect(re.test("/claude")).toBe(true);
    for (const image of Object.values(SHARE_IMAGES)) expect(re.test(image.url)).toBe(false);
  });
});
