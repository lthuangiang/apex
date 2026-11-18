# DRIFT — Deploy production (1 VPS nhỏ)

> Đích: VPS 2 vCPU, 4 GB RAM, Ubuntu 24.04 **x64 (amd64)**, chạy cá nhân (2026-11-15: server Singapore, `149.28.148.63`; tài liệu cũ ghi Atlanta 80 GB; trước đó thử Hetzner CAX11 arm64). Quyết định: DEC-70.
> Mọi bot chạy tiền thật trên SoDEX mainnet. Làm đủ mục "Trước lần deploy đầu" rồi mới bật bot.

## 1. Thành phần

Production chạy **một file compose giữ tay** ở `/opt/drift/docker-compose.yml` trên VPS, cùng `/opt/drift/.env` (có `DRIFT_IMAGE`, `DRIFT_TAG`). Repo không chép compose nào lên VPS; thay đổi biến môi trường hay service trên prod là bước làm tay ghi trong ghi chú release (ví dụ mục 2.12). `deploy/server/docker-compose.yml` trong repo là mẫu một file theo cùng cách (khối `x-env`) để dựng máy mới.

| File | Việc |
|---|---|
| `infra/deploy/build-push.sh` | Cách deploy đang dùng. Chạy trên máy mình: `docker buildx build --push` từng app (`apps/<app>/Dockerfile`, `PLATFORM` mặc định `linux/amd64`) lên repo private Docker Hub (`DRIFT_IMAGE`, mặc định `docker.io/lthuangiang/drift`) với tag `<app>-<yyyyMMddHHmmss>` và `<app>-latest`. Chỉ build vài app thì app còn lại được gắn tag mới trỏ vào image đang chạy (`imagetools create`), vì mọi app dùng chung một `DRIFT_TAG`. `--deploy [user@host] [app…]`: SSH (một kết nối dùng chung, `DEPLOY_TARGET` / `DEPLOY_SSH_PASS` trong `infra/deploy/.deploy.local`) tới VPS, `cd /opt/drift`, đổi `DRIFT_TAG` trong `.env` → `docker compose pull` → `docker compose run --rm migrate` → `docker compose up -d` → xoá image DRIFT cũ (giữ tag hiện tại và tag liền trước) + layer treo. `--deploy-only <tag>`: không build, deploy (hoặc rollback về) một tag đã push. Script in lệnh rollback sau mỗi lần deploy |
| `.github/workflows/release.yml` | Chạy khi push tag `vX.Y.Z` trên `main` (`docs/RELEASE.md`): build + push các app đổi so với tag trước; **không deploy**. Deploy tag đó bằng `build-push.sh --deploy-only <tag>` |
| `infra/deploy/bootstrap-vps.sh` | Chạy 1 lần bằng root trên VPS mới: Docker, user `deploy`, swap 4 GB, ufw, SSH chỉ bằng key, vá tự động, cron backup |
| `infra/deploy/backup.sh` | 03:15 mỗi ngày: `pg_dump` + tar volume Vault / NATS / Let's Encrypt, giữ 14 ngày, tuỳ chọn mã hoá `age` + `rclone` ra ngoài |
| `infra/vault/prod.hcl`, `infra/vault/prod-init.sh` | Vault server mode lưu file; init, tự unseal (cả sau reboot), policy `signer` chỉ encrypt/decrypt `drift-api-keys` |
| `.env.production.example` | Mẫu `.env` trên VPS |
| `infra/deploy/deploy.sh`, `docker-compose.prod.yml` | Cách cũ (hai file compose chồng nhau + `deploy.sh` trên VPS). **Không dùng** cho prod hiện tại: `build-push.sh` cố ý không chép compose của repo và không gọi `deploy.sh` |

Lệnh compose trên VPS:

