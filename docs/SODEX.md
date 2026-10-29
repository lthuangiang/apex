# DRIFT — Tích hợp SoDEX

> Một phần của bộ tài liệu DRIFT. Đọc `CLAUDE.md` ở gốc repo trước. Số mục giữ nguyên như bản gốc để các tham chiếu "mục X" vẫn đúng (xem bảng mục lục trong `CLAUDE.md`).

## 5. Tích hợp SoDEX (theo tài liệu Builder Codes của SoDEX)

Tài liệu: https://sodex.com/documentation/for-developers/developers/trading/builder-codes-in-trading. Đọc lại tài liệu này mỗi khi động vào phần ký, phí hay lệnh.

### 5.1 Ký
- EIP-712 domain: `name = "universal"`, `version = "1"`, `chainId` = giá trị header `X-API-Chain`, `verifyingContract` = zero address.
- Trường `chainID` trong message: **286623 cho mainnet**, 138565 cho testnet. Giá trị này khác `chainId` của domain.
- Header `X-API-Sign` = `0x02 || r || s || v`, với `v` chuẩn hoá về `0`/`1` (đổi từ 27/28).
- Approval builder phải do **master wallet** ký, không bao giờ do API key ký.

### 5.2 Các action DRIFT dùng

| Khi nào | Action | Người ký | Field chính |
|---|---|---|---|
| Onboarding bước 2, chữ ký 1 (DEC-25) | `UserSignedAddPermissionedAPIKeyAction`, gửi `POST /api/v1/user/{userAddress}/api-keys` kèm `permissions`, **không** kèm `builder` | master wallet | `chainID, nonce, accountID, name="DRIFT", keyType=1, publicKey, expiresAt, permissions` |
| Onboarding bước 2, chữ ký 2 (DEC-25) | `ApproveBuilderFeeAction`, gửi `POST /api/v1/user/{userAddress}/builders` | master wallet | `chainID, nonce, accountID, builderID=DRIFT_BUILDER_ID, maxFeeRate=50` |
| Gia hạn key | `UserSignedAddPermissionedAPIKeyAction` với cùng `permissions` | master wallet | như chữ ký 1 |
| Trước lệnh Perps đầu tiên của mỗi version bot (DEC-51) | `updateLeverage`, `POST /api/v1/perps/trade/leverage` | key của DRIFT | `accountID, symbolID, leverage, marginMode` |
| Revoke phí | `ApproveBuilderFeeAction` | master wallet | `builderID, maxFeeRate=0` |
| Approve lại | `ApproveBuilderFeeAction` | master wallet | `builderID, maxFeeRate=50` |

- Trong request tạo key, `builder` và `permissions` không được dùng cùng lúc. Vì vậy DRIFT tạo key có giới hạn quyền rồi approve phí bằng chữ ký riêng (DEC-25).
- `permissions` là mặt nạ **tắt** quyền: TRADE=1, CANCEL=2, WITHDRAW=4, TRANSFER=8; bỏ trống nghĩa là có mọi quyền. SoDEX không cho bật cùng lúc TRADE và CANCEL, nên phải tắt một trong hai. Giá trị đề xuất là `14` (tắt CANCEL, WITHDRAW, TRANSFER, chỉ giữ TRADE), dựa trên ghi chú trong Python SDK rằng "TRADE itself includes order cancellation". Bảng `APIKeyPermissionEnum` trong tài liệu chính thức (tra ngày 2026-10-27) cũng ghi TRADE = "Place, replace, modify, and cancel orders". **[confirm]** Bằng một key thử trên mainnet (người dùng chạy tay, DEC-23), phải kiểm chứng rằng key mask 14 đặt **và huỷ** được lệnh, còn `transferAsset` thì bị từ chối. Chưa kiểm chứng thì không được bật luồng kết nối.
- Hai chữ ký là hai bước riêng: bước 1 xong mà bước 2 chưa xong thì key đã tồn tại nhưng phí chưa approve. Bot không được start khi approval chưa bằng 50 trên Spot và Perps (SCREENS.md mục 8.2, "Before it starts").
- DRIFT tự sinh cặp key ở backend. Private key không bao giờ rời `signer`.
- Sau mỗi chữ ký, **đọc lại** danh sách key và **cả hai** mảng approval (Spot và Perps) rồi mới báo thành công.
- Mỗi account SoDEX có tối đa **10** builder approval. Nếu SoDEX từ chối vì lý do này, hiện: "Remove another builder approval in SoDEX first."
- Tài khoản builder của DRIFT phải có ≥ 100 vUSDC trên cả Spot và Perps thì người dùng mới approve được mức phí khác 0. Cần theo dõi điều kiện này và cảnh báo cho đội vận hành.

