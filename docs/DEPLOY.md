# DRIFT — Deploy production (1 VPS nhỏ)

> Đích: VPS 2 vCPU, 4 GB RAM, Ubuntu 24.04 **x64 (amd64)**, chạy cá nhân (2026-10-29: server Atlanta 80 GB; trước đó thử Hetzner CAX11 arm64). Quyết định: DEC-70.
> Mọi bot chạy tiền thật trên SoDEX mainnet. Làm đủ mục "Trước lần deploy đầu" rồi mới bật bot.

## 1. Thành phần

| File | Việc |
|---|---|
| `docker-compose.prod.yml` | Chồng lên `docker-compose.yml`: image từ 1 repo private Docker Hub, tag `<app>-<git sha>`, mỗi service 1 bản, backtest 1 CPU / 1 GB, HTTPS Let's Encrypt, Vault profile `prod` |
| `.github/workflows/deploy.yml` | Chạy tay. check → build 10 image `linux/amd64` (biến `PLATFORM` để đổi) → push Docker Hub → SSH vào VPS chạy `deploy.sh` |
| `infra/deploy/build-push.sh` | Cách làm tay thay workflow: build + push từ máy mình, tuỳ chọn deploy luôn |
| `infra/deploy/bootstrap-vps.sh` | Chạy 1 lần bằng root trên VPS mới: Docker, user `deploy`, swap 4 GB, ufw, SSH chỉ bằng key, vá tự động, cron backup |
| `infra/deploy/deploy.sh` | Trên VPS: pull → hạ tầng → migrate → mọi service healthy; không healthy trong 5 phút thì quay về tag trước |
| `infra/deploy/backup.sh` | 03:15 mỗi ngày: `pg_dump` + tar volume Vault / NATS / Let's Encrypt, giữ 14 ngày, tuỳ chọn mã hoá `age` + `rclone` ra ngoài |
| `infra/vault/prod.hcl`, `infra/vault/prod-init.sh` | Vault server mode lưu file; init, tự unseal (cả sau reboot), policy `signer` chỉ encrypt/decrypt `drift-api-keys` |
| `.env.production.example` | Mẫu `.env` trên VPS |

