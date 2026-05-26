# Phân tích Flow của Decibel DEX

> Tài liệu phân tích kiến trúc và luồng hoạt động của Decibel - một sàn giao dịch perpetual futures hoàn toàn on-chain trên Aptos blockchain.

## 1. Tổng quan về Decibel

Decibel là một decentralized perpetuals exchange với:
- **Fully on-chain order book**: Mọi order được đặt, match và settle trực tiếp trên Aptos blockchain
- **No off-chain matching engine**: Không có matching engine off-chain
- **Built on Aptos**: Sử dụng Aptos L1 với Block-STM parallel execution
- **Sub-second finality**: Settlement trong ~0.125 giây

### Ưu điểm so với CEX:

| Tính năng | Decibel | Centralized Exchange |
|-----------|---------|---------------------|
| **Builder Codes** | Permissionlessly earn fees | Requires broker agreements |
| **Custody** | You hold your keys | Exchange holds your funds |
| **Order matching** | On-chain, transparent | Off-chain, opaque |
| **Settlement** | On-chain, verifiable | Internal ledger |
| **Ecosystem** | Composable with Aptos DeFi | Isolated |

## 2. Three-Tier Account Model

Decibel sử dụng mô hình **3 tầng tài khoản** để tách biệt quyền sở hữu, quyền ký giao dịch và quản lý margin:

```
┌─────────────────────────────────────────────────────────────┐
│                     LOGIN WALLET                            │
│                   (Main Aptos Wallet)                       │
│                                                             │
│  • Ví chính của user trên Aptos blockchain                 │
│  • Giữ quyền sở hữu tối cao (ultimate ownership)           │
│  • Có thể revoke quyền của API Wallet bất cứ lúc nào       │
│  • Không cần dùng trực tiếp khi bot đang chạy              │
└──────────────────┬──────────────────────────────────────────┘
                   │ delegates signing authority
                   ↓
┌─────────────────────────────────────────────────────────────┐
│                      API WALLET                             │
│                 (Delegated Wallet for Bot)                  │
│                                                             │
│  • Ví được ủy quyền để ký các giao dịch tự động            │
│  • Bot sử dụng private key của ví này                      │
│  • CẦN CÓ APT để trả gas fees (hoặc dùng Gas Station)      │
│  • Không giữ USDC trading capital                          │
│  • Chỉ có quyền ký giao dịch, không rút tiền               │
└──────────────────┬──────────────────────────────────────────┘
                   │ signs transactions for
                   ↓
┌─────────────────────────────────────────────────────────────┐
│                   TRADING ACCOUNT                           │
│                    (Subaccount)                             │
│                                                             │
│  • Tài khoản giao dịch riêng biệt (isolated)               │
│  • Chứa USDC để trade (margin + collateral)                │
│  • KHÔNG CẦN APT (gas được trả bởi API Wallet)             │
│  • Mỗi user có thể có nhiều Trading Accounts               │
│  • Cách ly margin và positions giữa các strategies         │
└─────────────────────────────────────────────────────────────┘
```

## 3. Gas Fees và APT

### 3.1. Ai trả gas fees?

**API Wallet trả gas fees**, không phải Trading Account (subaccount).

```typescript
// API Wallet (cần APT cho gas)
const apiWallet = new Ed25519Account({
    privateKey: new Ed25519PrivateKey(API_WALLET_PRIVATE_KEY),
});

// Trading Account (chỉ cần USDC)
const tradingAccountAddress = SUBACCOUNT_ADDRESS;
```

### 3.2. Cách nạp APT vào API Wallet

#### Option 1: Self-pay gas (Tự trả gas)

**Bước 1**: Lấy địa chỉ của API Wallet

```typescript
import { Ed25519Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk';

const account = new Ed25519Account({
    privateKey: new Ed25519PrivateKey(process.env.API_WALLET_PRIVATE_KEY),
});

console.log('API Wallet Address:', account.accountAddress.toString());
// Output: 0x1234...abcd
```

**Bước 2**: Nạp APT vào địa chỉ đó

- **Từ CEX** (Binance, OKX, etc.):
  - Withdraw APT → Network: Aptos → Địa chỉ: API Wallet Address
  - Số lượng khuyến nghị: 0.5-1 APT (đủ cho hàng nghìn giao dịch)

