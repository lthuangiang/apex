# syntax=docker/dockerfile:1
# Image cho @drift/web: build Next.js rồi `next start`. /api do traefik chuyển thẳng tới api. Không chạy bằng root.
FROM node:22.13.1-bookworm-slim
RUN npm i -g corepack@0.36.0 && corepack enable && mkdir /repo && chown node:node /repo
USER node
ENV NEXT_TELEMETRY_DISABLED=1 COREPACK_HOME=/home/node/.cache/corepack
# WalletConnect Cloud (Reown) Project ID: Next nhúng biến NEXT_PUBLIC_* lúc build. Trống thì ẩn WalletConnect.
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=""
ENV NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
WORKDIR /repo
COPY --chown=node:node pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN corepack install && pnpm fetch --frozen-lockfile
COPY --chown=node:node . .
RUN pnpm install --offline --frozen-lockfile --filter "@drift/web..." \
  && pnpm --filter @drift/web build
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@drift/web", "start"]