### 5.3 Lệnh
- Mỗi lệnh của DRIFT mang `builder: {"id": DRIFT_BUILDER_ID, "fee": 10}` (DEC-46; account của chính builder không gắn `builder`, DEC-47) ở **cuối** payload (`id` đứng trước `fee`), và được thêm **trước** khi tính payload hash.
- Spot: `builder` đặt ở cấp batch, sau `orders`. Perps: đặt làm default của batch (cho phép override theo từng lệnh).
- Đơn vị: `fee` / `maxFeeRate` tính bằng phần mười basis point. `10` = 1 bp = 0.01% (mức của DRIFT, DEC-46); `50` = 5 bp = 0.05%.
- Phí thực thu = min(mức người dùng approve, trần của engine). Trần: Perps 0.2% (200), Spot 2% (2000).
- Perps thu ở cả hai chiều. Spot chỉ thu bằng quote asset và **không thu ở chiều mua**.
- Lệnh có builder chưa được approve vẫn khớp, nhưng builder fee = 0. Vì vậy engine phải pause bot khi approval = 0 (quy tắc 1.5).
- Builder fee của từng fill nằm ở REST `builderFee` và WS `bf`, và **đã nằm sẵn trong** `fee` / `f`. Không cộng thêm lần nữa.

### 5.4 Builder revenue
- Phí được cộng ngay khi khớp lệnh vào tài khoản builder của DRIFT, trên đúng engine có fill đó. **Không có bước claim**, không có các giai đoạn accrued / pending / paid.
- Số tổng lấy từ fee summary và daily chart endpoint của SoDEX (tổng phí, số fill, notional).
- Đối soát: so tổng `builderFee` trên các fill của DRIFT với biến động số dư của tài khoản builder (`accountUpdate`: Spot `data.B[].t`, Perps `data.B[].wb`). `accountUpdate` không có lý do hay trade id, nên phần chênh lệch không giải thích được thì **để pending**, không tính vào doanh thu.
- Builder revenue không bao giờ được trộn vào equity, PnL hay lợi nhuận bot của người dùng.

### 5.5 Giá trị cần xác nhận **[confirm]**
- `DRIFT_BUILDER_ID`: đã chốt là config lúc chạy, người dùng tự điền (DEC-24). Code không được dùng 120044 hay bất kỳ placeholder nào.
- `expiresAt` tối đa: tài liệu SoDEX không ghi (đơn vị là ms; ý nghĩa của `0` cũng không ghi). Thiết kế giả định 180 ngày và nhắc trước 14 ngày.
- Quyền của key: đã chốt ở DEC-25 (key có giới hạn quyền + approve phí riêng). Còn phải kiểm chứng mask `14` trên mainnet (mục 5.2).
- Xoá key: đã rõ (public API, tra ngày 2026-10-27). Gửi hai request `DELETE /{spot|perps}/accounts/api-keys` với body `RevokeAPIKeyRequest {accountID, name}`, mỗi request do master wallet ký riêng trên domain `spot` / `futures` (`0x01`). Không dùng được chữ ký universal. Hai request thành công hoặc thất bại độc lập với nhau.
- Spot: tài liệu ghi action `newOrder` / `cancelOrder`, cả Go SDK lẫn Python SDK dùng `batchNewOrder` / `batchCancelOrder`.
- Dấu của funding: `fundingFee` ghi "negative = received", `cumFundingFee` ghi "positive received". Cần đối chiếu với dữ liệu thật.
- Ví dụ ký giao dịch trong trang "Authentication and signing" tự mâu thuẫn: khoá `0x2222…2222` có địa chỉ `0x1563915e…5508`, không phải `0x3d4595c8…8256` như trang ghi; payload hash `0x7521d1ca…` cũng không khớp với JSON mẫu gần đó (JSON đó cho `0x24d973a9…`). Contract test chỉ dùng phần JSON mẫu (khớp từng byte) và golden vector universal. Chữ ký giao dịch: golden vector sinh từ Go SDK chính thức (DEC-27), contract test khớp từng byte.

### 5.6 Spec lấy từ tài liệu công khai và SDK chính thức (tra ngày 2026-10-27)
Nguồn: các trang `.md` trong https://sodex.com/documentation/llms.txt, `sodex-tech/sodex-go-sdk-public` (commit 548dfd4), `sodex-tech/sodex-python-sdk-public` (commit 7ff3186). Đọc lại nguồn khi động vào phần ký hay lệnh.