- **Từ ví Aptos khác**:
  - Dùng Petra Wallet, Martian Wallet, etc.
  - Transfer APT đến API Wallet Address

- **Testnet**:
  - Faucet: https://faucet.testnet.aptoslabs.com/
  - Nhập API Wallet Address → Claim APT miễn phí

**Bước 3**: Kiểm tra balance

```bash
# Dùng Aptos CLI
aptos account list --account <API_WALLET_ADDRESS>

# Hoặc dùng REST API
curl https://fullnode.mainnet.aptoslabs.com/v1/accounts/<API_WALLET_ADDRESS>/resources
```

#### Option 2: Gas Station (Khuyến nghị)

**Geomi Gas Station** - Dịch vụ sponsor gas fees của Decibel:

```bash
# .env
DECIBELS_GAS_STATION_API_KEY=your_gas_station_key_here
```

**Ưu điểm**:
- API Wallet **không cần APT**
- Gas Station trả thay mọi transaction
- Không lo hết gas giữa chừng
- Phù hợp cho production bots

**Cách lấy Gas Station API Key**:
1. Liên hệ Decibel team qua Discord/Telegram
2. Hoặc apply qua form trên docs.decibel.trade
3. Nhận API key và set vào `.env`

### 3.3. Ước tính chi phí gas

```
Loại giao dịch          | Gas (APT)  | USD (APT @ $10)
------------------------|------------|----------------
Place Order             | ~0.0001    | ~$0.001
Cancel Order            | ~0.00008   | ~$0.0008
Approve Builder Fee     | ~0.0002    | ~$0.002
Deposit USDC            | ~0.00015   | ~$0.0015
Withdraw USDC           | ~0.00015   | ~$0.0015

1 APT ≈ 10,000 giao dịch place order
```

## 4. Builder Codes - Kiếm phí từ Trading Volume

Builder Codes là tính năng cho phép ứng dụng/bot **kiếm phí từ mọi giao dịch** mà user thực hiện qua ứng dụng của bạn.

### 4.1. Cách hoạt động

```
User đặt order qua bot của bạn
    ↓
Order include builderAddr + builderFee
    ↓
Decibel tính phí giao dịch
    ↓
Builder nhận % phí theo builderFee (VD: 0.1%)
    ↓
Builder fee được trả bằng token của giao dịch
```

### 4.2. Two-Step Process

#### Step 1: Approve Maximum Builder Fee (One-time)

User phải approve maximum builder fee **một lần duy nhất** trước khi bot có thể collect fees:

```typescript
await dex.approveMaxBuilderFee({
    builderAddr: "0x0000000000000000000000008c967e73e7b15087c42a10d344cff4c96d877f1d",
    maxFee: 10, // 10 basis points = 0.1%
});
```

**Parameters**:
- `builderAddr`: Địa chỉ của builder (64 ký tự hex, pad với leading zeros)
- `maxFee`: Maximum fee in basis points (1 bp = 0.01%)
  - `10` = 0.1%
  - `100` = 1%
  - `1000` = 10%

**Lưu ý quan trọng về địa chỉ**:
```typescript
// ❌ SAI - Địa chỉ ngắn (42 chars)
builderAddr: "0x8c967e73e7b15087c42a10d344cff4c96d877f1d"

// ✅ ĐÚNG - Địa chỉ đầy đủ (66 chars = 0x + 64 hex)
builderAddr: "0x0000000000000000000000008c967e73e7b15087c42a10d344cff4c96d877f1d"
```

#### Step 2: Place Order with Builder Code

Sau khi approve, mọi order có thể include builder code:

```typescript
const orderResult = await dex.placeOrder({
    marketName: "BTC/USD",
    price: 95000_00000000, // 8 decimals
    size: 0.1_00000000,    // 8 decimals
    isBuy: true,
    timeInForce: TimeInForce.PostOnly,
    isReduceOnly: false,
    // Builder code parameters
    builderAddr: "0x0000000000000000000000008c967e73e7b15087c42a10d344cff4c96d877f1d",
    builderFee: 10, // Must be <= maxFee from Step 1
});
```

### 4.3. Fee Calculation Example