```bash
cd /opt/drift && docker compose ps
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

### 2.3 Khoá SSH cho GitHub Actions (không còn dùng)
Từ 2026-11-12 GitHub chỉ build, không SSH vào VPS, nên không cần khoá này. Giữ phần dưới để tham khảo nếu sau này cho Actions deploy.

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
- `DESK_AI_API_KEY` (tuỳ chọn, DEC-165): key Claude API tạo ở Claude Console (tài khoản trả theo token của DeskLabs, không phải gói Claude cá nhân). Chỉ service `api` đọc. Để trống thì Desk AI chạy bằng câu mẫu. Đổi key: sửa `.env` rồi `docker compose … up -d api`. Không dán key vào log, ticket hay PR.

Cert mTLS hết hạn sau `CERT_DAYS` ngày. Đặt lịch nhắc tạo lại trước ngày hết hạn (signer từ chối mọi kết nối khi cert hết hạn → bot pause `API_KEY_UNUSABLE`).

### 2.5 Docker Hub
1. Tạo tài khoản, tạo **một** repository tên `drift`, chọn **Private**. Image chứa toàn bộ source code: không để public.
   Gói free chỉ có 1 repo private, nên cả 11 app chung repo này, phân biệt bằng tag `api-<sha>`, `web-<sha>`…
2. Account settings › Personal access tokens, tạo 2 token:
   - `drift-push`, quyền **Read & Write**: cho GitHub Actions (hoặc máy mình khi dùng `build-push.sh`).
   - `drift-vps`, quyền **Read-only**: cho VPS kéo image.
3. Trên VPS (user `deploy`), đăng nhập một lần, Docker nhớ trong `~/.docker/config.json`:
   ```bash
   docker login -u <user-docker-hub>     # dán token drift-vps khi được hỏi
   ```
4. Gói free giới hạn số lượt pull (khoảng 100 lượt / 6 giờ khi đã đăng nhập; con số Docker công bố đã đổi vài lần). Mỗi lần deploy kéo khoảng 11 image app + vài image hạ tầng: dư cho vài lần deploy mỗi ngày.

### 2.6 GitHub
1. `git init`, push lên repo **private**.
2. Settings › Secrets and variables › Actions:
   - Secret: `DOCKERHUB_TOKEN` (token `drift-push`, quyền Read & Write). Người dùng tự đặt: `gh secret set DOCKERHUB_TOKEN --repo <owner>/<repo>`.
   - Variables: `DOCKERHUB_USERNAME`, `DRIFT_IMAGE` (`docker.io/<user>/drift`), `WALLETCONNECT_PROJECT_ID` (nhúng vào web lúc build; trống thì ẩn WalletConnect).
3. Workflow `release` chỉ chạy khi có tag `vX.Y.Z`; tag do PM tạo khi người dùng gõ "release" (`docs/RELEASE.md`).

### 2.7 Sau lần deploy đầu
1. Vault tự init. **Ngay lập tức** chép unseal key và root token ra trình quản lý mật khẩu:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app --profile prod exec vault-init cat /vault/init/init.txt
   ```
   Mất cả volume `vaultinit` lẫn bản chép này = không giải mã được API key nào nữa; phải kết nối lại SoDEX cho mọi account.
2. Mở `https://<APP_HOST>`, đăng ký, bật 2FA, kết nối SoDEX, rồi mới tạo bot.

### 2.8 Telegram (DEC-170, docs/NOTIFICATIONS.md)
Bot `@desklabsbot` đã tạo (N0). Token và webhook secret chỉ nằm trong `/opt/drift/.env` (`chmod 600`). Không dán vào log, ticket, PR hay chat.

1. Điền vào `/opt/drift/.env`:
   - `DRIFT_TELEGRAM_BOT_TOKEN`: token BotFather đưa.
   - `DRIFT_TELEGRAM_WEBHOOK_SECRET`: tự sinh một lần bằng `openssl rand -hex 32`.
   - `DRIFT_TELEGRAM_BOT_USERNAME=desklabsbot`, `TELEGRAM_ENABLED=true`.
   - Tuỳ chọn: `TELEGRAM_BRIEF_ENABLED` (mặc định `true`) và `TELEGRAM_BRIEF_LLM` (mặc định `false`).
   - `DRIFT_TELEGRAM_API_ORIGIN` **để trống** ở production; biến này chỉ dùng cho E2E.