- **URL mainnet:** REST `https://mainnet-gw.sodex.dev/api/v1` (`/spot`, `/perps`), WS `wss://mainnet-gw.sodex.dev/ws/spot` và `/ws/perps`.
- **Universal (master wallet ký):** domain `universal`, chainId = header `X-API-Chain` = 286623; type string của `AddAPIKey`, `AddAPIKeyWithBuilder`, `UserSignedAddPermissionedAPIKeyAction`, `ApproveBuilderFeeAction` nằm trong `packages/sodex/src/signing/universal.ts`. `keyType = 1` (EVM). Contract test khớp golden vector chính thức.
- **Giao dịch:** domain `spot` hoặc `futures`, `ExchangeAction(bytes32 payloadHash,uint64 nonce)`, chữ ký prefix `0x01`. `payloadHash = keccak256(JSON gọn của {"type","params"})`, khoá theo thứ tự field của Go struct, số thập phân là chuỗi đã bỏ số 0 thừa, uint64 là số nguyên không có ngoặc kép. Body HTTP chỉ chứa `params`.
- **`builder`:** Spot đặt ở cấp batch sau `orders`; Perps đặt ở cấp request sau `orders`. Luôn là `{"id","fee"}`.
- **Market info:** `GET /{spot|perps}/markets/symbols` trả `tickSize`, `stepSize`, `minQuantity`, `minNotional`, `pricePrecision`, `quantityPrecision`; perps thêm `maxLeverage`, `fundingInterval` (giây). Lệnh dùng `id` làm `symbolID`.
- **Approval:** `GET /api/v1/user/{addr}/builders` trả `data.spot[]` và `data.perps[]` gồm `{builderID, feeRate}`. Key: `GET /api/v1/user/{addr}/api-keys`. Account: `GET /api/v1/user/{addr}/subaccounts` (`primaryAccountID`).
- **Ràng buộc khi đăng ký key:** tối đa 5 key cho mỗi master account; mainnet yêu cầu đã nạp ít nhất 5 USDC trước khi đăng ký; tên key `^[0-9a-zA-Z_-]{1,36}$`, không được là `default`.
- **Isolated margin:** có (`marginMode` ISOLATED=1, CROSS=2). Đòn bẩy + margin mode là thiết lập **theo symbol của account**, đặt bằng `updateLeverage`; lệnh không mang đòn bẩy. Vị thế CROSS không có field `iw` trong account state (mainnet, 2026-10-28). Đòn bẩy đặt theo **account + symbol**: bot đổi đòn bẩy sẽ đổi cho cả giao dịch tay trên symbol đó (check `leverage_conflict`, DEC-58).
- **Multi-Asset Margin** (https://sodex.com/documentation/trading-mechanics/multi-asset-margin): `av` = giá trị collateral theo index price chưa haircut; `am` = margin dùng được cho Cross sau collateral ratio (`B[].mr`, `B[].wm`); `ami` = chỉ USDC, dùng cho Isolated. USDC Perps có thể âm (lỗ, phí, funding trừ bằng USDC).
- **Funding hiện tại/kế tiếp:** `GET /perps/markets/mark-prices` (`fundingRate`, `nextFundingTime`). Không có endpoint lịch sử funding toàn thị trường, chỉ có lịch sử theo account.
- **Kline:** `GET /{spot|perps}/markets/{symbol}/klines`, có `1m`; tối đa 1500 dòng (spot) / 1000 dòng (perps) mỗi lần, phân trang bằng `startTime`/`endTime`. Độ sâu lịch sử không ghi.
- **Nonce:** theo từng địa chỉ ký, nên dùng ms; server giữ 100 nonce cao nhất, nonce phải nằm trong (T − 2 ngày, T + 1 ngày). Nonce mới không làm retry thành idempotent; sau timeout phải đối soát theo `clOrdID`.
- **Rate limit:** khớp `docs/VOLUME_MAKER.md` mục 17.1; trọng số từng endpoint nằm trong `packages/sodex/src/rate-limit/weights.ts`.
- **Lỗi:** `{"code": <số âm>, "error": "…", "timestamp"}`; không có bảng mã lỗi.
- **WebSocket user stream** (`websocket-v1.md`, tra ngày 2026-10-27): subscribe `{"op":"subscribe","id","params":{"channel":"accountOrderUpdate"|"accountTrade","user","accountID"?,"symbols"?}}`; `accountID` là số, bỏ trống thì dùng primary account. Không cần xác thực. Ack có dạng `{op,id,success,error?}`; với user chưa tồn tại thì `success:false, error:"user not found"` (đã kiểm chứng trên mainnet). Response dùng enum dạng **chuỗi** (`"BUY"`, `"LIMIT"`, `"PARTIALLY_FILLED"`…). `OrderStatusEnum` (`X`) khác `ExecutionTypeEnum` (`x`). Server cắt kết nối sau 60 s không có dữ liệu: sau N < 60 s yên lặng thì gửi `{"op":"ping"}`, không nhận `{"op":"pong"}` trong N s nữa thì reconnect, resubscribe rồi đối soát qua REST.
- **Ghi đã ký:** header `X-API-Key` (tên key; bỏ trống khi master wallet ký trực tiếp), `X-API-Sign`, `X-API-Nonce`; `X-API-Chain` chỉ dùng cho action universal. `DELETE /trade/orders` (huỷ lệnh) **có body**. Response batch là `data: [{code, clOrdID, error?, orderID?}]`, và lỗi pre-validation có thể chỉ trả một phần tử cho cả batch, nên phải khớp theo `clOrdID`.
- **Mạng ValueChain cho ví** (FAQ "How do I add the ValueChain network?", tra ngày 2026-10-27): Network Name `ValueChain`, RPC `https://mainnet.valuechain.xyz`, Chain ID `286623`, Currency `SOSO`, Explorer `https://main-scan.valuechain.xyz`. Ví (ví dụ MetaMask) chỉ ký `eth_signTypedData_v4` khi `domain.chainId` trùng chain đang chọn, nên web phải yêu cầu ví chuyển sang (hoặc thêm) ValueChain trước khi ký.
