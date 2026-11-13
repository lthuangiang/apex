# syntax=docker/dockerfile:1
# Image cho @drift/signer (monorepo pnpm). Chạy bằng tsx, cùng mã nguồn TypeScript với dev. Không chạy bằng root.
# Thứ tự layer: phần chung → cài thư viện (chỉ đổi khi lockfile / manifest đổi) → mã nguồn (đổi code chỉ đổi layer cuối).
FROM node:22.13.1-bookworm-slim
RUN npm i -g corepack@0.36.0 && corepack enable && mkdir /repo && chown node:node /repo
USER node
ENV COREPACK_HOME=/home/node/.cache/corepack
WORKDIR /repo
# Phần đầu (tới hết manifest) GIỐNG HỆT ở cả 11 Dockerfile: cùng cache, cùng digest, VPS chỉ tải một lần
# (DEC-214). Không thêm ARG / ENV trước dòng này. Thêm package mới vào workspace thì thêm dòng COPY
# manifest của nó ở cả 11 file.
COPY --chown=node:node pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN corepack install && pnpm fetch --frozen-lockfile
COPY --chown=node:node apps/api/package.json apps/api/
COPY --chown=node:node apps/backtest/package.json apps/backtest/
COPY --chown=node:node apps/engine/package.json apps/engine/
COPY --chown=node:node apps/jobs/package.json apps/jobs/
COPY --chown=node:node apps/marketdata/package.json apps/marketdata/
COPY --chown=node:node apps/mcp/package.json apps/mcp/
COPY --chown=node:node apps/realtime/package.json apps/realtime/
COPY --chown=node:node apps/reco/package.json apps/reco/
COPY --chown=node:node apps/scheduler/package.json apps/scheduler/
COPY --chown=node:node apps/signer/package.json apps/signer/
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node packages/db/package.json packages/db/
COPY --chown=node:node packages/hyperliquid/package.json packages/hyperliquid/
COPY --chown=node:node packages/runtime/package.json packages/runtime/
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node packages/sodex/package.json packages/sodex/
COPY --chown=node:node packages/strategies/package.json packages/strategies/
COPY --chown=node:node packages/ui/package.json packages/ui/
COPY --chown=node:node e2e/flows/package.json e2e/flows/
COPY --chown=node:node e2e/sodex-mock/package.json e2e/sodex-mock/
ENV NODE_ENV=production
RUN pnpm install --offline --frozen-lockfile --filter "@drift/signer..."
COPY --chown=node:node . .
CMD ["pnpm", "--filter", "@drift/signer", "start"]
