# syntax=docker/dockerfile:1
# Image cho @drift/api (monorepo pnpm). Chạy bằng tsx, cùng mã nguồn TypeScript với dev. Không chạy bằng root.
FROM node:22.13.1-bookworm-slim
RUN npm i -g corepack@0.36.0 && corepack enable && mkdir /repo && chown node:node /repo
USER node
ENV NODE_ENV=production COREPACK_HOME=/home/node/.cache/corepack
WORKDIR /repo
COPY --chown=node:node pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN corepack install && pnpm fetch --frozen-lockfile
COPY --chown=node:node . .
RUN pnpm install --offline --frozen-lockfile --filter "@drift/api..."
CMD ["pnpm", "--filter", "@drift/api", "start"]
