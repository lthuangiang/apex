# Bot Start/Stop Improvements Bugfix Design

## Overview

Bốn lỗi nhỏ liên quan đến hành vi start/stop của bot cần được sửa:

1. `SessionManager` khởi tạo `maxLoss` mặc định là $50 thay vì $5 — quá cao, dễ gây mất vốn lớn trước khi bot tự dừng.
2. `Watcher` không reset các trường session khi bot được start lại — dữ liệu cũ từ session trước có thể ảnh hưởng đến logic trading.
3. Message Telegram khi start bot thiếu thông tin quan trọng: Account Balance, Max Fee Loss, symbol, thời gian bắt đầu.
4. Message Telegram khi stop bot không bao gồm thông tin cooldown hiện tại — người dùng không biết bot cần chờ bao lâu trước khi vào lệnh tiếp theo.

Chiến lược fix: thay đổi tối thiểu, có mục tiêu — không refactor logic trading.

## Glossary

- **Bug_Condition (C)**: Tập hợp các điều kiện kích hoạt lỗi — bao gồm cả bốn defect được mô tả ở trên
- **Property (P)**: Hành vi đúng mong muốn khi bug condition xảy ra
- **Preservation**: Các hành vi hiện tại phải tiếp tục hoạt động đúng sau khi fix
- **SessionManager**: Class trong `src/modules/SessionManager.ts` quản lý trạng thái session (isRunning, maxLoss, PnL)
- **Watcher**: Class trong `src/modules/Watcher.ts` chứa vòng lặp trading chính và các trường session
- **resetSession()**: Method mới cần thêm vào `Watcher` để reset toàn bộ trạng thái session
- **getCooldownInfo()**: Method mới cần thêm vào `Watcher` để expose thông tin cooldown hiện tại
- **cooldownUntil**: Timestamp (ms) đến khi bot không vào lệnh mới; `null` nếu không có cooldown

## Bug Details

### Bug Condition

Bốn defect độc lập, mỗi cái có bug condition riêng:

**Formal Specification:**
```
FUNCTION isBugCondition(context)
  INPUT: context = { action, watcherState, sessionManagerState }
  OUTPUT: boolean

  IF context.action = 'START_BOT'
    RETURN sessionManagerState.maxLoss = 50          // Defect 1: sai default
        OR watcherState.sessionStartBalance != null   // Defect 2: chưa reset
        OR watcherState.sessionCurrentPnl != 0        // Defect 2: chưa reset
        OR watcherState.cooldownUntil != null          // Defect 2: chưa reset
        OR telegramMessage DOES NOT CONTAIN 'Balance' // Defect 3: thiếu thông tin
  END IF

  IF context.action = 'STOP_BOT'
    RETURN watcherState.cooldownUntil != null
       AND telegramMessage DOES NOT CONTAIN 'cooldown' // Defect 4: thiếu cooldown info
  END IF

  RETURN false
END FUNCTION
```

### Examples

- **Defect 1**: `new SessionManager()` → `getState().maxLoss === 50` (expected: `5`)
- **Defect 2**: Bot chạy 1 session, stop, start lại → `sessionStartBalance` vẫn là giá trị cũ thay vì `null`
- **Defect 3**: Start bot → Telegram nhận `"🚀 Bot started. Session initialized."` — không có balance, không có symbol
- **Defect 4**: Bot stop khi `cooldownUntil = Date.now() + 120000` → Telegram nhận `"🛑 Bot stopped. Session terminated."` — không có thông tin 120s cooldown còn lại

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `set_max_loss` command sau khi start vẫn cập nhật `maxLoss` theo giá trị người dùng nhập
- Emergency stop khi đạt max loss vẫn hoạt động và gửi thông báo đúng
- Stop bot khi không có cooldown active không gây lỗi
- Start bot lần thứ hai khi session đang running vẫn bị từ chối

**Scope:**
Tất cả inputs không liên quan đến start/stop bot phải hoàn toàn không bị ảnh hưởng. Bao gồm:
- Logic trading trong `tick()` (signal, entry, exit, risk management)
- `forceClosePosition()` và `getDetailedStatus()`
- `status` và `check` Telegram commands
- Graceful shutdown handler (SIGTERM/SIGINT)

## Hypothesized Root Cause

