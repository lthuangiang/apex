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

WORKDIR /app

COPY package*.json ./

# Install all deps — tsx is needed at runtime to handle ESM/CJS interop
RUN npm ci

COPY --from=builder /app/dist ./dist

RUN chown -R node:node /app

EXPOSE 3000

USER node

CMD ["npx", "tsx", "dist/bot.js"]
