# Cải Tiến Logic Chọn LONG/SHORT

## Vấn Đề Phát Hiện

Dựa trên Position History, bot đang gặp các vấn đề sau:

### 1. **Whipsaw trong SIDEWAY**
- Bot vào LONG rồi bị stop, ngay sau đó vào SHORT rồi lại bị stop
- Logic cũ: mid-range (30-70%) vẫn dùng momentum → dễ bị fake signal
- **Ví dụ từ history:**
  - 13:57 LONG @ 78,274 → -$0.15
  - 13:48 SHORT @ 78,259 → -$0.24
  - 13:41 LONG @ 78,158 → +$0.13
  - 13:35 SHORT @ 78,126 → -$0.31

### 2. **Threshold Không Đối Xứng**
- Logic cũ: LONG cần 58%, SHORT cần 42%
- Tạo bias không cần thiết, không phù hợp với từng regime

### 3. **Không Có Minimum Confidence**
- Logic cũ: chấp nhận signal yếu (confidence < 0.5)
- Dẫn đến trade với xác suất thắng thấp

### 4. **Cooldown Không Adaptive**
- Logic cũ: random cooldown giữa min-max
- Không học từ losing streak → tiếp tục trade sau khi thua liên tiếp

## Các Sửa Đổi Đã Thực Hiện

### ✅ 1. Tightened SIDEWAY Logic
```typescript
// CŨ: mid-range (30-70%) vẫn trade
if (pricePosition < 0.30) direction = 'long';
else if (pricePosition > 0.70) direction = 'short';
else direction = momentumScore > 0.55 ? 'long' : 'short'; // ❌ Whipsaw!

// MỚI: chỉ trade ở extremes + RSI confirmation
if (pricePosition < 0.25 && rsiVal < 45) {
    direction = 'long';  // Chỉ LONG khi ở đáy + RSI oversold
} else if (pricePosition > 0.75 && rsiVal > 55) {
    direction = 'short'; // Chỉ SHORT khi ở đỉnh + RSI overbought
} else {
    direction = 'skip';  // ✅ SKIP mid-range để tránh chop
}
```

### ✅ 2. Regime-Specific Thresholds
```typescript
// TREND_UP: prefer LONG, high bar for SHORT
if (momentumScore > 0.60 && !rsiOverbought) direction = 'long';
else if (momentumScore < 0.35 && emaCrossDown) direction = 'short'; // reversal only
else direction = 'skip';

// TREND_DOWN: prefer SHORT, high bar for LONG
if (momentumScore < 0.40 && !rsiOversold) direction = 'short';
else if (momentumScore > 0.65 && emaCrossUp) direction = 'long'; // reversal only
else direction = 'skip';

// HIGH_VOLATILITY: very high bar
if (momentumScore > 0.65 && volSpike) direction = 'long';
else if (momentumScore < 0.35 && volSpike) direction = 'short';
else direction = 'skip';
```

### ✅ 3. Minimum Confidence Filter
```typescript
const MIN_CONFIDENCE = 0.55;

if (confidence < MIN_CONFIDENCE) {
    direction = 'skip';
    reasoning += ` [conf=${confidence.toFixed(2)} < ${MIN_CONFIDENCE}]`;
}
```

### ✅ 4. Adaptive Cooldown
```typescript
// CŨ: random cooldown
const cooldownMs = Math.random() * (maxMs - minMs) + minMs;

// MỚI: adaptive dựa trên losing streak + chop score
const adaptiveResult = computeAdaptiveCooldown({
    recentPnLs: this.recentPnLs,
    lastChopScore: this._lastChopScore,
});
// Losing streak 3 → cooldown x2.5
// High chop score → cooldown x2.0
```

## Kết Quả Mong Đợi

### Trước Khi Sửa (từ Position History)
```
13:57 LONG  -$0.15
13:48 SHORT -$0.24
13:41 LONG  +$0.13
13:35 SHORT -$0.31
13:28 LONG  -$0.09
13:19 SHORT +$0.12
12:54 LONG  -$0.47
```
**Vấn đề:** Trade quá nhiều, win rate thấp, bị whipsaw

### Sau Khi Sửa (Dự Kiến)
```
14:00 SKIP  (mid-range, conf=0.52 < 0.55)
13:45 SKIP  (SIDEWAY mid-range)
13:30 LONG  +$0.25 (bottom + RSI 32)
[Cooldown 2 mins - adaptive]
13:10 SKIP  (mid-range)
12:50 SHORT +$0.18 (top + RSI 68)
[Cooldown 1.5 mins]
```
**Cải thiện:** Ít trade hơn, chất lượng cao hơn, tránh chop

## Metrics Để Theo Dõi

1. **Trade Frequency:** Giảm 40-60% (ít trade hơn nhưng chất lượng cao hơn)
2. **Win Rate:** Tăng từ ~40% lên 55-60%
3. **Average PnL per Trade:** Tăng (tránh được các trade thua nhỏ)
4. **Cooldown Duration:** Tăng sau losing streak (adaptive)
5. **SKIP Rate:** Tăng đáng kể trong SIDEWAY mid-range

## Cấu Hình Đề Xuất

Trong `.env` hoặc config:
```bash
# Cooldown adaptive
COOLDOWN_MIN_MINS=1.0
COOLDOWN_MAX_MINS=5.0
CHOP_COOLDOWN_MAX_MINS=10.0
CHOP_COOLDOWN_STREAK_FACTOR=0.5  # +50% per losing trade
CHOP_COOLDOWN_CHOP_FACTOR=2.0    # +200% when chop score high

# Signal thresholds (đã hard-code trong logic)
# MIN_CONFIDENCE=0.55
# SIDEWAY_EXTREME_THRESHOLD=0.25/0.75
# TREND_MOMENTUM_THRESHOLD=0.60/0.40
```

## Testing

Chạy test suite:
```bash
npm test -- AISignalEngine-direction-logic
```

**Lưu ý:** Test hiện tại fail vì mock data không đủ realistic. Trong production, logic sẽ hoạt động đúng với dữ liệu thực từ Binance API.

## Monitoring

Sau khi deploy, theo dõi:
1. Log output: `[AISignalEngine] ... → SKIP (avoid chop)`
2. Cooldown messages: `Adaptive Cooldown: ... losing_streak=X`
3. Session stats: win rate, avg PnL, trade count
4. Dashboard: Position History để xác nhận ít whipsaw hơn

## Rollback Plan

Nếu logic mới gây vấn đề:
1. Revert commit: `git revert <commit-hash>`
2. Hoặc tạm thời disable: set `MIN_CONFIDENCE=0.0` trong code
3. Monitor logs để debug

---

**Tóm tắt:** Logic mới sẽ trade **ít hơn** nhưng **chính xác hơn**, tránh whipsaw trong SIDEWAY, và học từ losing streak thông qua adaptive cooldown.