1. **Hardcoded default value**: `SessionManager` constructor set `maxLoss: 50` — đơn giản là sai giá trị, cần đổi thành `5`.

2. **Thiếu reset method trong Watcher**: Khi `startSession()` được gọi trên `SessionManager`, `Watcher` không có cơ chế reset các trường của mình. Các trường như `sessionStartBalance`, `cooldownUntil`, `recentPnLs` được khởi tạo trong constructor nhưng không bao giờ được reset về initial state khi bot restart.

3. **start_bot handler không fetch balance**: Handler trong `bot.ts` gọi `sessionManager.startSession()` và gửi message cứng — không có lời gọi `adapter.get_balance()` hay tham chiếu đến `symbol`, `maxLoss`, hay timestamp.

4. **Watcher không expose cooldown info**: `cooldownUntil` là `private` field trong `Watcher`. `stop_bot` handler trong `bot.ts` không có cách nào đọc giá trị này để đưa vào message.

## Correctness Properties

Property 1: Bug Condition - Session Reset và Default Values

_For any_ lần start bot (gọi `start_bot` command), hệ thống fixed SHALL: (a) khởi tạo `maxLoss` mặc định là `5`, (b) reset toàn bộ trường session trong `Watcher` về initial state, và (c) gửi Telegram message chứa Account Balance, Max Fee Loss, symbol, và thời gian bắt đầu session.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Bug Condition - Cooldown Info trong Stop Message

_For any_ lần stop bot khi `cooldownUntil` đang active (tức là `cooldownUntil > Date.now()`), hệ thống fixed SHALL gửi Telegram message bao gồm số giây cooldown còn lại.

**Validates: Requirements 2.4**

Property 3: Preservation - Unchanged Behaviors

_For any_ input không phải start/stop bot (trading logic, set_max_loss, status check, force close, emergency stop), hệ thống fixed SHALL produce kết quả giống hệt code gốc, không có regression nào.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

## Fix Implementation

### Changes Required

**File 1**: `src/modules/SessionManager.ts`

**Change**: Đổi default `maxLoss` từ `50` sang `5`

```
// Before
maxLoss: 50, // Default $50 max loss

// After
maxLoss: 5, // Default $5 max loss
```

---

**File 2**: `src/modules/Watcher.ts`

**Change 1**: Thêm method `resetSession()` reset tất cả trường session về initial state:

```
FUNCTION resetSession()
  this.sessionStartBalance = null
  this.sessionCurrentPnl = 0
  this.sessionVolume = 0
  this.recentPnLs = []
  this.currentProfile = 'NORMAL'
  this.cooldownUntil = null
  this.lastTradeContext = null
END FUNCTION
```

**Change 2**: Thêm method `getCooldownInfo()` expose cooldown state:

```
FUNCTION getCooldownInfo()
  IF this.cooldownUntil IS null OR Date.now() >= this.cooldownUntil
    RETURN null
  END IF
  RETURN Math.floor((this.cooldownUntil - Date.now()) / 1000)  // seconds remaining
END FUNCTION
```

---

**File 3**: `src/bot.ts`

**Change 1**: `start_bot` handler — fetch balance, gọi `watcher.resetSession()`, gửi detailed message:

```
FUNCTION start_bot handler
  IF sessionManager.isRunning THEN return early
  
  balance = await adapter.get_balance()
  success = sessionManager.startSession()
  
  IF success
    watcher.resetSession()
    startTime = new Date().toLocaleString()
    maxLoss = sessionManager.getState().maxLoss
    
    message = "🚀 Bot started.\n"
            + "💰 Account Balance: `{balance}`\n"
            + "🛡️ Max Fee Loss: `{maxLoss}`\n"
            + "📈 Symbol: `{symbol}`\n"
            + "🕐 Session Start: `{startTime}`"
    
    await telegram.sendMessage(message)
    watcher.run()
  END IF
END FUNCTION
```

**Change 2**: `stop_bot` handler — đọc cooldown info, đưa vào message:

