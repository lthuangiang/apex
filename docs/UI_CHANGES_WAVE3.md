# UI Changes for Wave 3 Intelligence Mode

## 📋 Bot Creation/Edit Form Updates

### Current UI (Wave 2):
```
┌─────────────────────────────────────────┐
│ Create Bot                              │
├─────────────────────────────────────────┤
│ Bot Name: [___________________]         │
│ Exchange: [SoDEX ▼]                     │
│ Symbol:   [BTC-USD ▼]                   │
│                                         │
│ Trading Mode:                           │
│   ◉ Farm Mode                           │
│   ○ Trade Mode                          │
│                                         │
│ [Cancel] [Create Bot]                   │
└─────────────────────────────────────────┘
```

### New UI (Wave 3):
```
┌─────────────────────────────────────────┐
│ Create Bot                              │
├─────────────────────────────────────────┤
│ Bot Name: [___________________]         │
│ Exchange: [SoDEX ▼]                     │
│ Symbol:   [BTC-USD ▼]                   │
│                                         │
│ 🧠 Intelligence Mode:                   │
│   ◉ Auto (Recommended) 🌟               │
│       ℹ️  Engine controls strategy       │
│   ○ Manual                              │
│       ℹ️  You choose Farm/Trade          │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ Manual Mode Settings:               │ │
│ │ (Only if Manual selected)           │ │
│ │                                     │ │
│ │ Trading Mode:                       │ │
│ │   ◉ Farm Mode                       │ │
│ │   ○ Trade Mode                      │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Cancel] [Create Bot]                   │
└─────────────────────────────────────────┘
```

## 📊 Bot Dashboard Changes

### 1. Bot Card Header - Intelligence Badge

**Current:**
```
┌──────────────────────────────────────┐
│ 🤖 SoDEX Brave         [FARM]  🟢   │
│ BTC-USD                              │
└──────────────────────────────────────┘
```

**New (Auto Mode):**
```
┌──────────────────────────────────────┐
│ 🤖 SoDEX Brave    🧠 AUTO → FARM 🟢 │
│ BTC-USD            ↳ choppy_neutral  │
└──────────────────────────────────────┘
```

**New (Manual Mode):**
```
┌──────────────────────────────────────┐
│ 🤖 SoDEX Brave         [FARM]  🟢   │
│ BTC-USD           💡 Suggests: TRADE │
└──────────────────────────────────────┘
```

### 2. New "Intelligence Panel" on Bot Detail Page

```
┌────────────────────────────────────────────────┐
│ 🧠 Market Intelligence                         │
├────────────────────────────────────────────────┤
│ Mode: 🟢 AUTO                  [Switch to ▼]  │
│                                                │
│ Current Regime:     CHOPPY_NEUTRAL             │
│ Confidence:         60%                        │
│                                                │
│ Conviction:                                    │
│   Bull:    ▓░░░░░░░░░  0%                     │
│   Bear:    ▓▓▓▓▓▓▓▓▓░  85%                    │
│   Neutral: ▓▓▓▓▓▓▓▓▓░  87%                    │
│                                                │
│ Active Strategy:    FARM                       │
│ Reason: "Choppy market — no clear direction"  │
│                                                │
│ Position Sizing:                               │
│   Base: 1.02x | Max Leverage: 2.7x            │
│                                                │
│ Risk Level: 🟢 LOW                             │
│                                                │
│ Signals:                                       │
│   F&G:         15 (Extreme Fear)               │
│   ETF Flow:    neutral                         │
│   Open Int:    $44.09B                         │
│   Funding:     +0.62%                          │
│   Stablecoin:  -$0.39B                         │
│   Macro:       ✅ Clear                         │
│                                                │
│ ⚡ Last Update: 2s ago (auto-refresh)          │
└────────────────────────────────────────────────┘
```

### 3. Activity Log Updates

**Show auto-switch events:**
```
┌────────────────────────────────────────────────┐
│ Recent Activity                                │
├────────────────────────────────────────────────┤
│ 🔄 02:53:30 AUTO-SWITCH: farm → trade          │
│    Regime: bull_momentum (85%)                 │
│    Reason: Strong directional edge detected    │
│                                                │
│ 🛑 02:48:15 STANDBY: Trade blocked             │
│    Reason: Market overheated (funding 1.8%)    │
│                                                │
│ 📈 02:45:10 Trade executed (LONG)              │
│    Entry: $59,950 | Size: 0.0041 BTC           │
└────────────────────────────────────────────────┘
```