Lệnh compose trên VPS (thư mục `/opt/drift`):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app --profile prod ps
```

## 2. Trước lần deploy đầu

### 2.1 Tên miền và Hetzner
1. Trỏ bản ghi **A** (và **AAAA** nếu dùng IPv6) của tên miền về IP của VPS.
2. Hetzner › Firewalls: tạo firewall cho server, chỉ mở TCP 22, 80, 443. Docker mở cổng qua iptables, bỏ qua ufw, nên firewall ở panel là lớp chặn chính.
3. Bật Backups của Hetzner (thêm ~20% giá). Không thay thế được backup Postgres ra ngoài máy.

### 2.2 Cài VPS (1 lần)
```bash
scp infra/deploy/bootstrap-vps.sh infra/certs/gen-dev-certs.sh root@<IP>:/root/
ssh root@<IP> 'bash /root/bootstrap-vps.sh'
```

### 2.3 Khoá SSH cho GitHub Actions
Trên máy mình:
```bash
ssh-keygen -t ed25519 -N "" -C github-deploy -f drift_deploy
```
- Nội dung `drift_deploy.pub` → thêm vào `/home/deploy/.ssh/authorized_keys` trên VPS.
- `ssh-keyscan -t ed25519 <IP>` → nội dung dùng cho secret `VPS_KNOWN_HOSTS`.
- Xoá file `drift_deploy` khỏi máy sau khi đã lưu vào GitHub secret.

### 2.4 `.env` và cert mTLS trên VPS (user `deploy`)
```bash
ssh deploy@<IP>
cd /opt/drift
# dán nội dung .env.production.example rồi điền
nano .env && chmod 600 .env
CERT_DAYS=1095 sh /root/gen-dev-certs.sh /opt/drift/certs   # chạy bằng root, rồi chown -R deploy:deploy /opt/drift/certs
```
Giá trị phải tự sinh (mỗi cái một lần, không đổi về sau):
- `POSTGRES_PASSWORD`, `SIGNER_DB_PASSWORD`: `openssl rand -hex 24`
- `API_TOTP_ENC_KEY`: `openssl rand -base64 32`
- `VAULT_TOKEN` (token của signer): `openssl rand -hex 24`
- `DRIFT_IMAGE`: `docker.io/<user-docker-hub>/drift`. `APP_HOST`: tên miền. `ACME_EMAIL`: email nhận cảnh báo chứng chỉ.
- `SMTP_URL`, `MAIL_FROM`: nhà cung cấp email thật (OTP đăng nhập đi qua email).
- `DRIFT_BUILDER_ID`, `DRIFT_BUILDER_ADDRESS`: như máy dev.

Cert mTLS hết hạn sau `CERT_DAYS` ngày. Đặt lịch nhắc tạo lại trước ngày hết hạn (signer từ chối mọi kết nối khi cert hết hạn → bot pause `API_KEY_UNUSABLE`).

### 2.5 Docker Hub
1. Tạo tài khoản, tạo **một** repository tên `drift`, chọn **Private**. Image chứa toàn bộ source code: không để public.
   Gói free chỉ có 1 repo private, nên cả 10 app chung repo này, phân biệt bằng tag `api-<sha>`, `web-<sha>`…
2. Account settings › Personal access tokens, tạo 2 token:
   - `drift-push`, quyền **Read & Write**: cho GitHub Actions (hoặc máy mình khi dùng `build-push.sh`).
   - `drift-vps`, quyền **Read-only**: cho VPS kéo image.
3. Trên VPS (user `deploy`), đăng nhập một lần, Docker nhớ trong `~/.docker/config.json`:
   ```bash
   docker login -u <user-docker-hub>     # dán token drift-vps khi được hỏi
   ```
4. Gói free giới hạn số lượt pull (khoảng 100 lượt / 6 giờ khi đã đăng nhập; con số Docker công bố đã đổi vài lần). Mỗi lần deploy kéo khoảng 10 image app + vài image hạ tầng: dư cho vài lần deploy mỗi ngày.

### 2.6 GitHub
1. `git init`, push lên repo **private**.
2. Settings › Secrets and variables › Actions:
   - Secrets: `VPS_HOST` (IP), `VPS_USER` (`deploy`), `VPS_SSH_KEY` (nội dung `drift_deploy`), `VPS_KNOWN_HOSTS`.
   - Secrets thêm: `DOCKERHUB_TOKEN` (token `drift-push`).
   - Variables: `DOCKERHUB_USERNAME`, `DRIFT_IMAGE` (`docker.io/<user>/drift`), `WALLETCONNECT_PROJECT_ID` (nhúng vào web lúc build; trống thì ẩn WalletConnect).
3. GitHub Free không có "Required reviewers" cho repo private: workflow chỉ chạy khi bấm **Actions › deploy › Run workflow**.

### 2.7 Sau lần deploy đầu
1. Vault tự init. **Ngay lập tức** chép unseal key và root token ra trình quản lý mật khẩu:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app --profile prod exec vault-init cat /vault/init/init.txt
   ```
   Mất cả volume `vaultinit` lẫn bản chép này = không giải mã được API key nào nữa; phải kết nối lại SoDEX cho mọi account.
2. Mở `https://<APP_HOST>`, đăng ký, bật 2FA, kết nối SoDEX, rồi mới tạo bot.

## 3. Deploy hằng ngày
1. Push lên `main` (CI chạy như cũ).
2. Actions › deploy › Run workflow (nhánh `main`).
3. Workflow build image `<DRIFT_IMAGE>:<app>-<sha>`, chép compose + `infra/` lên VPS (không chép `.env`, cert), chạy `deploy.sh <sha>`.

