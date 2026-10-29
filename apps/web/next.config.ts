import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// API thật nằm sau traefik ở cùng host (`/api`). Khi chạy `next dev` riêng thì proxy tới api.
const apiOrigin = process.env.API_INTERNAL_URL;

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@drift/ui", "@drift/shared", "@drift/strategies"],
  poweredByHeader: false,
  rewrites() {
    return Promise.resolve(
      apiOrigin === undefined
        ? []
        : [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }],
    );
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(config);