## ⚙️ Settings Tab Update

**Add Intelligence Mode toggle:**
```
┌────────────────────────────────────────────────┐
│ Bot Settings                                   │
├────────────────────────────────────────────────┤
│ 🧠 Intelligence Mode                           │
│                                                │
│   [◉] Auto (Recommended)                       │
│        Let AI choose strategy based on market  │
│                                                │
│   [ ] Manual                                   │
│        You control strategy, AI only suggests  │
│                                                │
│ ┌──────────────────────────────────────────┐  │
│ │ Manual Mode Strategy:                    │  │
│ │ (Active only when Manual selected)       │  │
│ │                                          │  │
│ │ ◉ Farm Mode  ○ Trade Mode                │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ [Save Changes]                                 │
└────────────────────────────────────────────────┘
```

## 🎨 Visual Design Tokens

### Intelligence Mode Badges:
```
🧠 AUTO     → Green badge (trust the AI)
🔧 MANUAL   → Blue badge (user control)
💡 SUGGEST  → Yellow badge (AI suggests, user decides)
```

### Strategy Indicators:
```
FARM      → 🚜 Green
TRADE     → 📈 Blue  
STANDBY   → 🛑 Red
HEDGE     → ⚖️ Purple
```

### Regime Indicators:
```
bull_momentum    → 🟢 Green + ↗️
bear_momentum    → 🔴 Red + ↘️
accumulation     → 🟡 Yellow + 📥
distribution     → 🟠 Orange + 📤
choppy_neutral   → ⚪ Gray + 〰️
pre_breakout     → 🔵 Blue + 💥
overheated       → 🔥 Red + 🌡️
capitulation     → 💔 Dark Red + 📉
```

## 📱 Mobile Responsive

**Compact Intelligence Widget:**
```
┌─────────────────────────┐
│ 🧠 AUTO → FARM          │
│ choppy_neutral (60%)    │
│ Risk: 🟢 LOW            │
│ [Details ▼]             │
└─────────────────────────┘
```

## 🔔 Notifications

**Show real-time strategy switches:**
```
🔄 Strategy Auto-Switch
   FARM → TRADE
   Reason: Bull momentum detected
   [View Details]
```

## 📊 Analytics Tab Addition

**New Chart: Strategy Distribution Over Time**
```
┌────────────────────────────────────────────┐
│ Strategy Timeline (Last 24h)              │
├────────────────────────────────────────────┤
│                                           │
│ FARM  ████████░░░░░░░░ 60%               │
│ TRADE ░░░░░░░░████░░░░ 30%               │
│ STANDBY ░░░░░░░░░░██░░ 10%               │
│                                           │
│ Auto-switches: 12                         │
│ Avg regime duration: 1.8h                 │
└────────────────────────────────────────────┘
```

## 🎯 Key UI Principles

1. **Default to Auto** - Make "Auto" the recommended option
2. **Show AI Reasoning** - Always display why engine made a decision
3. **Manual Override** - Allow user to switch to Manual anytime
4. **Real-time Updates** - Intelligence panel updates every 5s
5. **Visual Clarity** - Use colors/icons to show active strategy
6. **Trust Building** - Show regime confidence % to build trust in AI

---

## 🚀 Implementation Priority

**Phase 1 (MVP):**
- [x] Add `intelligenceMode` field to bot config
- [ ] Bot creation form with Auto/Manual toggle
- [ ] Badge on bot card showing current strategy
- [ ] Basic intelligence panel on bot detail

**Phase 2 (Enhanced):**
- [ ] Activity log for auto-switch events
- [ ] Settings tab to change mode
- [ ] Mobile-responsive widgets
- [ ] Real-time SSE updates

**Phase 3 (Advanced):**
- [ ] Strategy timeline chart
- [ ] Performance comparison (Auto vs Manual)
- [ ] AI explanation tooltips
- [ ] Advanced regime visualization
