#!/bin/sh
# Seed bot-configs.json to /app/data only on first run (preserves user edits)
if [ ! -f /app/data/bot-configs.json ]; then
  echo "[entrypoint] Seeding bot-configs.json to /app/data/"
  cp /app/bot-configs.default.json /app/data/bot-configs.json
fi

exec npx tsx src/bot.ts
