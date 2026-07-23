#!/bin/sh
# Ensure data directory exists
mkdir -p /app/data

# Wallet-based mode only — no legacy single-bot fallback.
# All bot configs, trades, state are scoped per wallet under /app/data/{walletAddress}/
export DATA_DIR=/app/data

exec npx tsx src/bot.ts