```
Order: Buy 1 BTC @ $95,000
Trading fee: 0.05% = $47.50
Builder fee: 0.1% of trading fee = $0.0475

User pays: $47.50 (normal trading fee)
Builder earns: $0.0475 (từ phí của Decibel)
Decibel keeps: $47.4525
```

### 4.4. Implementation trong code

```typescript
export class DecibelAdapter {
    private builderAddr: string;
    private builderFeeBps: number;

    constructor(
        privateKey: string,
        nodeApiKey: string,
        subaccountAddr: string,
        builderAddr: string,      // Builder address (64 chars)
        builderFeeBps: number = 10, // Default 0.1%
    ) {
        this.builderAddr = this.padAddress(builderAddr);
        this.builderFeeBps = builderFeeBps;
        // ...
    }

    // Pad address to 64 characters
    private padAddress(addr: string): string {
        if (!addr.startsWith('0x')) addr = '0x' + addr;
        const hex = addr.slice(2);
        return '0x' + hex.padStart(64, '0');
    }

    // Approve builder fee (one-time setup)
    async approveBuilderFee(maxFeeBps?: number): Promise<void> {
        await this.write.approveMaxBuilderFee({
            builderAddr: this.builderAddr,
            maxFee: maxFeeBps ?? this.builderFeeBps,
        });
    }

    // Place order with builder code
    async place_limit_order(
        symbol: string,
        side: 'buy' | 'sell',
        price: number,
        size: number,
        reduceOnly?: boolean,
    ): Promise<string> {
        const cfg = await this.getMarketConfig(symbol);
        const orderParams = {
            marketName: symbol,
            price: this.toChainPrice(price, cfg.px_decimals),
            size: this.toChainSize(size, cfg.sz_decimals),
            isBuy: side === 'buy',
            timeInForce: TimeInForce.PostOnly,
            isReduceOnly: reduceOnly ?? false,
            // Include builder code
            builderAddr: this.builderAddr,
            builderFee: this.builderFeeBps,
        };
        
        const result = await this.write.placeOrder(orderParams);
        return result.orderId ?? result.order_id;
    }
}
```

### 4.5. Setup Script

```bash
# src/scripts/approve-builder-fee.ts
npx tsx src/scripts/approve-builder-fee.ts
```

**Lưu ý**: Chỉ cần chạy **một lần duy nhất** cho mỗi user/subaccount.

### 4.6. Tracking Builder Earnings

```typescript
// Query builder earnings via REST API
const builderStats = await fetch(
    `https://api.decibel.trade/v1/builder/${builderAddr}/stats`
);

// Response:
{
    "totalVolume": "1234567.89",      // Total volume traded
    "totalFees": "123.45",            // Total fees earned
    "last24hVolume": "50000.00",
    "last24hFees": "5.00",
    "markets": {
        "BTC/USD": { "volume": "500000", "fees": "50" },
        "ETH/USD": { "volume": "300000", "fees": "30" }
    }
}
```

## 5. Flow hoàn chỉnh để setup bot

### 5.1. Chuẩn bị

```bash
# 1. Tạo API Wallet mới (hoặc dùng existing)
# Lưu private key vào .env

# 2. Tạo Trading Account (subaccount)
# Có thể tạo qua Decibel UI hoặc SDK

# 3. Lấy Builder Address
# Option A: Dùng API Wallet address làm builder address
# Option B: Tạo builder address riêng để track earnings
# Pad address to 64 hex chars

# 4. Nạp APT vào API Wallet (nếu không dùng Gas Station)
# Xem section 3.2 ở trên