```
FUNCTION stop_bot handler
  IF NOT sessionManager.isRunning THEN return early
  
  sessionManager.stopSession()
  watcher.stop()
  
  cooldownSecs = watcher.getCooldownInfo()
  
  IF cooldownSecs IS NOT null
    cooldownText = "\n⏳ Cooldown active: `{cooldownSecs}s` remaining before next trade."
  ELSE
    cooldownText = ""
  END IF
  
  message = "🛑 Bot stopped. Session terminated." + cooldownText
  await telegram.sendMessage(message)
END FUNCTION
```

## Testing Strategy

### Validation Approach

Hai phase: (1) chạy tests trên code CHƯA fix để xác nhận bug và root cause, (2) chạy tests sau khi fix để verify correctness và preservation.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples trên unfixed code để xác nhận root cause analysis.

**Test Plan**: Instantiate các class với unfixed code, assert expected behavior, observe failures.

**Test Cases**:
1. **Default maxLoss Test**: `new SessionManager()` → assert `getState().maxLoss === 5` (sẽ fail: nhận `50`)
2. **Session Reset Test**: Tạo Watcher, set `sessionStartBalance = 100`, gọi `resetSession()` → assert `sessionStartBalance === null` (sẽ fail: method chưa tồn tại)
3. **Start Message Test**: Mock `adapter.get_balance()` trả về `42.5`, trigger `start_bot` → assert message chứa `"42.5"` (sẽ fail: message cứng không có balance)
4. **Stop Cooldown Test**: Set `watcher.cooldownUntil = Date.now() + 120000`, trigger `stop_bot` → assert message chứa `"120"` hoặc `"cooldown"` (sẽ fail: `getCooldownInfo()` chưa tồn tại)

**Expected Counterexamples**:
- `maxLoss` là `50` thay vì `5`
- `resetSession is not a function`
- Stop message không chứa cooldown info

### Fix Checking

**Goal**: Verify rằng sau khi fix, tất cả bug conditions đều được xử lý đúng.

**Pseudocode:**
```
FOR ALL context WHERE isBugCondition(context) DO
  result := fixedSystem(context)
  ASSERT expectedBehavior(result)
END FOR
```

### Preservation Checking

**Goal**: Verify rằng các inputs không liên quan đến bug condition vẫn cho kết quả giống code gốc.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalSystem(input) = fixedSystem(input)
END FOR
```

**Testing Approach**: Property-based testing phù hợp cho preservation checking vì:
- Tự động generate nhiều test cases trên input domain
- Bắt được edge cases mà manual tests bỏ sót
- Đảm bảo behavior không thay đổi cho tất cả non-buggy inputs

**Test Cases**:
1. **set_max_loss Preservation**: Gọi `setMaxLoss(25)` sau `startSession()` → verify `getState().maxLoss === 25` (không bị override bởi default mới)
2. **Emergency Stop Preservation**: `updatePnL(-6)` với `maxLoss = 5` → verify trả về `true` (emergency stop vẫn trigger)
3. **No Cooldown Stop**: `getCooldownInfo()` khi `cooldownUntil = null` → verify trả về `null`, stop message không bị lỗi
4. **Double Start Prevention**: Gọi `startSession()` hai lần → verify lần hai trả về `false`

### Unit Tests

- Test `SessionManager` constructor: `maxLoss` default là `5`
- Test `Watcher.resetSession()`: tất cả 7 trường về initial state
- Test `Watcher.getCooldownInfo()`: trả về seconds khi active, `null` khi không active hoặc đã hết
- Test `start_bot` handler: message chứa balance, maxLoss, symbol, timestamp
- Test `stop_bot` handler: message chứa cooldown seconds khi active; không lỗi khi không active

### Property-Based Tests

- Generate random `maxLoss` values qua `setMaxLoss()` → verify `getState().maxLoss` luôn bằng giá trị được set (không bị reset về default)
- Generate random Watcher states → verify `resetSession()` luôn produce cùng initial state bất kể state trước đó
- Generate random `cooldownUntil` timestamps → verify `getCooldownInfo()` luôn trả về giá trị hợp lệ (null hoặc số dương)

### Integration Tests

- Full start → trade → stop flow: verify session reset đúng khi start lại
- Start bot với balance thấp: verify message vẫn gửi đúng
- Stop bot ngay sau khi trade exit (cooldown active): verify cooldown info xuất hiện trong stop message
- Stop bot khi không có cooldown: verify message gửi bình thường không có cooldown text
