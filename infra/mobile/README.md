# DRIFT — App Android (APK)

App Android của DRIFT là một **TWA (Trusted Web Activity)**: APK mở web DRIFT trên tên miền prod bằng Chrome, toàn màn hình, không thanh địa chỉ. Không có code native, nên:

- deploy web xong là app có bản mới, **không cần build lại APK**;
- chỉ build lại khi đổi tên app, icon, màu, tên miền hoặc nâng phiên bản lên Google Play;
- ký ví (WalletConnect, MetaMask, Trust…) đi qua app ví trên điện thoại rồi quay lại DRIFT, giống trên Chrome.

Script: `infra/mobile/build-apk.sh` (dùng [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) của Google).

## 0. Cần có

- Máy Mac (hoặc Linux) có **Node.js 18+**.
- Web DRIFT đã chạy trên **tên miền HTTPS thật** (ví dụ `desklabs.xyz`). TWA không chạy với `localhost`.
- JDK 17 và Android SDK: **không cần cài trước**. Lần chạy đầu Bubblewrap hỏi có tải không, trả lời **Yes**.
- (Tuỳ chọn) `adb` và điện thoại bật USB debugging để cài thẳng bằng `--install`.

## 1. Chuẩn bị web (đã có trong repo)

Web đã có sẵn hai file Android cần, chỉ cần deploy web bản mới:

- **Web manifest** ở `/manifest.webmanifest` (`apps/web/src/app/manifest.ts`): tên DRIFT, `display: standalone`, màu nền `#eef1fa`, màu chủ đạo `#2e62e8`, icon 192 / 512 thường và maskable ở `apps/web/public/icons/` (sinh từ `app/icon.svg`).
- **Digital Asset Links** ở `/.well-known/assetlinks.json` (`apps/web/src/app/.well-known/assetlinks.json/route.ts`): đọc env lúc chạy, chưa đặt thì trả `[]`.

Hai đường dẫn này mở cho người chưa đăng nhập (`OPEN_PATHS` trong `apps/web/src/proxy.ts`).

Kiểm tra sau khi deploy:

```bash
curl -s https://drift.junxcrypto.xyz/manifest.webmanifest
```

## 2. Build lần đầu

```bash
infra/mobile/build-apk.sh --domain drift.junxcrypto.xyz
```

Bubblewrap hỏi vài câu. Gợi ý trả lời:

| Câu hỏi | Trả lời |
|---|---|
| Install JDK / Android SDK? | Yes |
| Domain, URL path | giữ mặc định từ manifest |
| Application ID | `com.drift.app` (**không đổi được sau khi lên Google Play**) |
| Display mode | standalone |
| Signing key | tạo key mới; đặt mật khẩu và **ghi lại** |

Kết quả nằm ở `infra/mobile/out/`:

- `drift-<thời điểm>.apk`: cài thẳng lên điện thoại;
- `drift-<thời điểm>.aab`: file nộp lên Google Play;
- `assetlinks.json`: lấy package và fingerprint cho bước 3.

Project Android được lưu ở `infra/mobile/android/` (gồm `twa-manifest.json` và `android.keystore`). Cả thư mục này và `out/` đều nằm trong `.gitignore`.

## 3. Ẩn thanh địa chỉ (Digital Asset Links)

1. Lấy `packageId` trong `infra/mobile/android/twa-manifest.json` và SHA-256 của chữ ký APK (`out/assetlinks.json` có thể là `[]` khi `fingerprints` trong twa-manifest còn trống, nên đọc thẳng từ APK):

   ```bash
   ~/.bubblewrap/jdk/*/Contents/Home/bin/keytool -printcert -jarfile infra/mobile/out/drift-<thời điểm>.apk | grep SHA256
   ```
2. Thêm vào `.env` trên server (cùng thư mục với `docker-compose.yml`):

   ```bash
   ANDROID_PACKAGE_NAME=xyz.junxcrypto.drift.twa
   ANDROID_CERT_SHA256=AB:CD:...:EF
   ```

   Nhiều khoá (ví dụ thêm key của Play App Signing) cách nhau bằng dấu phẩy.
3. Khởi động lại web, không cần build lại image:

   ```bash
   docker compose up -d web
   ```

4. Kiểm tra: `curl -s https://drift.junxcrypto.xyz/.well-known/assetlinks.json` phải trả đúng package và fingerprint; hoặc dùng công cụ của Google:
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://drift.junxcrypto.xyz&relation=delegate_permission/common.handle_all_urls`

Vẫn trả `[]` dù `.env` đúng: `docker-compose.yml` trên server là bản cũ, chưa truyền hai biến vào service `web` (build lại image không đổi được file này). Kiểm tra bằng `grep ANDROID docker-compose.yml` và `docker compose exec web printenv ANDROID_PACKAGE_NAME`; thiếu thì chép bản mới từ `deploy/server/docker-compose.yml` rồi `docker compose up -d web`.

Fingerprint không khớp thì app vẫn chạy nhưng có thanh địa chỉ Chrome ở trên cùng. Nộp lên Google Play bằng **Play App Signing** thì Google ký lại bằng key của Google: thêm SHA-256 trong Play Console › App integrity vào `ANDROID_CERT_SHA256`.

## 4. Cài lên điện thoại

- Chép file `.apk` sang điện thoại rồi mở (cho phép "Install unknown apps"), hoặc
- cắm điện thoại (bật USB debugging) rồi:

```bash
infra/mobile/build-apk.sh --install
```

## 5. Các lần sau

| Việc | Lệnh |
|---|---|
| Web có bản mới | Không cần làm gì, app tự dùng bản mới |
| Build lại với cấu hình cũ | `infra/mobile/build-apk.sh` |
| Đổi tên, màu, icon, phiên bản | sửa `infra/mobile/android/twa-manifest.json` (tăng `appVersionCode` mỗi lần nộp Play), rồi `infra/mobile/build-apk.sh --update` |
| Không muốn gõ mật khẩu | đặt `BUBBLEWRAP_KEYSTORE_PASSWORD` và `BUBBLEWRAP_KEY_PASSWORD` trước khi chạy |

## 6. Keystore: bắt buộc sao lưu

`infra/mobile/android/android.keystore` và mật khẩu của nó là **khoá ký app**.

- Mất keystore: không cập nhật được app đã cài (người dùng phải gỡ và cài lại); trên Google Play thì phải xin reset upload key.
- Không commit, không gửi qua chat. Cất ở trình quản lý mật khẩu hoặc ổ mã hoá.

## 7. Google Play (khi muốn phát hành)

- Tài khoản Google Play Console (phí một lần).
- App giao dịch crypto: điền **Financial features declaration**; tuỳ quốc gia, Google có thể yêu cầu giấy phép hoặc giới hạn quốc gia phát hành.
- Cần URL **Privacy Policy** công khai: hiện DRIFT đã bỏ trang này (app cá nhân), phải thêm lại trước khi nộp.
- Chỉ tự cài APK (sideload) thì bỏ qua toàn bộ mục này.

## Chưa có

- Thông báo đẩy (push): cần service worker + Web Push, làm riêng.
- Chạy offline: app cần mạng vì mọi dữ liệu đến từ DRIFT và SoDEX.