2. Khởi động lại hai service đọc các biến này:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app --profile prod up -d api jobs
   ```
3. Đăng ký webhook với Telegram (mỗi khi đổi tên miền hoặc secret). Lệnh đọc giá trị từ `.env` và không in token ra màn hình, lịch sử shell hay `ps`:
   ```bash
   cd /opt/drift
   val() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | tr -d '"'; }
   printf 'url = "https://api.telegram.org/bot%s/setWebhook"\n' "$(val DRIFT_TELEGRAM_BOT_TOKEN)" |
     curl -sS -K - \
       --data-urlencode "url=https://$(val APP_HOST)/api/v1/telegram/webhook" \
       --data-urlencode "secret_token=$(val DRIFT_TELEGRAM_WEBHOOK_SECRET)" \
       --data-urlencode 'allowed_updates=["message"]'
   # Kỳ vọng: {"ok":true,"result":true,"description":"Webhook was set"}
   ```
   Lưu ý: `secret_token` vẫn xuất hiện trong `ps` khoảng một giây khi lệnh chạy. VPS chỉ có user `deploy`, nên chấp nhận được.
4. Kiểm tra: `getWebhookInfo` trả `url`, `pending_update_count` và `last_error_message`, không chứa token.
   ```bash
   printf 'url = "https://api.telegram.org/bot%s/getWebhookInfo"\n' "$(val DRIFT_TELEGRAM_BOT_TOKEN)" | curl -sS -K -
   ```
   Rồi vào Settings › Notifications › Connect Telegram, bấm Start trong Telegram, rồi "Send a test".
5. **Đổi token** (BotFather › Revoke): sửa `.env`, chạy lại bước 2 và bước 3. **Đổi secret:** sửa `.env`, chạy bước 2 rồi bước 3 ngay. Giữa hai bước, webhook trả 401 và Telegram tự gửi lại update sau.
6. **Tắt khẩn cấp:** đặt `TELEGRAM_ENABLED=false`, rồi chạy bước 2. Route `/api/v1/telegram/*` trả 404, worker ngừng gửi; tin đang `queued` giữ nguyên.

### 2.9 MCP: OAuth (DEC-167, DEC-215)
Phần A1: authorization server OAuth nằm trong `api`. Service `apps/mcp` và host `mcp.desklabs.xyz` ở 2.10. Compose trên VPS do người dùng tự sửa, nên làm tay các bước sau:
1. `/opt/drift/.env`:
   - `MCP_INTROSPECT_SECRET`: sinh một lần bằng `openssl rand -hex 32`. Trống thì introspect tắt (MCP không hoạt động). Không dán vào log, ticket hay PR.
   - `MCP_PUBLIC_URL=https://mcp.desklabs.xyz` (mặc định).
   - Issuer OAuth lấy từ `DRIFT_APP_URL` (`https://<APP_HOST>`).
2. Service `api` trong compose của VPS:
   - thêm hai biến `MCP_PUBLIC_URL: ${MCP_PUBLIC_URL:-https://mcp.desklabs.xyz}` và `MCP_INTROSPECT_SECRET: ${MCP_INTROSPECT_SECRET:-}` (như `docker-compose.yml` của repo);
   - **đổi rule Traefik** của router `api` để metadata OAuth tới được api:
     ```yaml
     - traefik.http.routers.api.rule=Host(`${APP_HOST}`) && (PathPrefix(`/api`) || Path(`/.well-known/oauth-authorization-server`))
     ```
3. `docker compose run --rm migrate` (migration bảng `oauth_clients`, `oauth_codes`, `mcp_tokens`, `mcp_calls`), rồi `up -d api scheduler web`.
4. Kiểm tra: `curl -s https://<APP_HOST>/.well-known/oauth-authorization-server` trả JSON có `issuer`, `code_challenge_methods_supported: ["S256"]`.

### 2.10 MCP: service `mcp` (DEC-167, DEC-217)
Phần A2: `apps/mcp` (MCP Streamable HTTP, cổng 8097) ở `https://mcp.desklabs.xyz/mcp` (người dùng) và `/team/mcp` (team). Service chỉ gọi `api` (introspect token, ghi `mcp_calls`) và Redis (đếm rate limit); không chạm signer, engine, SoDEX hay Postgres. Làm 2.9 trước, rồi làm tay:
1. DNS: bản ghi **A** (và **AAAA** nếu có) `mcp.desklabs.xyz` trỏ về IP của VPS. Traefik tự xin cert Let's Encrypt (TLS-ALPN) cho host mới ở lần gọi đầu.
2. `/opt/drift/.env`:
   - `MCP_HOST=mcp.desklabs.xyz`: host Traefik của service `mcp`, phải khớp host của `MCP_PUBLIC_URL`.
   - `MCP_PUBLIC_URL`, `MCP_INTROSPECT_SECRET`: dùng chung với `api` (2.9). Secret trống thì service vẫn chạy, healthy, nhưng mọi lần gọi `/mcp` trả 503.
3. `docker-compose.yml` trên VPS, thêm service (như repo):
   ```yaml
   mcp:
     <<: *app
     build: { context: ., dockerfile: apps/mcp/Dockerfile }
     environment:
       NODE_ENV: ${NODE_ENV:-production}
       REDIS_URL: redis://redis:6379
       LOG_LEVEL: ${LOG_LEVEL:-info}
       MCP_PORT: "8097"
       API_INTERNAL_URL: http://api:8080
       MCP_PUBLIC_URL: ${MCP_PUBLIC_URL:-https://mcp.desklabs.xyz}
       DRIFT_APP_URL: https://${APP_HOST}
       MCP_INTROSPECT_SECRET: ${MCP_INTROSPECT_SECRET:-}
     depends_on:
       redis: { condition: service_healthy }
       api: { condition: service_healthy }
     labels:
       - traefik.enable=true
       - traefik.http.routers.mcp.rule=Host(`${MCP_HOST:-mcp.localhost}`)
       - traefik.http.services.mcp.loadbalancer.server.port=8097
       - traefik.docker.network=${COMPOSE_PROJECT_NAME:-drift-handoff}_edge
     networks: [edge, core]
     healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8097/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"], interval: 10s, retries: 5 }
   ```
   và trong `docker-compose.prod.yml`:
   ```yaml
   mcp:
     image: ${DRIFT_IMAGE}:mcp-${DRIFT_TAG}
     deploy: { replicas: 1 }
     labels:
       - traefik.http.routers.mcp.entrypoints=websecure
   ```
   Service không đọc biến nào khác của `x-app-env` (không có `DATABASE_URL`, key SoDEX hay key Claude).
   Trong service `api`, thêm router chặn route nội bộ từ ngoài (A3, DEC-219). apps/mcp gọi thẳng `http://api:8080`, không qua Traefik:
   ```yaml
   - traefik.http.routers.api-internal.rule=Host(`${APP_HOST}`) && (Path(`/api/v1/oauth/introspect`) || PathPrefix(`/api/v1/mcp/`))
   - traefik.http.routers.api-internal.priority=1000
   - traefik.http.routers.api-internal.service=api
   - traefik.http.routers.api-internal.middlewares=deny-external
   - traefik.http.middlewares.deny-external.ipallowlist.sourcerange=127.0.0.1/32
   ```
   và trong `docker-compose.prod.yml`, service `api`: `- traefik.http.routers.api-internal.entrypoints=websecure`.
4. Deploy bằng tag có image `mcp-<tag>` (từ release đầu tiên có A2), rồi kiểm tra:
   - `curl -s https://mcp.desklabs.xyz/.well-known/oauth-protected-resource/mcp` trả JSON có `resource: "https://mcp.desklabs.xyz/mcp"` và `authorization_servers: ["https://desklabs.xyz"]`;
   - `curl -si -X POST https://mcp.desklabs.xyz/mcp` trả `401` kèm header `WWW-Authenticate: Bearer scope="read", resource_metadata="…"`.
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://desklabs.xyz/api/v1/oauth/introspect` và `…/api/v1/mcp/calls` đều trả `403` (Traefik chặn).
5. Team dùng `/team/mcp` trong Claude Code (chỉ tài khoản role `team`): xem `docs/MCP.md` phụ lục A (`claude mcp add --transport http --scope user desklabs-team https://mcp.desklabs.xyz/team/mcp`, rồi `/mcp` › Authenticate).
6. Rate limit (đếm trong Redis, key `mcp:rl:*`): 60 lần/phút/token, 5.000 lần/ngày/người dùng, team 120 lần/phút. Vượt → 429.

### 2.11 Checklist bật MCP trên prod (gom từ 2.9 + 2.10)
Làm theo thứ tự, một lần. Mọi bước nằm ở 2.9 / 2.10; mục này chỉ để không sót.

**Trước khi deploy tag có `apps/mcp`:**
- [ ] DNS: bản ghi A (và AAAA nếu có) `mcp.desklabs.xyz` → IP VPS. Chờ DNS cập nhật.
- [ ] `/opt/drift/.env`:
  - [ ] `MCP_INTROSPECT_SECRET`: sinh một lần bằng `openssl rand -hex 32`. **Cùng một giá trị** cho `api` và `mcp` (cả hai đọc chung biến này từ `.env`). Không dán vào log, ticket hay PR.
  - [ ] `MCP_PUBLIC_URL=https://mcp.desklabs.xyz`
  - [ ] `MCP_HOST=mcp.desklabs.xyz` (phải khớp host của `MCP_PUBLIC_URL`)
- [ ] `docker-compose.yml` trên VPS:
  - [ ] service `api`: thêm `MCP_PUBLIC_URL`, `MCP_INTROSPECT_SECRET`; đổi rule router `api` có thêm `Path(`/.well-known/oauth-authorization-server`)` (2.9);
  - [ ] service `api`: thêm 5 label router `api-internal` + middleware `deny-external` (2.10 bước 3);
  - [ ] thêm service `mcp` (2.10 bước 3).
  - [ ] service `web`: thêm `MCP_PUBLIC_URL: ${MCP_PUBLIC_URL:-https://mcp.desklabs.xyz}` (trang `/claude` hiện địa chỉ `<MCP_PUBLIC_URL>/mcp`, #90). Thiếu thì trang dùng mặc định `https://mcp.desklabs.xyz/mcp`.
- [ ] `docker-compose.prod.yml` trên VPS: service `mcp` (image `mcp-${DRIFT_TAG}`, entrypoint `websecure`); service `api` thêm `traefik.http.routers.api-internal.entrypoints=websecure`.

**Deploy:**
- [ ] `infra/deploy/build-push.sh --deploy-only <tag>`. Script chạy migrate trước khi bật service: `0029_mcp_oauth`, `0030_adaptive_dca_for_all`, `0031_mcp_bot_drafts`. Lần này kéo cả 11 image (phần đầu Dockerfile đổi), lâu hơn bình thường.

**Kiểm tra sau deploy:**
- [ ] `curl -s https://desklabs.xyz/.well-known/oauth-authorization-server` → JSON có `"issuer":"https://desklabs.xyz"` và `"code_challenge_methods_supported":["S256"]`.
- [ ] `curl -s https://mcp.desklabs.xyz/.well-known/oauth-protected-resource/mcp` → `resource` = `https://mcp.desklabs.xyz/mcp`, `authorization_servers` = `["https://desklabs.xyz"]`. Lần gọi đầu có thể chậm vì Traefik xin cert.
- [ ] `curl -si -X POST https://mcp.desklabs.xyz/mcp` → `401` kèm `WWW-Authenticate: Bearer scope="read", resource_metadata="https://mcp.desklabs.xyz/.well-known/oauth-protected-resource/mcp"`.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://desklabs.xyz/api/v1/oauth/introspect` và `…/api/v1/mcp/calls`, `…/api/v1/mcp/me/bots` → `403` (Traefik chặn từ ngoài).
- [ ] `docker compose … ps mcp` → `healthy`.
- [ ] Mở `https://desklabs.xyz/claude`: địa chỉ server hiện đúng `https://mcp.desklabs.xyz/mcp`, nút Copy chép đúng chuỗi đó.
- [ ] Thử thật: thêm connector trong Claude (Customize › Connectors › + Add › Add custom connector, URL `https://mcp.desklabs.xyz/mcp`), Allow, hỏi "list my bots"; rồi Settings › Connected apps › Revoke và thấy Claude mất quyền ngay.

**Rollback:**
- Tắt MCP nhanh, không cần đổi image: để `MCP_INTROSPECT_SECRET=` trống trong `.env`, rồi `up -d api mcp`. `/mcp` trả 503, introspect của api tắt; mọi phần khác chạy như cũ. Token đã cấp không dùng được cho tới khi bật lại.
- Quay cả bản: `infra/deploy/build-push.sh --deploy-only <tag trước>`. Migration không quay lại; bảng MCP mới không ảnh hưởng bản cũ. `0030` đã bật Adaptive DCA cho mọi tài khoản: bản cũ đọc cùng cờ nên hành vi giống nhau; muốn tắt thì team tắt từng tài khoản ở Users.

### 2.12 SoDEX Debugger (DEC-309): bước làm tay khi release

Mọi app service gọi SoDEX ghi lời gọi vào `sodex_calls_ok` (3 ngày) / `sodex_calls_problem` (14 ngày), migration 0041 (`build-push.sh` tự chạy migrate). Mặc định **bật**. Công tắc tắt `SODEX_DEBUGGER` chỉ tới được container khi có trong file compose của VPS, mà file đó giữ tay, nên lần release đầu có tính năng này phải làm:

1. Trên VPS, sửa `/opt/drift/docker-compose.yml`: thêm vào khối biến môi trường dùng chung của app (`x-env: &env`, cạnh `SODEX_CHAIN`):
   ```yaml
     SODEX_DEBUGGER: ${SODEX_DEBUGGER:-on}
   ```
   Không thêm dòng này thì debugger vẫn chạy (mặc định bật) nhưng không tắt được.
2. Deploy như thường (`infra/deploy/build-push.sh --deploy` hoặc `--deploy-only <tag>`); bước `docker compose up -d` của script tạo lại container với biến mới.
3. Kiểm tra: `cd /opt/drift && docker compose exec engine printenv SODEX_DEBUGGER` phải in `on`.

**Tắt khẩn cấp** (không cần image mới): thêm `SODEX_DEBUGGER=off` vào `/opt/drift/.env`, rồi `cd /opt/drift && docker compose up -d` (chỉ tạo lại service có env đổi). Kiểm tra: `docker compose exec engine printenv SODEX_DEBUGGER` in `off`. Bật lại: xoá dòng đó (hoặc đặt `on`) rồi `docker compose up -d`.

Kết nối DB: mỗi process một kết nối client qua PgBouncer; mỗi batch là một transaction ngắn có `SET LOCAL statement_timeout = 3000` (PgBouncer transaction mode không nhận `statement_timeout` ở tham số khởi động). Trường hợp xấu nhất ~1 kết nối server × ≤ 3 s mỗi process khi DB chậm, sau đó recorder nghỉ dần tới 60 s. Dung lượng ước tính: xem PR #217.

### 2.13 Signal Analysis (#233): migration 0043 tạo index trên `orders`

Migration `0043_orders_bot_filled_idx` tạo index một phần `orders (bot_id, created_at) WHERE filled_size > 0`. Migrator của drizzle chạy mọi migration trong một transaction nên **không dùng được `CREATE INDEX CONCURRENTLY`** (như 0037); lệnh giữ khoá SHARE trên `orders` (chặn ghi, không chặn đọc) trong lúc build. Đo trên 1,31M lệnh (PR #246): **0,72 s**. Prod có bao nhiêu lệnh thì xem trước (`select count(*) from orders`); vài triệu lệnh vẫn ở mức vài giây, trong lúc đó engine ghi lệnh bị chờ. Deploy lúc ít bot chạy, hoặc tạo index tay trước khi deploy để migration chỉ còn `IF NOT EXISTS`:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_bot_filled_idx" ON "orders" USING btree ("bot_id","created_at") WHERE "orders"."filled_size" > 0;
```

`CREATE INDEX CONCURRENTLY` lỗi hoặc bị huỷ giữa chừng thì để lại một index **INVALID** cùng tên; `IF NOT EXISTS` (cả lệnh tay lẫn migration) sẽ bỏ qua nó và index không bao giờ được dùng. Sau lệnh tay, luôn kiểm tra:

```sql
select indisvalid from pg_index where indexrelid = 'orders_bot_filled_idx'::regclass;
```

Ra `false` thì xoá rồi chạy lại lệnh tạo:

```sql
DROP INDEX CONCURRENTLY IF EXISTS orders_bot_filled_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_bot_filled_idx" ON "orders" USING btree ("bot_id","created_at") WHERE "orders"."filled_size" > 0;
```

Ra `true` thì deploy như thường (migration 0043 không làm gì).

### 2.14 Retention snapshot (#229): index trên `bot_events` và `orders` do scheduler tự tạo

Không cần bước tay khi deploy. Job retention của scheduler (leader, vòng 10 phút; lượt đầu 10 phút sau khi scheduler giành lease) cần hai index một phần: `bot_events_signal_idx (occurred_at) WHERE payload ? 'signal'` và `orders_context_created_idx (created_at) WHERE context IS NOT NULL`. Không có migration nào tạo chúng (migrator chạy trong transaction nên chỉ tạo được bằng CREATE INDEX thường, chặn ghi của engine suốt lúc build). Job tự tạo bằng `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, ngoài transaction, một lần: không chặn ghi hay đọc, chỉ mất thời gian quét bảng. Trước mỗi lượt job kiểm `pg_index.indisvalid`; index INVALID (build bị huỷ, ví dụ scheduler restart giữa chừng) thì job `DROP INDEX CONCURRENTLY` và lượt sau tạo lại. Job chỉ dọn dòng khi cả hai index hợp lệ.

Log của scheduler: `signal snapshot index created` khi tạo xong, `invalid signal snapshot index dropped, rebuilt next run` khi bỏ index INVALID, `old signal snapshots stripped` khi có dòng được dọn, `signal snapshot retention failed` khi một lượt lỗi (lượt sau tự thử lại). Kiểm tay nếu cần:

```sql
select c.relname, i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid
 where c.relname in ('bot_events_signal_idx', 'orders_context_created_idx');
```

## 3. Deploy hằng ngày
1. PR merge vào `main`, CI xanh.
2. Người dùng gõ "release" cho PM → PM tạo tag `vX.Y.Z` → `release.yml` build + push 11 image → PM trả tag (`docs/RELEASE.md`).
3. Người dùng deploy: `infra/deploy/build-push.sh --deploy-only vX.Y.Z` (rollback: cùng lệnh với tag cũ).

Build từ máy mình, không qua GitHub (máy đã `docker login` bằng token `drift-push`):
```bash
DRIFT_IMAGE=docker.io/<user>/drift infra/deploy/build-push.sh deploy@<IP>
```
Script tự về gốc repo, đọc `WALLETCONNECT_PROJECT_ID` từ `.env`, gắn 2 tag `<app>-<sha>` và `<app>-latest`. Chỉ build vài app: `infra/deploy/build-push.sh web api`. VPS ARM thì thêm `PLATFORM=linux/arm64` (máy x86 phải giả lập QEMU, chậm).

Deploy từ máy mình (thay cho làm tay `ssh` → sửa `DRIFT_TAG` → `migrate` → `pull` / `up -d`):

```bash
infra/deploy/build-push.sh --deploy engine web     # build 2 app, 8 app còn lại giữ image đang chạy
infra/deploy/build-push.sh --deploy                # build cả 11 app rồi deploy
infra/deploy/build-push.sh --deploy-only <tag>     # không build: deploy (hoặc rollback về) một tag đã push
```

- Máy đích mặc định `root@149.28.148.63` (đổi bằng `DEPLOY_TARGET` hoặc `--deploy user@host`). SSH hỏi mật khẩu một lần, trước khi build; rsync và deploy dùng lại kết nối. Muốn khỏi gõ: `ssh-copy-id root@149.28.148.63`, hoặc để `DEPLOY_SSH_PASS=...` trong `infra/deploy/.deploy.local` (đã gitignore, cần `brew install sshpass`).
- Chỉ build vài app: script đọc `DRIFT_TAG` đang chạy trên VPS và gắn tag mới cho các app không build, trỏ vào đúng image đang chạy (chép trên registry, không build lại), vì compose dùng một `DRIFT_TAG` chung.
- Trên VPS (`/opt/drift`, chỉ một `docker-compose.yml`), script chạy đúng các bước làm tay: đổi `DRIFT_TAG` trong `.env` → `docker compose pull` → `docker compose run --rm migrate` → `docker compose up -d` → xoá image `DRIFT_IMAGE` **không** thuộc tag hiện tại hay tag liền trước, rồi `docker image prune -f` (layer treo). Không đụng image hạ tầng, không `docker system prune -af` nữa: rollback một bản không phải tải lại, và layer chung của bản mới không bị xoá (DEC-214). Không chép compose của repo lên VPS. Dọn image sau cùng, để pull / migrate lỗi thì bản đang chạy vẫn còn.

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
- Volume `mmraw` (DEC-228): `marketdata` (bản leader) ghi thô bookTicker + trade của khoảng 30 market Perps ra
  `/home/node/mm-raw/YYYY-MM-DDTHH.ndjson.gz` (giờ UTC), tự xoá file quá 48 giờ. Ước khoảng 85 MB / ngày (đo 2026-11-14:
  ~2,8 triệu bản ghi / ngày), tức dưới 200 MB lúc đầy. Không cần backup (dữ liệu dựng lại được). Đọc thử:
  `docker compose exec marketdata sh -c 'zcat /home/node/mm-raw/$(date -u +%Y-%m-%dT%H).ndjson.gz | tail -3'`. Tắt bằng
  cách đặt `MM_RAW_DIR=` (trống).
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