Làm tay, không qua GitHub (máy đã `docker login` bằng token `drift-push`):
```bash
DRIFT_IMAGE=docker.io/<user>/drift infra/deploy/build-push.sh deploy@<IP>
```
Script tự về gốc repo, đọc `WALLETCONNECT_PROJECT_ID` từ `.env`, gắn 2 tag `<app>-<sha>` và `<app>-latest`. Chỉ build vài app: `infra/deploy/build-push.sh web api`. VPS ARM thì thêm `PLATFORM=linux/arm64` (máy x86 phải giả lập QEMU, chậm).

Quy tắc:
- **Migration tương thích ngược**: chỉ thêm bảng/cột; xoá hoặc đổi tên ở một lần deploy sau. `deploy.sh` rollback image chứ không rollback migration.
- Engine chạy 1 bản: khi deploy, bot ngừng đặt lệnh vài giây. Engine trả lease khi SIGTERM; lệnh chưa rõ kết quả được đối soát (`unknown`), không gửi lại mù.
- Tránh deploy khi bot đang ở bước nhạy cảm (TWAP sắp xong, vừa đổi đòn bẩy).

Rollback tay về một SHA cũ (image còn giữ 72 giờ):
```bash
ssh deploy@<IP> 'bash /opt/drift/infra/deploy/deploy.sh <sha-cũ>'
```
(Image cũ vẫn nằm trên Docker Hub, VPS kéo lại được bằng token read-only.)

## 4. Tài nguyên (2 vCPU, 4 GB)
- Đo trên máy dev: cả stack 2–3 bản mỗi service ≈ 2.9 GB RAM. Prod 1 bản mỗi service ước ≈ 1.6–1.8 GB, còn chỗ cho Postgres cache và backtest; swap 4 GB đỡ lúc cao điểm.
- Không chạy profile `observability` trên máy 4 GB.
- Ổ đĩa (80 GB ở server hiện tại): image cũ bị xoá sau 72 giờ, log Docker xoay vòng 5 × 20 MB mỗi container, backup giữ 14 ngày. Theo dõi `df -h` và kích thước `candles_1m`; gần đầy thì gắn thêm ổ hoặc nâng gói.
- Build amd64 chạy thẳng trên runner x86 của GitHub và trên Mac Intel, không cần QEMU. Chỉ VPS ARM mới phải build arm64 qua QEMU (chậm, 40–70 phút Actions mỗi lần).
- Mỗi IP giữ được user stream SoDEX của khoảng 10 account (ARCHITECTURE.md mục 3.3). Đủ cho dùng cá nhân.

## 5. Backup và khôi phục
- Mặc định backup chỉ nằm trên VPS (`/opt/drift/backups`). Nên đẩy ra ngoài:
  1. `age-keygen -o drift-backup.key` trên máy mình, cất `drift-backup.key` vào chỗ an toàn; dòng `public key: age1…` → `BACKUP_AGE_RECIPIENT`.
  2. Cài `rclone` trên VPS, `rclone config` một remote (Backblaze B2, S3, Hetzner Storage Box…), tên remote:đường dẫn → `RCLONE_REMOTE`.
- Bản Vault chứa unseal key + root token: chỉ ra khỏi VPS khi đã mã hoá `age` (script đã đảm bảo).
- Khôi phục Postgres: `pg_restore -U drift -d drift --clean` từ file `pg-*.dump`. Khôi phục Vault: dừng `vault` + `vault-init`, giải nén `vaultdata-*` và `vaultinit-*` vào volume tương ứng, chạy lại. **Thử khôi phục ít nhất một lần** trên máy khác trước khi tin vào backup.

## 6. Chưa có
- Giám sát: chưa có exporter. Tối thiểu nên có kiểm tra uptime từ ngoài (UptimeRobot, Better Stack…) gọi `https://<APP_HOST>/api/healthz`.
- Vault tự unseal bằng key nằm cùng máy: ai có root VPS là đọc được (đánh đổi để bot tự chạy lại sau reboot, DEC-70). Muốn chặt hơn thì dùng KMS của cloud hoặc unseal tay.
- Load test, pentest: chưa làm (SECURITY_REVIEW.md).
