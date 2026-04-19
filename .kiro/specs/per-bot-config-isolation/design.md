# Per-Bot Config Isolation Bugfix Design

## Overview

Khi chạy multi-bot, `ConfigStore.applyOverrides()` mutate trực tiếp global `config` object (import từ `src/config.ts`). Vì tất cả `Watcher` instance đều đọc cùng object này, bot khởi tạo sau sẽ ghi đè config của bot trước — dẫn đến mọi bot đọc config của bot cuối cùng gọi `applyOverrides()`.

Fix approach: thay vì mutate global `config`, mỗi `Watcher` nhận một `ConfigStoreInterface` riêng và đọc config qua `this._cfg` (getter trả về `configStore.getEffective()`). `ConfigStore.applyOverrides()` và `resetToDefaults()` bỏ phần mutate global object. `BotInstance` truyền `this.configStore` vào `Watcher` constructor.

## Glossary

- **Bug_Condition (C)**: Điều kiện kích hoạt bug — khi hai hoặc nhiều bot instance cùng gọi `applyOverrides()`, khiến global `config` bị ghi đè và `Watcher` đọc sai config
- **Property (P)**: Hành vi đúng — mỗi `Watcher` instance luôn đọc config của chính bot đó, không bị ảnh hưởng bởi `applyOverrides()` của bot khác
- **Preservation**: Hành vi single-bot và các API dashboard hiện tại phải tiếp tục hoạt động đúng sau fix
- **`config`**: Global config object export từ `src/config.ts` — hiện tại bị mutate bởi `ConfigStore.applyOverrides()`
- **`ConfigStore`**: Class trong `src/config/ConfigStore.ts` quản lý overrides per-instance; hiện tại vẫn mutate global `config` sau khi merge
- **`ConfigStoreInterface`**: Interface định nghĩa `getEffective()`, `applyOverrides()`, `resetToDefaults()`, `loadFromDisk()`
- **`Watcher`**: Class trong `src/modules/Watcher.ts` — vòng lặp chính của bot, đọc `config.XYZ` trực tiếp ở nhiều chỗ
- **`BotInstance`**: Class trong `src/bot/BotInstance.ts` — wrapper lifecycle của một bot, sở hữu `ConfigStore` riêng
- **`_cfg`**: Getter sẽ thêm vào `Watcher` — trả về `this._configStore ? this._configStore.getEffective() : config`

## Bug Details

### Bug Condition

Bug xảy ra khi hai hoặc nhiều `BotInstance` được khởi tạo và mỗi instance gọi `configStore.applyOverrides()` với giá trị riêng. `applyOverrides()` hiện tại mutate global `config` object sau khi merge, nên bot khởi tạo sau ghi đè toàn bộ các key overridable trên global `config`. Mọi `Watcher` instance đọc `config.FARM_MIN_HOLD_SECS` (và các key khác) đều nhận giá trị của bot cuối cùng gọi `applyOverrides()`.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input = { botCount: number, overridesPerBot: PartialOverride[] }
  OUTPUT: boolean

  RETURN input.botCount >= 2
         AND input.overridesPerBot có ít nhất 2 phần tử với giá trị khác nhau
             cho cùng một key (ví dụ: FARM_MIN_HOLD_SECS)
         AND Watcher của bot[0] đọc config.FARM_MIN_HOLD_SECS
             trả về giá trị của bot[1] thay vì bot[0]
