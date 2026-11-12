import type { MetadataRoute } from "next";

// Web manifest (`/manifest.webmanifest`): để cài DeskLabs như app và để build app Android dạng TWA
// (infra/mobile/README.md). Màu theo token `--bg` / `--accent` của packages/ui; icon sinh từ app/icon.svg.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "DeskLabs",
    short_name: "DeskLabs",
    description: "Automated trading strategies for your SoDEX account.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#eef1fa",
    // Status bar cùng màu nền app (token `--bg`), không còn dải màu riêng ở đỉnh màn hình.
    theme_color: "#eef1fa",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
