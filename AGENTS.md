# AGENTS.md

## Project snapshot
DRIFT is a multi-bot perpetual futures trading system with three exchanges supported in the main codebase: SoDEX, Dango, and Decibel. It can run in single-bot legacy mode or multi-bot mode from `bot-configs.json`, and it also supports wallet-scoped tenant storage under `./data`.

## Main entrypoints
- `src/bot.ts` — application bootstrap, config/state load, single-bot vs multi-bot selection, tenant restore, graceful shutdown.
- `src/dashboard/server.ts` — Express dashboard, auth, bot management views, SSE, tenant-aware routes.
- `src/bot/loadBotConfigs.ts` — reads and validates `bot-configs.json`.
- `src/bot/adapterFactory.ts` — builds exchange adapters from env vars or stored credentials.
- `src/bot/TenantRegistry.ts` — wallet registry, tenant restore, tenant shutdown, platform stats.

## How the app starts
1. Loads `.env`.
2. Restores persisted config/state.
3. Loads bot configs from `BOT_CONFIGS_PATH` or `./bot-configs.json`.
4. Chooses multi-bot mode if configs exist, otherwise falls back to legacy single-bot mode.
5. Starts Telegram, dashboard, and tenant restore logic.
6. Registers SIGINT/SIGTERM shutdown handlers.

## Runtime modes
- **Single-bot mode**: uses `EXCHANGE`, `SYMBOL`, and legacy env credentials.
- **Multi-bot mode**: creates a `BotManager` and instantiates each bot from `bot-configs.json`.
- **Tenant mode**: wallet-scoped bot/config/credential data lives under `./data/<wallet>/` and is restored on startup.

## Exchange adapters
Supported adapters are:
- `sodex`
- `dango`
- `decibel`
- `hibachi`

Credential sources are either:
- legacy env vars in single-bot mode
- encrypted stored credentials in tenant mode

## Dashboard notes
- Dashboard port defaults to `3000`.
- Auth may be disabled if no passcode is set.
- It supports passcode-based auth and wallet login flow.
- In multi-bot mode it renders manager views; in single-bot mode it renders the legacy bot view.
- Some auth/token state is in memory only.

## Bot and AI subsystems
The repo contains a signal and execution stack centered around:
- `src/modules/Watcher.ts`
- `src/ai/AISignalEngine.ts`
- `src/ai/sharedState.ts`
- `src/ai/TradeLogger.ts`
- `src/modules/SessionManager.ts`
- `src/modules/TelegramManager.ts`

The README documents the broader farm/trade/hedge strategies and daily budget reset behavior.

## Scripts
From `package.json`:
- `npm start` → `tsx src/bot.ts`
- `npm run build` → bundle appkit, compile TS, copy dashboard assets into `dist/`
- `npm run start:prod` → `node dist/bot.js`
- `npm test` → `vitest --run`

## Safe config sources
Use these as reference, not as secrets:
- `.env.example`
- `bot-configs.json`
- `README.md`

## Avoid documenting
- real API keys or passcodes
- generated trade logs
- mutable runtime state files like `bot_state*.json` and `trades*.json`
- session tokens or in-memory auth data
