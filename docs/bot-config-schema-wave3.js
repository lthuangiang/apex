/**
 * Bot Config Schema - Wave 3 Update
 *
 * Added: intelligenceMode field for auto-strategy-switching
 */

// Example bot-configs.json with new field
{
  "version": 1,
  "bots": [
    {
      "id": "sodex-brave",
      "name": "SoDEX Brave",
      "exchange": "sodex",
      "symbol": "BTC-USD",

      // ══════════════════════════════════════════════════════════
      // WAVE 3: Intelligence Mode
      // ══════════════════════════════════════════════════════════
      "intelligenceMode": "auto",  // NEW FIELD!
      // Options:
      //   "manual" - User sets mode, engine only logs suggestions
      //   "auto"   - Engine controls mode (auto-switch enabled)
      //   "assist" - Engine suggests, user approves via dashboard

      "mode": "farm",  // Fallback/default mode when intelligenceMode="manual"
      // ══════════════════════════════════════════════════════════

      "orderSizeMin": 0.003,
      "orderSizeMax": 0.005,
      // ... rest of config
    }
  ]
}