# 5. Nạp USDC vào Trading Account
# Deposit qua Decibel UI hoặc bridge từ chain khác
```

**Cách lấy Builder Address**:

```typescript
// Option 1: Dùng API Wallet address
import { Ed25519Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk';

const account = new Ed25519Account({
    privateKey: new Ed25519PrivateKey(process.env.API_WALLET_PRIVATE_KEY),
});

const builderAddr = account.accountAddress.toString();
console.log('Builder Address (raw):', builderAddr);

// Pad to 64 chars
function padAddress(addr: string): string {
    if (!addr.startsWith('0x')) addr = '0x' + addr;
    const hex = addr.slice(2);
    return '0x' + hex.padStart(64, '0');
}

console.log('Builder Address (padded):', padAddress(builderAddr));
// Output: 0x0000000000000000000000005eefc26ee8f0b537717e57718a9a0c365e32081d
```

```bash
# Option 2: Tạo builder address riêng
# Tạo Aptos wallet mới chỉ để nhận builder fees
# Dùng Petra Wallet hoặc CLI:
aptos init --profile builder
# Copy address và pad to 64 chars
```

### 5.2. Config .env

```bash
# API Wallet (Bot's signing key) - CẦN APT CHO GAS
API_WALLET_PRIVATE_KEY=0x1234...abcd
API_WALLET_ADDRESS=0x5678...efgh

# Trading Account (Subaccount) - CHỈ CẦN USDC
SUBACCOUNT_ADDRESS=0x9abc...def0

# Builder Code (để nhận phí từ trading volume)
BUILDER_ADDRESS=0x0000000000000000000000005eefc26ee8f0b537717e57718a9a0c365e32081d
BUILDER_FEE_BPS=10  # 10 basis points = 0.1%

# Aptos Node API Key
APTOS_NODE_API_KEY=your_aptos_bearer_token

# Gas Station (Optional - nếu không muốn tự trả gas)
DECIBELS_GAS_STATION_API_KEY=your_gas_station_key

# Debug mode
DECIBEL_DEBUG=false
```

**Lưu ý về BUILDER_ADDRESS**:
- Phải có **64 hex characters** (66 total với `0x`)
- Pad với leading zeros nếu address ngắn hơn
- Ví dụ: `0x8c96...f1d` → `0x0000000000000000000000008c96...f1d`

### 5.3. Approve Builder Fee (One-time)

```bash
npx tsx src/scripts/approve-builder-fee.ts
```

### 5.4. Test connection

```bash
# Test read-only operations
npx tsx src/scripts/test-decibel.ts all

# Test place order (CAUTION: places real order)
npx tsx src/scripts/test-decibel.ts place_order
```

## 6. Vấn đề trong code hiện tại

### 6.1. Builder Address không đúng format

```typescript
// ❌ SAI - Builder address chỉ có 42 chars (thiếu padding)
builderAddr: "0x5eefc26ee8f0b537717e57718a9a0c365e32081d96dc618a56041b3b7ff31ed5"
// Length: 66 chars nhưng không pad đúng

// ✅ ĐÚNG - Builder address phải có 64 hex chars (66 total với 0x)
builderAddr: "0x0000000000000000000000005eefc26ee8f0b537717e57718a9a0c365e32081d"
// Pad với leading zeros nếu cần
```

**Fix**: Implement address padding function

```typescript
private padAddress(addr: string): string {
    if (!addr.startsWith('0x')) addr = '0x' + addr;
    const hex = addr.slice(2);
    if (hex.length > 64) throw new Error('Address too long');
    return '0x' + hex.padStart(64, '0');
}
```

### 6.2. Hardcoded builder address

```typescript
// ❌ SAI - Hardcoded builder address
async approveBuilderFee() {
    await this.write.approveMaxBuilderFee({
        builderAddr: "0x5eefc...", // Hardcoded
        maxFee: 10,
    });
}

// ✅ ĐÚNG - Dùng config
constructor(
    privateKey: string,
    nodeApiKey: string,
    subaccountAddr: string,
    builderAddr: string, // Pass as parameter
) {
    this.builderAddr = this.padAddress(builderAddr);
}
```

### 6.2. Hardcoded symbol

```typescript
// ❌ SAI - Hardcoded "BTC/USD"
private async getMarketConfig(symbol: string) {
    symbol = "BTC/USD" // Ghi đè parameter - BUG!
    // ...
}

async get_mark_price(symbol: string) {
    symbol = "BTC/USD" // Ghi đè parameter - BUG!
    // ...
}

// ✅ ĐÚNG - Dùng parameter
private async getMarketConfig(symbol: string) {
    if (this._marketConfig.has(symbol)) return this._marketConfig.get(symbol)!;
    const markets = await this.read.markets.getAll();
    const m = markets?.find((m: any) => m.market_name === symbol);
    // ...
}
```

### 6.3. Missing error handling và fake order ID

```typescript
// ❌ SAI - Return fake order ID
async place_limit_order(...) {
    try {
        const result = await this.write.placeOrder(orderParams);
        console.log('[Decibel] place_limit_order result:', JSON.stringify(result, null, 2));
    } catch (err: any) {
        console.error('[Decibel] place_limit_order error:', ...);
        throw err;
    }
    return "decibel-order-" + Date.now(); // ❌ Fake ID!
}

// ✅ ĐÚNG - Return real order ID from response
async place_limit_order(...) {
    const result = await this.write.placeOrder(orderParams);
    
    // Extract real order ID from response
    const orderId = result.orderId ?? result.order_id ?? result.hash;
    if (!orderId) {
        throw new Error('No order ID in response: ' + JSON.stringify(result));
    }
    
    return orderId;
}
```

### 6.4. Unused parameters và dead code

```typescript
// ❌ SAI - Unused method
private amountToChainUnits(val: number): number {
    return Math.floor(val * 1e8);
}

// ❌ SAI - Unused parameters
async get_orderbook_depth(symbol: string, limit: number) {
    return { bids: [], asks: [] }; // Stub - không dùng symbol, limit
}

// ✅ ĐÚNG - Remove hoặc implement properly
async get_orderbook_depth(symbol: string, limit: number) {
    const depth = await this.read.marketDepth.getByName(symbol, limit);
    return {
        bids: depth.bids.map(b => [b.price, b.size]),
        asks: depth.asks.map(a => [a.price, a.size]),
    };
}
```

## 7. Best Practices

### 7.1. Security

- **Không commit private keys** vào git
- **Dùng .env** cho sensitive data
- **Rotate API keys** định kỳ
- **Monitor gas balance** để tránh bot bị stuck

### 7.2. Gas Management

```typescript
// Check gas balance trước khi trade
async checkGasBalance(): Promise<number> {
    const resources = await this.read.account.getResources(this.apiWalletAddress);
    const aptCoin = resources.find(r => r.type === '0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>');
    return aptCoin?.data?.coin?.value / 1e8 ?? 0;
}

// Alert nếu gas thấp
if (await this.checkGasBalance() < 0.1) {
    console.warn('⚠️ Low gas balance! Please top up APT');
}
```

### 7.3. Error Recovery

```typescript
// Retry logic cho network errors
async placeOrderWithRetry(params: OrderParams, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await this.write.placeOrder(params);
        } catch (err: any) {
            if (err.code === 'NETWORK_ERROR' && i < maxRetries - 1) {
                await sleep(1000 * (i + 1)); // Exponential backoff
                continue;
            }
            throw err;
        }
    }
}
```

## 8. Tài liệu tham khảo

- **Official Docs**: https://docs.decibel.trade/
- **Developer Hub**: https://docs.decibel.trade/developer-hub/overview
- **SDK GitHub**: https://github.com/decibeltrade/sdk (nếu public)
- **Aptos Docs**: https://aptos.dev/
- **Aptos Explorer**: https://explorer.aptoslabs.com/

## 9. Troubleshooting

### "Insufficient gas"
- Check API Wallet có đủ APT không
- Hoặc enable Gas Station API key

### "Builder fee not approved"
- Run `npx tsx src/scripts/approve-builder-fee.ts`
- Chỉ cần chạy 1 lần cho mỗi user/subaccount
- Check `maxFee` đã approve có >= `builderFee` trong order không

### "Invalid builder address"
- Builder address phải có **64 hex characters** (66 total với `0x`)
- Pad với leading zeros: `0x0000...address`
- Ví dụ: `0x8c96...f1d` → `0x0000000000000000000000008c96...f1d`

### "Builder fee exceeds maximum"
- `builderFee` trong order phải <= `maxFee` đã approve
- Approve lại với `maxFee` cao hơn nếu cần

### "Market not found"
- Check symbol name chính xác (case-sensitive)
- List available markets: `adapter['read'].markets.getAll()`
- Decibel dùng format: `BTC/USD`, `ETH/USD`, `APT/USD`

### "Order rejected"
- Check price nằm trong tick size
- Check size >= min_size
- Check margin đủ cho order
- Check price decimals và size decimals đúng

### "WebSocket connection failed"
- Check network connectivity
- Decibel WS có thể bị rate limit
- Implement reconnect logic với exponential backoff

---

**Last updated**: 2026-04-15  
**Author**: APEX Trading Bot Team  
**Version**: 1.1 (Added Builder Codes details)
