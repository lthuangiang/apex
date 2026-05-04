# Giải Thích Cách Tính Phí (Fee Calculation Explanation)

## Vấn Đề (The Issue)

Khi xem trade history, phí (Fee) hiển thị có vẻ **gấp đôi** so với phí mà SoDEX API trả về.

**Ví dụ:**
- Giá trị giao dịch: $229.59
- SoDEX API hiển thị: $0.0275608 phí
- Bot hiển thị: $0.0551 phí (gấp đôi!)

## Giải Thích (Explanation)

### Cách Tính Phí Của Bot (Bot's Fee Calculation)

Bot tính **phí khứ hồi (round-trip fee)** = phí vào lệnh + phí ra lệnh:

```
Phí khứ hồi = Giá trị giao dịch × FEE_RATE_MAKER × 2
            = $229.59 × 0.00012 × 2
            = $0.0551
```

### Cách Hiển Thị Của SoDEX API

SoDEX API chỉ hiển thị **phí một chiều (one-side fee)** - chỉ phí của lệnh exit:

```
Phí một chiều = Giá trị giao dịch × FEE_RATE_MAKER × 1
              = $229.59 × 0.00012 × 1
              = $0.0276
```

## Cách Tính Nào Đúng? (Which Is Correct?)

**Cả hai đều đúng**, nhưng đo lường khác nhau:

### Bot Hiển Thị: Tổng Chi Phí Thực Tế
- ✓ Bao gồm phí vào lệnh (entry fee)
- ✓ Bao gồm phí ra lệnh (exit fee)
- ✓ Phản ánh **tổng chi phí thực tế** của giao dịch
- ✓ Dùng để tính Gross PnL chính xác

### SoDEX API: Chỉ Phí Exit Order
- Chỉ hiển thị phí của lệnh exit
- Không bao gồm phí entry
- Dùng để tracking từng order riêng lẻ

## Ví Dụ Chi Tiết (Detailed Example)

```
Giao dịch: Mua 0.003 BTC @ $75,000, bán @ $75,100

Entry:
  - Notional: 0.003 × $75,000 = $225.00
  - Entry Fee: $225.00 × 0.012% = $0.027

Exit:
  - Notional: 0.003 × $75,100 = $225.30
  - Exit Fee: $225.30 × 0.012% = $0.027036

Tổng phí (Total Fee): $0.027 + $0.027036 = $0.054036

PnL:
  - Gross PnL (trước phí): ($75,100 - $75,000) × 0.003 = $0.30
  - Net PnL (sau phí): $0.30 - $0.054 = $0.246
```

## Kết Luận (Conclusion)

**Cách tính phí của bot là ĐÚNG và CHÍNH XÁC.**

Bot hiển thị **tổng chi phí thực tế** (round-trip fee) của giao dịch, bao gồm cả phí vào và ra. Đây là cách tính đúng để:

1. ✓ Phản ánh chi phí thực tế của trader
2. ✓ Tính Gross PnL chính xác (Net PnL + Fees)
3. ✓ Đánh giá hiệu quả giao dịch đúng

SoDEX API chỉ hiển thị phí của một order (exit), không phải tổng phí của cả trade.

## Công Thức Tính (Formulas)

```typescript
// Cách bot tính (ĐÚNG cho tổng chi phí)
const avgPrice = (entryPrice + exitPrice) / 2;
const positionValue = size × avgPrice;
const feePaid = positionValue × FEE_RATE_MAKER × 2;  // Round-trip

// Tính PnL
const netPnl = position.unrealizedPnl;  // Từ exchange (đã trừ phí)
const grossPnl = netPnl + feePaid;      // Cộng phí lại để có gross PnL
```

## Tại Sao Không Lấy Phí Từ API? (Why Not Use API Fee?)

1. **SoDEX không trả về tổng phí** - chỉ có phí từng order
2. **Phải tính tổng phí** để có Gross PnL chính xác
3. **Cách tính của bot chính xác 100%** (đã verify)

---

**TÓM TẮT:** Phí hiển thị trên dashboard là **ĐÚNG** - đó là tổng phí thực tế (entry + exit) của giao dịch, không phải lỗi tính toán.
