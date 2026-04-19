# Multi-Bot Manager Setup Guide

## Overview

The APEX trading bot now supports running multiple bots simultaneously across different exchanges (SoDEX, Dango, Decibel). Each bot operates independently with isolated state, configuration, and trade logs.

## Quick Start

### 1. Configuration File

The system uses `bot-configs.json` to define multiple bots. A default file with 3 bots is created automatically on first run:

```json
{
  "version": 1,
  "bots": [
    {
      "id": "sodex-bot",
      "name": "SoDEX Bot",
      "exchange": "sodex",
      "symbol": "BTC-USD",
      "credentialKey": "SODEX",
      "tradeLogPath": "./trades-sodex.json",
      "autoStart": false,
      "mode": "farm",
      "orderSizeMin": 0.003,
      "orderSizeMax": 0.005,
      "tags": ["TWAP", "Farm"]
    }
    // ... more bots
  ]
}
```

### 2. Environment Variables

Each bot uses a credential key prefix to read its credentials from `.env`:

**For SoDEX bot (credentialKey: "SODEX"):**
```bash
SODEX_API_KEY=your_api_key
SODEX_API_SECRET=your_api_secret
SODEX_SUBACCOUNT=your_subaccount
```

**For Decibel bot (credentialKey: "DECIBELS"):**
```bash
DECIBELS_PRIVATE_KEY=your_private_key
DECIBELS_NODE_API_KEY=your_node_key
DECIBELS_SUBACCOUNT=your_subaccount
DECIBELS_GAS_STATION_API_KEY=your_gas_key
```

**For Dango bot (credentialKey: "DANGO"):**
```bash
DANGO_PRIVATE_KEY=your_private_key
DANGO_USER_ADDRESS=your_address
DANGO_NETWORK=mainnet
```

### 3. Starting the System

```bash
npm start
```

The system will:
1. Load bot configurations from `bot-configs.json`
2. Create a bot instance for each config
3. Auto-start bots with `autoStart: true`
4. Launch the Manager Dashboard on port 3000

### 4. Dashboard Access

Open http://localhost:3000 to access the Manager Dashboard.

**Features:**
- View all bots at a glance
- See aggregated statistics (Total Volume, Active Bots, Fees, PnL)
- Filter bots by status (All/Active/Inactive)
- Start/Stop individual bots
- View detailed metrics per bot
- Access individual bot detail pages

## API Endpoints

### Manager Endpoints

- `GET /api/bots` - List all bots
- `GET /api/bots/stats` - Aggregated statistics
- `POST /api/bots/:id/start` - Start a bot
- `POST /api/bots/:id/stop` - Stop a bot
- `POST /api/bots/:id/close` - Force close position

### Per-Bot Data Endpoints

- `GET /api/bots/:id/pnl` - Bot PnL data
- `GET /api/bots/:id/trades` - Bot trade history
- `GET /api/bots/:id/events` - Bot event log
- `GET /api/bots/:id/position` - Current position
- `GET /api/bots/:id/config` - Bot configuration
- `POST /api/bots/:id/config` - Update configuration
- `DELETE /api/bots/:id/config` - Reset to defaults

## Configuration Management

### Adding a New Bot

1. Edit `bot-configs.json`
2. Add a new bot configuration:
```json
{
  "id": "my-new-bot",
  "name": "My New Bot",
  "exchange": "sodex",
  "symbol": "ETH-USD",
  "credentialKey": "MYNEWBOT",
  "tradeLogPath": "./trades-mynewbot.json",
  "autoStart": false,
  "mode": "farm",
  "orderSizeMin": 0.01,
  "orderSizeMax": 0.02,
  "tags": ["ETH", "Farm"]
}
```
3. Add credentials to `.env`:
```bash
MYNEWBOT_API_KEY=...
MYNEWBOT_API_SECRET=...
MYNEWBOT_SUBACCOUNT=...
```
4. Restart the system

### Removing a Bot

1. Stop the bot via dashboard or API
2. Remove its entry from `bot-configs.json`
3. Restart the system

### Per-Bot Configuration Overrides

You can override trading parameters per bot via the API:

```bash
curl -X POST http://localhost:3000/api/bots/sodex-bot/config \
  -H "Content-Type: application/json" \
  -d '{
    "FARM_TP_USD": 2.5,
    "FARM_SL_PERCENT": 0.02,
    "ORDER_SIZE_MIN": 0.004
  }'
```

Changes are persisted to `bot-configs.json` and survive restarts.

## Backward Compatibility

If `bot-configs.json` doesn't exist, the system runs in **single-bot mode** using the original environment variables:

```bash
EXCHANGE=decibel
SYMBOL=BTC-USD
DECIBELS_PRIVATE_KEY=...
# etc.
```

This ensures existing setups continue to work without changes.

## Telegram Integration

Telegram commands work with the **first bot** in multi-bot mode for backward compatibility:

- `/start_bot` - Start first bot
- `/stop_bot` - Stop first bot
- `/status` - Show first bot status
- `/check` - Check first bot position

For full multi-bot control, use the dashboard.

## Trade Logs

Each bot maintains its own trade log file specified in `tradeLogPath`:

- `./trades-sodex.json` - SoDEX bot trades
- `./trades-decibel.json` - Decibel bot trades
- `./trades-dango.json` - Dango bot trades

Logs are completely isolated and never mixed.

## State Isolation

Each bot has:
- **Independent state** - PnL, volume, fees tracked separately
- **Own SessionManager** - Independent max loss limits
- **Own Watcher** - Separate trading loops
- **Own TradeLogger** - Isolated trade history

Bots never interfere with each other.

## Troubleshooting

### Bot fails to start

Check credentials in `.env` match the `credentialKey` in bot config:
```bash
# For bot with credentialKey: "SODEX"
SODEX_API_KEY=...
SODEX_API_SECRET=...
SODEX_SUBACCOUNT=...
```

### Dashboard shows 0 bots

Verify `bot-configs.json` exists and contains valid configurations. Check logs for validation errors.

### Bot crashes immediately

Check exchange-specific requirements:
- **SoDEX**: Requires API key, secret, and subaccount
- **Decibel**: Requires private key; subaccount optional
- **Dango**: Requires private key and user address

## Architecture

```
bot.ts (entry point)
  ├─ loadBotConfigs() → BotConfig[]
  ├─ BotManager
  │   ├─ BotInstance (sodex-bot)
  │   │   ├─ Watcher
  │   │   ├─ SessionManager
  │   │   ├─ TradeLogger
  │   │   └─ BotSharedState
  │   ├─ BotInstance (decibel-bot)
  │   └─ BotInstance (dango-bot)
  └─ DashboardServer
      ├─ Manager Dashboard (/)
      ├─ Bot Detail Pages (/bots/:id)
      └─ API Routes (/api/bots/*)
```

## Next Steps

1. Configure your bot credentials in `.env`
2. Customize `bot-configs.json` for your needs
3. Start the system with `npm start`
4. Access the dashboard at http://localhost:3000
5. Monitor and control your bots!

For questions or issues, check the logs or refer to the main README.
