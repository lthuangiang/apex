# Stage 1: Build Stage
FROM node:20.12.0-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

# Install all deps (including devDeps for tsc + tsx)
RUN npm ci

COPY src ./src

RUN npm run build

# Stage 2: Production Stage
FROM node:20.12.0-alpine

ENV NODE_ENV=production
ENV XDG_CACHE_HOME=/app/.cache

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

# Install all deps — tsx is needed at runtime to handle ESM/CJS interop
RUN npm ci

COPY src ./src
COPY --from=builder /app/dist/dashboard ./dist/dashboard
COPY bot-configs.json ./bot-configs.default.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh

# Ensure /tmp is writable by node user (tsx uses /tmp/tsx-<uid> for cache)
RUN mkdir -p /tmp/tsx-1000 /app/.cache && chmod 1777 /tmp && chown -R node:node /tmp/tsx-1000 /app/.cache && chmod +x ./docker-entrypoint.sh && chown -R node:node /app

EXPOSE 3000

USER node

CMD ["./docker-entrypoint.sh"]