END FUNCTION
```

### Examples

- **SoDEX bot** (farmMinHoldSecs=120) khởi tạo trước, gọi `applyOverrides({ FARM_MIN_HOLD_SECS: 120 })` → global `config.FARM_MIN_HOLD_SECS = 120`
- **Decibel bot** (farmMinHoldSecs=30) khởi tạo sau, gọi `applyOverrides({ FARM_MIN_HOLD_SECS: 30 })` → global `config.FARM_MIN_HOLD_SECS = 30` (ghi đè)
- SoDEX `Watcher` đọc `config.FARM_MIN_HOLD_SECS` → nhận `30` thay vì `120` → `farmHoldUntil` set đúng nhưng hold check dùng sai giá trị → FARM TIME EXIT sau 3–5 giây
- **Edge case**: Single-bot mode — chỉ một bot, không có race condition, hành vi không đổi

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Single-bot mode (không truyền `configStore` vào `Watcher`) vẫn fallback về global `config` như cũ
- Dashboard API cập nhật config override cho một bot cụ thể chỉ ảnh hưởng bot đó
- `ConfigStore.resetToDefaults()` reset về base config values cho bot đó, không ảnh hưởng bot khác
- `ConfigStore.loadFromDisk()` và `saveToDisk()` không thay đổi logic
- Tất cả exit conditions (`FARM_TP_USD`, `FARM_EARLY_EXIT_SECS`, `FARM_EARLY_EXIT_PNL`, v.v.) vẫn được evaluate đúng dựa trên config của từng bot

**Scope:**
Mọi input không liên quan đến multi-bot `applyOverrides()` race condition phải hoàn toàn không bị ảnh hưởng. Bao gồm:
- Single-bot operation
- Dashboard config update cho từng bot riêng lẻ
- `resetToDefaults()` và `loadFromDisk()` operations
- Tất cả trading logic trong `Watcher` (entry, exit, cooldown, position sizing)

## Hypothesized Root Cause

Dựa trên phân tích code, root cause chính xác là:

1. **`ConfigStore.applyOverrides()` mutate global object**: Sau khi merge patch vào `this.overrides`, method này loop qua `OVERRIDABLE_KEYS` và ghi trực tiếp lên `(config as Record<string, unknown>)[key] = effective[key]`. Đây là dòng gây ra bug.

2. **`ConfigStore.resetToDefaults()` cũng mutate global object**: Tương tự, restore `this.base[key]` lên global `config` — có thể ghi đè config của bot khác đang chạy.

3. **`Watcher` đọc global `config` trực tiếp**: Toàn bộ `Watcher.ts` import và đọc `config.XYZ` — không có cơ chế nào để inject config per-instance.

4. **`BotInstance` không truyền `configStore` vào `Watcher`**: Constructor của `BotInstance` tạo `this.configStore` nhưng không pass nó vào `Watcher` constructor — `Watcher` không biết đến `configStore` của bot.

## Correctness Properties

Property 1: Bug Condition - Config Isolation Between Bot Instances

_For any_ scenario where two or more `BotInstance` objects are created with different override values for the same config key (e.g., `FARM_MIN_HOLD_SECS`), the fixed `Watcher` SHALL read config values exclusively from its own `ConfigStoreInterface.getEffective()`, returning the correct per-bot value regardless of what other bots' `applyOverrides()` calls have done to the global `config` object.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Single-Bot and Existing Behavior Unchanged

_For any_ input where the bug condition does NOT hold (single-bot mode, or `Watcher` constructed without a `configStore`), the fixed code SHALL produce exactly the same behavior as the original code — reading from global `config` as before, preserving all existing single-bot functionality including config overrides, resets, and disk persistence.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

Assuming root cause analysis là đúng:

**File 1**: `src/config/ConfigStore.ts`

**Function**: `applyOverrides()` và `resetToDefaults()`

**Specific Changes**:
1. **Bỏ mutation global `config` trong `applyOverrides()`**: Xóa block `for (const key of OVERRIDABLE_KEYS) { (config as Record<string, unknown>)[key] = effective[key]; }` — chỉ lưu vào `this.overrides`, không đụng global object.
2. **Bỏ mutation global `config` trong `resetToDefaults()`**: Xóa block `for (const key of OVERRIDABLE_KEYS) { (config as Record<string, unknown>)[key] = this.base[key]; }` — chỉ clear `this.overrides`.
3. **Giữ nguyên `saveToDisk()`, `loadFromDisk()`, `getEffective()`**: Không thay đổi.

**File 2**: `src/modules/Watcher.ts`

**Function**: Constructor và tất cả chỗ đọc `config.XYZ`

**Specific Changes**:
1. **Thêm optional param `configStore?: ConfigStoreInterface` vào constructor**: Lưu vào `private _configStore?: ConfigStoreInterface`.
2. **Thêm getter `_cfg`**: 
   ```typescript
   private get _cfg() {
     return this._configStore ? this._configStore.getEffective() : config;
   }
   ```
3. **Thay tất cả `config.XYZ` bằng `this._cfg.XYZ`** trong toàn bộ `Watcher.ts`: Bao gồm `_computeLoopDelay`, `_handlePending`, `_handleInPosition`, `_evaluateExitConditions`, `_handleIdle`, `_handleExiting`, và các method khác.
4. **Giữ nguyên import `config`**: Vẫn cần cho fallback khi `_configStore` là undefined.

**File 3**: `src/bot/BotInstance.ts`

**Function**: Constructor

**Specific Changes**:
1. **Truyền `this.configStore` vào `Watcher` constructor**: Thay `new Watcher(adapter, config.symbol, telegram, this.sessionManager, this.state)` thành `new Watcher(adapter, config.symbol, telegram, this.sessionManager, this.state, this.configStore)`.

## Testing Strategy

### Validation Approach

Testing theo hai phase: trước tiên surface counterexample chứng minh bug trên code chưa fix, sau đó verify fix hoạt động đúng và không gây regression.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexample chứng minh bug TRƯỚC khi implement fix. Confirm root cause analysis.

**Test Plan**: Tạo hai `ConfigStore` instance với `FARM_MIN_HOLD_SECS` khác nhau, gọi `applyOverrides()` lần lượt, sau đó kiểm tra global `config.FARM_MIN_HOLD_SECS` — sẽ thấy giá trị của instance thứ hai ghi đè instance đầu. Chạy trên code CHƯA FIX để observe failure.

**Test Cases**:
1. **Two-bot override collision**: Tạo `store1.applyOverrides({ FARM_MIN_HOLD_SECS: 120 })` rồi `store2.applyOverrides({ FARM_MIN_HOLD_SECS: 30 })` — assert `store1.getEffective().FARM_MIN_HOLD_SECS === 120` (sẽ fail trên unfixed code vì global bị ghi đè)
2. **Watcher reads wrong config**: Tạo `Watcher` với `store1`, sau đó `store2.applyOverrides()` — assert `Watcher._cfg.FARM_MIN_HOLD_SECS` vẫn là 120 (sẽ fail vì Watcher đọc global)
3. **Reset collision**: `store1.applyOverrides({ FARM_MIN_HOLD_SECS: 120 })`, `store2.resetToDefaults()` — assert `store1.getEffective().FARM_MIN_HOLD_SECS === 120` (sẽ fail vì reset ghi đè global)
4. **Single-bot baseline**: Một `ConfigStore` duy nhất — assert behavior không đổi (phải pass cả trước và sau fix)

**Expected Counterexamples**:
- `store1.getEffective().FARM_MIN_HOLD_SECS` trả về `30` thay vì `120` sau khi `store2.applyOverrides()` chạy
- Possible causes: global mutation trong `applyOverrides()`, `Watcher` không có reference đến per-instance config

### Fix Checking

**Goal**: Verify rằng với mọi input có bug condition, fixed code trả về đúng per-bot config.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := watcher_fixed._cfg.FARM_MIN_HOLD_SECS
  ASSERT result === input.overridesPerBot[0].FARM_MIN_HOLD_SECS
         (không bị ảnh hưởng bởi overridesPerBot[1])
END FOR
```

