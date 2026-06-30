# Wave 3 Intelligence Mode - Quick Setup Guide

## 🎯 How to Enable Auto-Switch

### Step 1: Update bot-configs.json

Add `intelligenceMode` field to your bot config:

```json
{
  "id": "my-bot",
  "name": "My Smart Bot",
  "exchange": "sodex",
  "symbol": "BTC-USD",
  "mode": "farm",
  
  "intelligenceMode": "auto",  // ← Add this!
  
  "orderSizeMin": 0.003,
  "orderSizeMax": 0.005,
  // ... rest of config
}
```

### Step 2: Restart Bot

```bash
npm start
```

### Step 3: Watch the Magic ✨

Bot console will show:
```
[Intelligence] Regime: BULL_MOMENTUM (85% confidence)
[Intelligence] Recommended Strategy: TRADE
🔄 AUTO-SWITCH: farm → trade
   Mode: AUTO (intelligenceMode enabled)
   Reason: Bull momentum detected — strong directional edge
   → Delegating to TRADE mode handler
```

---

## 📊 Mode Comparison

| intelligenceMode | Behavior | Console Output |
|-----------------|----------|----------------|
| `"auto"` | Engine controls strategy | `🔄 AUTO-SWITCH: farm → trade` |
| `"manual"` (default) | User controls, engine suggests | `💡 Suggestion: Switch to TRADE` |
| (not set) | Same as "manual" | Backward compatible |

---

## ✅ Example Configs

See `bot-configs.example-wave3.json` for full examples:
- Auto mode bot
- Manual mode bot

---

## 🎬 Demo Output

### Auto Mode:
```
[Intelligence] Analyzing market conditions...
[Intelligence] Regime: BULL_MOMENTUM (85%)
🔄 [Intelligence] AUTO-SWITCH: farm → trade
   Mode: AUTO
   → Bot now running TRADE mode

[5 min later, market changes]
[Intelligence] Regime: OVERHEATED
🛑 [Intelligence] STANDBY — refusing to trade
   → Bot stopped until conditions improve
```

### Manual Mode:
```
[Intelligence] Analyzing market conditions...
[Intelligence] Regime: BULL_MOMENTUM (85%)
💡 [Intelligence] Suggestion: Switch to TRADE mode
   Mode: MANUAL (user decides)
   → Bot continues FARM mode
```

---

## 🚀 Wave 3 Achievement Unlocked!

✅ Intelligence Engine **actually controls** strategy
✅ Not just console logs - **real behavior change**
✅ Backward compatible (defaults to manual)
✅ Production ready!