### Preservation Checking

**Goal**: Verify rằng với mọi input không có bug condition, fixed code cho kết quả giống original.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT configStore_original.getEffective() = configStore_fixed.getEffective()
  ASSERT watcher_without_configStore reads global config as before
END FOR
```

**Testing Approach**: Property-based testing phù hợp cho preservation checking vì:
- Generate nhiều test case tự động với random override combinations
- Catch edge case mà manual test bỏ sót
- Đảm bảo single-bot behavior không đổi trên toàn bộ input domain

**Test Cases**:
1. **Single-bot preservation**: `Watcher` không có `configStore` vẫn đọc global `config` đúng như trước
2. **`getEffective()` preservation**: Sau fix, `getEffective()` vẫn trả về `{ ...base, ...overrides }` đúng
3. **`loadFromDisk()` preservation**: Load từ disk vẫn populate `this.overrides` đúng, không mutate global
4. **Dashboard API preservation**: `applyOverrides()` cho bot A không ảnh hưởng `getEffective()` của bot B

### Unit Tests

- Test `ConfigStore.applyOverrides()` không còn mutate global `config` sau fix
- Test `ConfigStore.resetToDefaults()` không còn mutate global `config` sau fix
- Test `Watcher._cfg` getter trả về `configStore.getEffective()` khi có `configStore`, fallback về `config` khi không có
- Test hai `ConfigStore` instance với overrides khác nhau — `getEffective()` của mỗi instance độc lập

### Property-Based Tests

- Generate random `PartialOverride` cho hai bot, assert `store1.getEffective()` không bị ảnh hưởng bởi `store2.applyOverrides()`
- Generate random config states, assert `Watcher` với `configStore` luôn đọc đúng per-bot values
- Test rằng với mọi sequence `applyOverrides()` / `resetToDefaults()` từ nhiều stores, mỗi store vẫn trả về đúng effective config của nó

### Integration Tests

- Khởi tạo hai `BotInstance` với `FARM_MIN_HOLD_SECS` khác nhau, assert mỗi `Watcher` đọc đúng giá trị của bot mình
- Test full lifecycle: start bot A, start bot B, update config bot A qua dashboard API, assert bot B không bị ảnh hưởng
- Test `resetToDefaults()` trên bot A không reset config của bot B
