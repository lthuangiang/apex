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

### 2.4 Compose, `.env` và cert mTLS trên VPS
Prod chạy một file `/opt/drift/docker-compose.yml` (mục 1). Máy mới thì chép mẫu một file của repo cùng mẫu `.env`, rồi điền:
```bash
scp deploy/server/docker-compose.yml .env.production.example deploy@<IP>:/opt/drift/
ssh deploy@<IP>
cd /opt/drift
mv .env.production.example .env
nano .env && chmod 600 .env
```
Giá trị phải tự sinh (mỗi cái một lần, không đổi về sau):
- `POSTGRES_PASSWORD`, `SIGNER_DB_PASSWORD`: `openssl rand -hex 24`
- `API_TOTP_ENC_KEY`: `openssl rand -base64 32`
- `VAULT_TOKEN` (token của signer): `openssl rand -hex 24`
- `DRIFT_IMAGE`: `docker.io/<user-docker-hub>/drift`. `APP_HOST`: tên miền. `ACME_EMAIL`: email nhận cảnh báo chứng chỉ.
- `DRIFT_TAG`: để trống. `build-push.sh` ghi tag mỗi lần deploy (mục 3) và đọc nó để biết tag đang chạy.
- `SMTP_URL`, `MAIL_FROM`: nhà cung cấp email thật (OTP đăng nhập đi qua email).
- `DRIFT_BUILDER_ID`, `DRIFT_BUILDER_ADDRESS`: như máy dev.
- `DESK_AI_API_KEY` (tuỳ chọn, DEC-165): key Claude API tạo ở Claude Console (tài khoản trả theo token của DeskLabs, không phải gói Claude cá nhân). Chỉ service `api` đọc. Để trống thì Desk AI chạy bằng câu mẫu. Đổi key: sửa `.env` rồi `cd /opt/drift && docker compose up -d api`. Không dán key vào log, ticket hay PR. Biến này chỉ tới container khi service `api` trong compose của VPS có dòng `DESK_AI_API_KEY: ${DESK_AI_API_KEY:-}`.

Mẫu compose đặt `name: drift`, nên network Traefik là `drift_edge`. `build-push.sh` chỉ đổi `DRIFT_TAG` trong `.env`; biến hay service mới phải tự thêm vào `/opt/drift/docker-compose.yml` theo ghi chú release (ví dụ 2.10, 2.12).

Cert mTLS (api / engine ↔ signer) do service `certs` của compose tự tạo ở lần `up` đầu, lưu trong volume `certs`, hạn 1095 ngày (3 năm); lần sau thấy đủ file thì bỏ qua. Không cần chạy `gen-dev-certs.sh` (dòng `CERT_DAYS=… gen-dev-certs.sh /opt/drift/certs` và `SIGNER_CERTS_DIR` trong `.env.production.example` là của cách cũ). Đặt lịch nhắc tạo lại trước ngày hết hạn (signer từ chối mọi kết nối khi cert hết hạn → bot pause `API_KEY_UNUSABLE`). Tạo lại:
```bash
cd /opt/drift
docker compose run --rm --entrypoint sh certs -c 'rm -f /certs/*'
docker compose run --rm certs
docker compose up -d --force-recreate signer api engine
```

Lần deploy đầu (cần `/opt/drift/.env`, script kiểm tra): `infra/deploy/build-push.sh --deploy-only vX.Y.Z` với tag release đã có, hoặc `infra/deploy/build-push.sh --deploy` để build cả 11 app (VPS chưa có `DRIFT_TAG` thì script không cho build vài app). Bước `docker compose up -d` của script tự chạy `certs`, init Vault và migration.

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
3. `/opt/drift/docker-compose.yml` (một file, mục 1; image và entrypoint `websecure` nằm ngay trong service, không còn `docker-compose.prod.yml`), thêm service:
   ```yaml
   mcp:
     <<: *app
     image: ${DRIFT_IMAGE:-docker.io/lthuangiang/drift}:mcp-${DRIFT_TAG:-latest}
     environment:
       NODE_ENV: production
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
       - traefik.http.routers.mcp.rule=Host(`${MCP_HOST:-mcp.desklabs.xyz}`)
       - traefik.http.routers.mcp.entrypoints=websecure
       - traefik.http.services.mcp.loadbalancer.server.port=8097
       - traefik.docker.network=drift_edge
     networks: [edge, core]
     healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8097/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"], interval: 10s, retries: 5 }
   ```
   Service không đọc biến nào khác của `x-env` (không có `DATABASE_URL`, key SoDEX hay key Claude).
   Trong service `api`, thêm router chặn route nội bộ từ ngoài (A3, DEC-219). apps/mcp gọi thẳng `http://api:8080`, không qua Traefik:
   ```yaml
   - traefik.http.routers.api-internal.rule=Host(`${APP_HOST}`) && (Path(`/api/v1/oauth/introspect`) || PathPrefix(`/api/v1/mcp/`))
   - traefik.http.routers.api-internal.priority=1000
   - traefik.http.routers.api-internal.entrypoints=websecure
   - traefik.http.routers.api-internal.service=api
   - traefik.http.routers.api-internal.middlewares=deny-external
   - traefik.http.middlewares.deny-external.ipallowlist.sourcerange=127.0.0.1/32
   ```
4. Deploy bằng tag có image `mcp-<tag>` (từ release đầu tiên có A2): `infra/deploy/build-push.sh --deploy-only <tag>`. Bước `docker compose up -d` của script tạo service `mcp` và tạo lại `api` với label mới. Rồi kiểm tra:
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
- [ ] `/opt/drift/docker-compose.yml` (file duy nhất trên VPS):
  - [ ] service `api`: thêm `MCP_PUBLIC_URL`, `MCP_INTROSPECT_SECRET`; đổi rule router `api` có thêm `Path(`/.well-known/oauth-authorization-server`)` (2.9);
  - [ ] service `api`: thêm 6 label của router `api-internal` (có `entrypoints=websecure`) và middleware `deny-external` (2.10 bước 3);
  - [ ] thêm service `mcp` (image `mcp-${DRIFT_TAG}`, entrypoint `websecure`; 2.10 bước 3).
  - [ ] service `web`: thêm `MCP_PUBLIC_URL: ${MCP_PUBLIC_URL:-https://mcp.desklabs.xyz}` (trang `/claude` hiện địa chỉ `<MCP_PUBLIC_URL>/mcp`, #90). Thiếu thì trang dùng mặc định `https://mcp.desklabs.xyz/mcp`.
- [ ] Kiểm tra file trước khi deploy: `cd /opt/drift && docker compose config --quiet` (không in gì là hợp lệ).

**Deploy:**
- [ ] `infra/deploy/build-push.sh --deploy-only <tag>`. Script chạy migrate trước khi bật service: `0029_mcp_oauth`, `0030_adaptive_dca_for_all`, `0031_mcp_bot_drafts`. Lần này kéo cả 11 image (phần đầu Dockerfile đổi), lâu hơn bình thường.

**Kiểm tra sau deploy:**
- [ ] `curl -s https://desklabs.xyz/.well-known/oauth-authorization-server` → JSON có `"issuer":"https://desklabs.xyz"` và `"code_challenge_methods_supported":["S256"]`.
- [ ] `curl -s https://mcp.desklabs.xyz/.well-known/oauth-protected-resource/mcp` → `resource` = `https://mcp.desklabs.xyz/mcp`, `authorization_servers` = `["https://desklabs.xyz"]`. Lần gọi đầu có thể chậm vì Traefik xin cert.
- [ ] `curl -si -X POST https://mcp.desklabs.xyz/mcp` → `401` kèm `WWW-Authenticate: Bearer scope="read", resource_metadata="https://mcp.desklabs.xyz/.well-known/oauth-protected-resource/mcp"`.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://desklabs.xyz/api/v1/oauth/introspect` và `…/api/v1/mcp/calls`, `…/api/v1/mcp/me/bots` → `403` (Traefik chặn từ ngoài).
- [ ] `cd /opt/drift && docker compose ps mcp` → `healthy`.
- [ ] Mở `https://desklabs.xyz/claude`: địa chỉ server hiện đúng `https://mcp.desklabs.xyz/mcp`, nút Copy chép đúng chuỗi đó.
- [ ] Thử thật: thêm connector trong Claude (Customize › Connectors › + Add › Add custom connector, URL `https://mcp.desklabs.xyz/mcp`), Allow, hỏi "list my bots"; rồi Settings › Connected apps › Revoke và thấy Claude mất quyền ngay.

**Rollback:**
- Tắt MCP nhanh, không cần đổi image: để `MCP_INTROSPECT_SECRET=` trống trong `/opt/drift/.env`, rồi `cd /opt/drift && docker compose up -d api mcp`. `/mcp` trả 503, introspect của api tắt; mọi phần khác chạy như cũ. Token đã cấp không dùng được cho tới khi bật lại.
- Quay cả bản: `infra/deploy/build-push.sh --deploy-only <tag trước>` (mục 3). Migration không quay lại; bảng MCP mới không ảnh hưởng bản cũ. `0030` đã bật Adaptive DCA cho mọi tài khoản: bản cũ đọc cùng cờ nên hành vi giống nhau; muốn tắt thì team tắt từng tài khoản ở Users. Tag cũ không có image `mcp-<tag>` (trước A2) thì `docker compose pull` lỗi và script dừng: container đang chạy giữ nguyên nhưng `DRIFT_TAG` trong `.env` đã đổi; bỏ (hoặc comment) service `mcp` trong `/opt/drift/docker-compose.yml` rồi chạy lại lệnh.

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

### 2.14 Retention snapshot (#229, #259): index trên `bot_events` và `orders` do scheduler tự tạo

Không cần bước tay khi deploy. Job retention của scheduler (leader, vòng 10 phút; lượt đầu 10 phút sau khi scheduler giành lease) bỏ `bot_events.payload.signal` (Volume Farm), `bot_events.payload.quote` (snapshot báo giá Market Making, DEC-312, thêm ở #259) và `orders.context` sau 45 ngày (`SIGNAL_SNAPSHOT_RETENTION_DAYS`, hằng trong code, không có biến môi trường). Job cần ba index một phần: `bot_events_signal_idx (occurred_at) WHERE payload ? 'signal'`, `bot_events_quote_idx (occurred_at) WHERE payload ? 'quote'` và `orders_context_created_idx (created_at) WHERE context IS NOT NULL`. Bản đầu có #259: lượt đầu tạo `bot_events_quote_idx` (quét `bot_events` một lần, không chặn ghi), lượt sau mới bắt đầu bỏ `quote` cũ, tối đa 100 000 dòng / lượt. Không có migration nào tạo chúng (migrator chạy trong transaction nên chỉ tạo được bằng CREATE INDEX thường, chặn ghi của engine suốt lúc build). Job tự tạo bằng `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, ngoài transaction, một lần: không chặn ghi hay đọc, chỉ mất thời gian quét bảng. Trước mỗi lượt job kiểm `pg_index.indisvalid`; index INVALID (build bị huỷ, ví dụ scheduler restart giữa chừng) thì job `DROP INDEX CONCURRENTLY` và lượt sau tạo lại. Job chỉ dọn dòng khi mọi index hợp lệ.

Log của scheduler: `signal snapshot index created` khi tạo xong, `invalid signal snapshot index dropped, rebuilt next run` khi bỏ index INVALID, `old signal snapshots stripped` khi có dòng được dọn, `signal snapshot retention failed` khi một lượt lỗi (lượt sau tự thử lại). Kiểm tay nếu cần:

```sql
select c.relname, i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid
 where c.relname in ('bot_events_signal_idx', 'bot_events_quote_idx', 'orders_context_created_idx');
```

### 2.15 Signal research, lane tin tức (#271, DEC-322): bật trên prod

Migration `0044_signal_research` (đã sửa tại chỗ trong PR #278 trước khi deploy: máy local đã chạy bản 0044 cũ phải `drop table signal_articles, signal_events, signal_paper_trades, signal_research_usage, signal_source_health, signal_stories;` và xoá dòng 0044 trong `drizzle.__drizzle_migrations` rồi migrate lại) chỉ tạo bảng mới (`build-push.sh` tự chạy migrate), không khoá bảng đang dùng. Lane chạy trong `scheduler` (leader), mặc định **tắt**, không bao giờ gửi gì tới SoDEX. Biến môi trường chỉ tới container khi có trong compose giữ tay của VPS, nên lần release đầu phải làm:

1. Trong `/opt/drift/.env` thêm key (không dán vào log, ticket hay PR): `SOSO_API_KEY=…`. `DESK_AI_API_KEY` đã có (Desk AI) thì dùng chung.
2. Trong `/opt/drift/docker-compose.yml`, cho **riêng service `scheduler`** một khối `environment` (để key SoSoValue / Claude chỉ tới scheduler, không tới mọi service qua `x-env`):
   ```yaml
     scheduler:
       <<: *app
       image: ${DRIFT_IMAGE:-docker.io/lthuangiang/drift}:scheduler-${DRIFT_TAG:-latest}
       environment:
         <<: *env
         SIGNAL_RESEARCH_ENABLED: ${SIGNAL_RESEARCH_ENABLED:-false}
         SOSO_API_KEY: ${SOSO_API_KEY:-}
         DESK_AI_API_KEY: ${DESK_AI_API_KEY:-}
         SIGNAL_CLAUDE_DAILY_INPUT_TOKENS: ${SIGNAL_CLAUDE_DAILY_INPUT_TOKENS:-2000000}
         SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE: ${SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE:-50}
         SIGNAL_SOSO_MONTHLY_LIMIT: ${SIGNAL_SOSO_MONTHLY_LIMIT:-9500}
         SIGNAL_SOSO_MAX_PAGES: ${SIGNAL_SOSO_MAX_PAGES:-2}
         SIGNAL_NEWS_START_LOOKBACK_MIN: ${SIGNAL_NEWS_START_LOOKBACK_MIN:-15}
         SIGNAL_NEWS_MAX_CATCHUP_MIN: ${SIGNAL_NEWS_MAX_CATCHUP_MIN:-30}
         SIGNAL_NEWS_CYCLE_MINUTES: ${SIGNAL_NEWS_CYCLE_MINUTES:-5}
   ```
   `NATS_URL` đã có trong `x-env`: scheduler dùng nó để nghe `md.*.book` (chỉ đọc). Thiếu NATS thì lane chỉ dùng giá Redis + spread theo giờ.
3. Deploy như thường (flag vẫn `false`). **Lần bật đầu tiên**, trước khi bật flag: đo kích thước prefix được cache bằng `cd /opt/drift && docker compose exec scheduler pnpm --filter @drift/scheduler signals:once -- --cycles 1` (`countTokens` miễn phí; chạy một chu kỳ thật: chỉ ghi bảng `signal_*`, lệnh nếu có là lệnh giấy, không gửi gì tới SoDEX). Log `claude cached prefix tokens (countTokens)` có `prefixPlusMinimalUser` (phải ≥ 4 096 thì Haiku 4.5 mới cache); ghi số này vào DEC-322 (chỗ "chưa đo"). Rồi bật: đặt `SIGNAL_RESEARCH_ENABLED=true` trong `/opt/drift/.env`, `cd /opt/drift && docker compose up -d scheduler`.
4. Kiểm tra: log scheduler có `signal research enabled` (kèm `cycleMinutes`), rồi mỗi chu kỳ (`SIGNAL_NEWS_CYCLE_MINUTES`, mặc định 5 phút) một dòng `signal research news cycle` (bài lấy về / lưu / phân loại / bỏ theo lý do, token Claude hôm nay). `signal research not started` kèm `reason` = thiếu key. Lần chạy đầu chỉ nhận tin trong 15 phút gần nhất; phần còn lại của trang lưu thô với lý do `BACKLOG_NOT_CLASSIFIED`.
   - Lúc nhận lease scheduler đọc danh sách market SoDEX một lần; chưa đọc được thì log `SoDEX market list not known yet, collect only` và chu kỳ chỉ thu bài (bài được xử lý ở chu kỳ sau).
   - **Prompt cache:** lần gọi Claude đầu mỗi ngày log `signal research claude cache check` (`cachedPrefixTokens` phải ≥ 4 096). Có `signal research claude prompt cache is not being read` thì cache không hoạt động: báo team. Kiểm thêm sau khoảng một giờ: `select day, claude_calls, claude_cache_read_tokens from signal_research_usage order by day desc limit 2;` phải có `claude_cache_read_tokens > 0`.
   - Hết hạn mức SoSoValue tháng thì log `sosovalue unavailable` với `monthly_quota`, tab hiện nguồn "Delayed"; scheduler vẫn chạy bình thường.
   - **Giới hạn tốc độ SoSoValue (#394):** 20 request / phút theo key. Scheduler tự chặn ở 20 request / phút trượt (đếm cả trang sau). Gặp HTTP 429 hoặc `code` 42901 thì log `sosovalue rate limited, waiting for the next cycle`, `signal_source_health.last_error = rate_limited`, tab hiện nguồn "Delayed"; chu kỳ đó không lưu bài nào và con trỏ không tiến, chu kỳ sau thử lại (không mất bài).
   - Giá trị `SIGNAL_*` sai: flag tắt thì chỉ log `signal research env` (cảnh báo), flag bật thì `signal research not started` kèm lý do; scheduler không bao giờ dừng vì env của lane này.
5. Báo cáo: `cd /opt/drift && docker compose exec scheduler pnpm --filter @drift/scheduler signals:report` (thêm `-- --json` để lấy JSON; chỉ đọc), hoặc `GET /api/v1/admin/signal-research/summary` bằng tài khoản team.

**Tắt khẩn cấp:** `SIGNAL_RESEARCH_ENABLED=false` trong `/opt/drift/.env` rồi `docker compose up -d scheduler`. Lệnh giấy đang mở giữ nguyên trong DB; bật lại thì watcher kiểm TP / SL tiếp, còn tin trong lúc tắt không được bắt kịp quá 30 phút. Ngân sách Claude hết trong ngày thì lane tự ngừng phân loại (`CLAUDE_BUDGET_REACHED`) tới 00:00 UTC.

### 2.16 Checklist đưa Signal research lên prod (v2.13.0)

Gom mọi việc cho lần release đầu tiên có Signal research: **v2.13.0** (từ v2.12.0 tới #369, migration `0044`–`0052`; release notes `docs/releases/v2.13.0.md`). Mục 2.15 là chi tiết của lane tin tức; mục này là danh sách để làm theo thứ tự. **Không bao giờ dán giá trị key vào đây, vào log, ticket hay PR**: người dùng tự điền trong `/opt/drift/.env`.

**1. Biến môi trường** (`/opt/drift/.env`, rồi khai báo trong `/opt/drift/docker-compose.yml` như khối `scheduler` của mẫu `deploy/server/docker-compose.yml`; compose trên VPS giữ tay nên biến chưa khai báo sẽ không tới container):

| Biến | Service | Ý nghĩa |
|---|---|---|
| `SIGNAL_RESEARCH_ENABLED` | scheduler | Bật lane tin tức (`true` / `1`). Mặc định `false`. Đây cũng là công tắc tắt nhanh |
| `SOSO_API_KEY` | scheduler | Key SoSoValue OpenAPI (bắt buộc khi bật). Thiếu thì log `signal research not started` |
| `DESK_AI_API_KEY` | scheduler, api | Key Claude API (Claude Console), dùng chung với Desk AI. Thiếu thì lane không chạy |
| `NATS_URL` | scheduler | Có sẵn trong `x-env` (`nats://nats:4222`). Scheduler nghe `md.*.book` (chỉ đọc) để có giá tốt nhất; thiếu thì chỉ dùng giá Redis |
| `SIGNAL_CLAUDE_DAILY_INPUT_TOKENS` | scheduler | Ngân sách Claude mỗi ngày UTC, đơn vị token đầu vào quy đổi (mặc định `2000000` ≈ 2 USD/ngày). Hết thì ngừng phân loại tới 00:00 UTC |
| `SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE` | scheduler | Trần lần gọi Claude mỗi 5 phút, kể cả thử lại (mặc định `50`). Chu kỳ ngắn hơn chia theo tỷ lệ (#394: chu kỳ 1 phút → 10 mỗi chu kỳ), nên số lần gọi mỗi giờ không đổi |
| `SIGNAL_SOSO_MONTHLY_LIMIT` | scheduler | Trần request SoSoValue mỗi tháng (mặc định `9500`, gói free 10 000). **Không tự nâng.** Chu kỳ 5 phút ≈ 8 900 request / tháng; chu kỳ 1 phút ≈ 45 000 request / tháng, cần đặt khoảng `60000`. Chỉ nâng khi người dùng đã xác nhận quota thật của key trên dashboard SoSoValue (tài liệu ghi 100 000 / tháng theo key). Không xoay vòng nhiều key để vượt quota. Trần thấp hơn nhu cầu của chu kỳ thì scheduler log cảnh báo lúc khởi động, và khi chạm trần nguồn hiện "Delayed" (`monthly_quota`) |
| `SIGNAL_SOSO_MAX_PAGES` | scheduler | Số trang tin tối đa mỗi chu kỳ (mặc định `2`, tối đa `5`). Chu kỳ ≥ 1 phút nên ≤ 5 request / phút, dưới trần 20 / phút của SoSoValue; scheduler vẫn tự chặn ở 20 |
| `SIGNAL_NEWS_CYCLE_MINUTES` | scheduler | **Mới (#394).** Chu kỳ Collect → Decide, số nguyên phút `1`–`5`, mặc định `5`. Sai giá trị thì dùng `5` và log cảnh báo `signal research env` (lane và scheduler vẫn chạy). Scheduler ghi chu kỳ đang dùng vào Redis `sr:lane`, api đọc từ đó (api **không** cần biến này). Chạy `1` thì phải nâng `SIGNAL_SOSO_MONTHLY_LIMIT` (xem dưới) |
| `SIGNAL_NEWS_START_LOOKBACK_MIN` | scheduler | Lần chạy đầu chỉ nhận tin trong ngần này phút (mặc định `15`) |
| `SIGNAL_NEWS_MAX_CATCHUP_MIN` | scheduler | Sau thời gian ngừng, không bắt kịp quá ngần này phút (mặc định `30`) |
| `COPY_LEADERBOARD_ENABLED`, `COPY_LEADERBOARD_HOUR_UTC` | scheduler | Không mới. **COPY_LEADERBOARD_ENABLED=true để research wallets có dữ liệu.** H1 · Whales agree chỉ có số khi leaderboard Hyperliquid được tính (DEC-163); tắt thì không có bộ research wallets mới và H1 của mọi tín hiệu là "Not available" (0 ví được kiểm) |
| `MCP_PUBLIC_URL`, `MCP_INTROSPECT_SECRET` | api | Không mới (DEC-167, mục 2.9), nhưng mẫu compose trước đây thiếu ở `api`. Gốc URL của `apps/mcp` và secret introspect nội bộ (người dùng tự điền); secret trống = MCP tắt |
| `SIGNAL_RESEARCH_WALLETS_K` | scheduler | Số ví nghiên cứu K (top-K tab Top của leaderboard) cho H1 context-v2 (#353 / #365): mặc định `30`, tối đa `40`, `0` = tắt; giá trị sai thì dùng `30`. Chỉ `scheduler` đọc biến này (scheduler chụp bộ ví vào DB theo phiên bản; marketdata poll theo bộ đã lưu), nên compose chỉ cần biến ở `scheduler` |
| `SIGNAL_NEWS_PUBLISH_ENABLED` | scheduler | **Mới (#419 PR 4).** Ghi tín hiệu dùng chung cho bot `news_signal` mainnet vào `news_signals` (migration `0059`), rồi phát chuông NATS `sr.signal.new` (payload `{ "id" }`). Mặc định `false`; chỉ có tác dụng khi lane chạy (`SIGNAL_RESEARCH_ENABLED`). Không đổi gì của research versions / My versions. NATS lỗi thì chỉ log (engine vẫn đọc bảng). Chưa có engine nối tín hiệu (PR engine sau), nên bật lúc này chỉ ghi bảng |

Không có biến mới cho `api` hay `marketdata` từ v2.12.0 (đã grep zod env của `scheduler`, `api`, `marketdata`, `engine`). `DESK_AI_API_KEY`, `MCP_PUBLIC_URL`, `MCP_INTROSPECT_SECRET` của `api` là biến cũ; kiểm chúng đã có trong khối `api` của compose trên VPS.

**2. Migration mới** (`build-push.sh` tự chạy `migrate`; đều tương thích ngược, chỉ thêm bảng / cột):

| File | Nội dung |
|---|---|
| `0044_signal_research` | Bảng `signal_articles`, `signal_events`, `signal_stories`, `signal_paper_trades`, `signal_research_usage`, `signal_source_health` |
| `0045_sr_article_usage` | Cột usage Claude theo bài trên `signal_articles` (nullable, chỉ sửa metadata) |
| `0046_sr_asset_map_version` | Cột `signal_paper_trades.asset_map_version` |
| `0047_sr_bot_versions` | Bảng News bot versions, seed version Baseline, gắn lệnh / story / event news-v3 vào Baseline (UPDATE trên các bảng `signal_*`, nhỏ) |
| `0048_sr_classification_labels` | Bảng `signal_classification_labels` |
| `0049_api_idempotency_outcome` | Cột `idempotency_keys.outcome`, `error_code` (nullable). Không thuộc Signal research (#316) |
| `0050_sr_label_source` | Bảng `signal_label_tokens`, cột nguồn nhãn (nhãn cũ nhận `trace` qua DEFAULT) |
| `0051_sr_signal_contexts` | Bảng `signal_contexts` (trigger chặn UPDATE), cột `leader_wallets.last_polled_at` |
| `0052_sr_research_wallets` | Bảng `research_wallet_sets`, `research_wallet_set_members`; cột `signal_contexts.h1_wallet_set_version`, `h1_wallet_set_size` (nullable) |

> **v2.14.0** (từ v2.13.0) có thêm migration `0053`–`0056`: `0053_sr_context_wallet_addresses`, `0054_sr_latency_clocks`, `0055_sr_market_state`, `0056_sr_experiments`. Cả bốn đều tương thích ngược. Không có biến môi trường mới. Khi deploy: pull image, chạy `migrate` như thường, rồi `up -d`. Xem `docs/releases/v2.14.0.md`.

> **v2.15.0** (#394, `docs/releases/v2.15.0.md`): biến mới `SIGNAL_NEWS_CYCLE_MINUTES` chỉ cho `scheduler` (mặc định `5`, giữ nguyên nhịp cũ). Thêm dòng `SIGNAL_NEWS_CYCLE_MINUTES: ${SIGNAL_NEWS_CYCLE_MINUTES:-5}` vào khối `environment` của `scheduler` trong `/opt/drift/docker-compose.yml` (như mẫu `deploy/server/docker-compose.yml`). Không có migration. Muốn chạy 1 phút: đặt `SIGNAL_NEWS_CYCLE_MINUTES=1` **và** nâng `SIGNAL_SOSO_MONTHLY_LIMIT` lên khoảng `60000` trong `/opt/drift/.env`, nhưng chỉ sau khi người dùng xác nhận quota thật của key; rồi `docker compose up -d scheduler`.

> **v2.15.0 có Claude reader v4 + Rules v4 (#395):** không có migration, không có biến môi trường mới. Sau deploy, chu kỳ tin đầu tiên chuyển bài news-v3 còn `collected` / `pending` sang news-v4 (log `signal research: in-flight articles moved to current rules`, chỉ khi có bài) và ghi mốc `signal_classifier_versions.started_at` của `news-classifier-v4`. Tổng kết, nhãn và cổng đếm lại từ 0; lệnh news-v3 đang mở vẫn được watcher đóng như cũ. Kiểm (chỉ đọc): `select rule_version, status, count(*) from signal_articles where status in ('collected', 'pending') group by 1, 2;` chỉ còn news-v4.

**3. Service cần pull lại:** cả 11 app. `infra/deploy/changed-apps.sh v2.12.0 <tag mới>` trả cả 11 vì `packages/**` đổi (shared, db). `build-push.sh --deploy-only <tag>` đã pull và `up -d` hết; không cần chọn tay.

**4. Thứ tự làm:**
1. Thêm biến vào `/opt/drift/.env` (key do người dùng tự điền) và khối `environment` của `scheduler` (và `DESK_AI_API_KEY` của `api` nếu chưa có) vào `/opt/drift/docker-compose.yml`. Kiểm: `cd /opt/drift && docker compose config --quiet`.
2. Deploy với flag vẫn `false`: `infra/deploy/build-push.sh --deploy-only <tag>`.
3. Đo prefix cache một lần (mục 2.15 bước 3), rồi bật: `SIGNAL_RESEARCH_ENABLED=true` trong `/opt/drift/.env`, `cd /opt/drift && docker compose up -d scheduler`.
4. Chạy phần kiểm sau deploy (bên dưới) sau khoảng 15–30 phút.

**5. Tắt nhanh** (không cần image mới): `SIGNAL_RESEARCH_ENABLED=false` trong `/opt/drift/.env`, rồi `cd /opt/drift && docker compose up -d scheduler`. Lệnh giấy đang mở giữ nguyên trong DB; không có gì gửi tới SoDEX ở bất kỳ trạng thái nào.

**6. Chi phí Claude (ước tính, không phải số đo trên prod):** theo số liệu máy local ngày 2026-11-19 (277 lượt Claude; token đầu vào 165 623, ghi cache 30 236, đọc cache 1 480 646, đầu ra 30 187) và giá niêm yết Haiku 4.5 trong `NEWS_CLASSIFIER.pricing` (đầu vào 1 USD / 1M, ghi cache TTL 1 giờ 2×, đọc cache 0.1×, đầu ra 5 USD / 1M): khoảng **0,53 USD / ngày** (≈ 16 USD / tháng). Ngày 2026-11-20 trang hiện 0,55 USD. Số trên prod phụ thuộc lượng tin và số bài qua Claude; ngân sách `SIGNAL_CLAUDE_DAILY_INPUT_TOKENS` mặc định chặn ở khoảng 2 USD / ngày.

**7. Kiểm sau deploy** (mọi lệnh chỉ đọc; chạy trong `/opt/drift`):

- Lane chạy: log scheduler có `signal research enabled`, rồi mỗi chu kỳ (`SIGNAL_NEWS_CYCLE_MINUTES`, mặc định 5 phút) một dòng `signal research news cycle`:
  ```bash
  docker compose logs --since 30m scheduler | grep -E "signal research (enabled|news cycle|not started)"
  ```
- Nguồn **Live** (tab Signal research, chấm Sources): `last_ok_at` của `sosovalue` trong vài phút gần nhất, `last_error` trống:
  ```bash
  docker compose exec postgres psql -U drift -d drift -c "select source, last_ok_at, last_error_at, last_error, last_cycle_at from signal_source_health order by source;"
  ```
- Có bài mới vào phễu:
  ```bash
  docker compose exec postgres psql -U drift -d drift -c "select count(*), max(collected_at) from signal_articles where collected_at > now() - interval '1 hour';"
  ```
- Có snapshot ngữ cảnh `live` (bước 4 · Context, cần ít nhất một bài qua Score):
  ```bash
  docker compose exec postgres psql -U drift -d drift -c "select source, count(*), max(decided_at) from signal_contexts group by source;"
  ```
- Có bản chụp giá cho lãi / lỗ chưa chốt (key Redis `sr:quotes`, TTL 60 s, scheduler ghi mỗi chu kỳ giá):
  ```bash
  docker compose exec redis redis-cli exists sr:quotes
  docker compose exec redis redis-cli pttl sr:quotes
  ```
  `exists` = 1 và `pttl` dương. Không có thì Paper trades hiện "Not available" thay cho lãi / lỗ chưa chốt.
- Chu kỳ scheduler đang dùng (key Redis `sr:lane`, #394; TTL 15 phút, ghi mỗi chu kỳ). Không có thì drawer How it works và ô "Where the time goes" ghi "Not available" thay cho số phút:
  ```bash
  docker compose exec redis redis-cli get sr:lane
  ```
- Paper trades có PnL: tab Signal research › Paper trades, lệnh mở có "unrealized", lệnh đóng có "Result after fees". Kiểm DB:
  ```bash
  docker compose exec postgres psql -U drift -d drift -c "select status, count(*), sum(result_usdc) from signal_paper_trades where lane = 'news' group by status;"
  ```
- Prompt cache và chi phí: mục 2.15 bước 4 (`claude_cache_read_tokens > 0` sau khoảng một giờ).
- Báo cáo tổng: `docker compose exec scheduler pnpm --filter @drift/scheduler signals:report`.

### 2.17 Idempotency-Key bị bỏ dở (#319, DEC-356)
- Service `jobs` mỗi phút đánh dấu dòng `idempotency_keys` đang chạy (chưa có `status_code`, chưa có `outcome`) tạo quá `IDEMPOTENCY_ABANDONED_AFTER_MIN` phút trước là `outcome = failed_unknown`, `error_code = ABANDONED`. Request lặp lại cùng key nhận 409 `reason: "unknown"`, không chạy lại; key không bị xoá (vẫn hết hạn sau 24 h như cũ).
- Biến: `IDEMPOTENCY_ABANDONED_AFTER_MIN` (số phút nguyên 5–1440, mặc định **10**; chỉ `jobs` đọc). Không đặt thì dùng mặc định, nên **không bắt buộc** sửa compose trên VPS. Muốn đổi: thêm `IDEMPOTENCY_ABANDONED_AFTER_MIN=<phút>` vào `/opt/drift/.env` và cho service `jobs` trong `/opt/drift/docker-compose.yml` khối `environment` như mẫu `deploy/server/docker-compose.yml` (`<<: *env` + dòng biến), rồi `cd /opt/drift && docker compose up -d jobs`.
- Không có migration. Kiểm tra: log `jobs` có dòng warn `idempotency key stuck in progress marked failed_unknown (ABANDONED)` (kèm `traceId`) khi có dòng bị đánh dấu; DB: `docker compose exec postgres psql -U drift -d drift -c "select count(*) from idempotency_keys where error_code = 'ABANDONED';"`.

### 2.18 Bước clock của engine chạy song song (#224, DEC-366)
- Engine chạy bước `clock` (nhịp `timer` của Volume Farm, Market Making, TWAP, Recurring Buy, Rebalancing, Adaptive DCA và chụp số dư bot paper) song song theo account, tối đa `ENGINE_CLOCK_CONCURRENCY` bot cùng lúc trong một worker (mọi shard cộng lại). Bot cùng account vẫn chạy lần lượt như trước. Lỗi của một bot chỉ bỏ nhịp của bot đó (log warn `clock step failed for one bot; retrying next tick`, kèm `botId`); lỗi fencing vẫn bỏ shard.
- Biến: `ENGINE_CLOCK_CONCURRENCY` (số nguyên 1–8, mặc định **4**; chỉ `engine` đọc). Giữ dưới pool DB của engine (10 kết nối). `1` = tuần tự như bản trước (dùng để rollback nhanh mà không đổi image). Không đặt thì dùng mặc định 4, nên **không bắt buộc** sửa compose trên VPS. Muốn đổi: thêm `ENGINE_CLOCK_CONCURRENCY=<n>` vào `/opt/drift/.env` và dòng `ENGINE_CLOCK_CONCURRENCY: ${ENGINE_CLOCK_CONCURRENCY:-4}` vào khối `environment` của service `engine` trong `/opt/drift/docker-compose.yml` như mẫu `deploy/server/docker-compose.yml`, rồi `cd /opt/drift && docker compose up -d engine`.
- Không có migration. Kiểm tra: log `tick slow` thưa đi và `phases.clock` nhỏ hơn bản trước; không có `engine tick failed` hay lỗi pool DB (`timeout exceeded when trying to connect`).

### 2.19 Bot `news_signal` mainnet: chốt chặn `SIGNAL_NEWS_BOTS_ENABLED` (#420, DEC-367)
- Biến: `SIGNAL_NEWS_BOTS_ENABLED`, mặc định **`false`**. **Một công tắc này điều khiển cả hai service `api` và `engine`**: api chặn tạo / Start / Resume, engine (PR engine A) không chạy bot `news_signal` khi tắt. Đặt cùng giá trị cho cả hai. Khi tắt, tạo bot mainnet (`POST /api/v1/signal-research/bots`), Start và Resume của bot `news_signal` trả **409 `FEATURE_NOT_READY`** ("Mainnet bots are not available yet.") cho mọi người, kể cả team. Không ghi DB, không có audit.
- Pause / Stop / Close now luôn chạy được cho chủ bot, vì chỉ giảm rủi ro.
- **Không bật** cho tới khi engine nối tín hiệu (#419 engine A/B) đã merge **và** người dùng đã tự thử một lệnh nhỏ thật trên mainnet. Người dùng tự bật: đặt `SIGNAL_NEWS_BOTS_ENABLED=true` trong `/opt/drift/.env`, thêm dòng `SIGNAL_NEWS_BOTS_ENABLED: ${SIGNAL_NEWS_BOTS_ENABLED:-false}` vào khối `environment` của `api` và của `engine` (như mẫu `deploy/server/docker-compose.yml`), rồi `cd /opt/drift && docker compose up -d api engine`.
- Tắt khẩn cấp: đặt lại `false`, rồi `docker compose up -d api engine`. Bot đang chạy không bị dừng; muốn dừng thì Stop từng bot hoặc dùng Emergency.
- Không có migration (bảng của #432, migration `0059`).
- **Engine (#419 engine A, DEC-368):** cùng biến, đọc ở service `engine` (mẫu `deploy/server/docker-compose.yml` đã có dòng `SIGNAL_NEWS_BOTS_ENABLED: ${SIGNAL_NEWS_BOTS_ENABLED:-false}` trong khối `environment` của `engine`).
  - **Tắt = không mở lệnh mới; lệnh đang mở vẫn được quản lý tới khi đóng** (#419 engine B1, DEC-TBD-news-signal-engine-b1). Engine không đọc `news_signals`, không subscribe NATS `sr.signal.new`, không nạp bot `news_signal` không còn lệnh mở (log warn `news_signal bot not loaded`). Bot còn lệnh news đang mở được nạp ở chế độ quản lý (log warn `news_signal bot managed only: no new trades`): OCO TP / SL, max hold, Stop vẫn chạy.
  - Bật: engine chỉ nạp bot mainnet của chủ có role team hoặc `users.signal_research`, khi bot vẫn chỉ thu hẹp version gốc. Engine giao tín hiệu mỗi vòng (ngay sau khi nạp bot) và ngay khi nhận chuông NATS `sr.signal.new` của scheduler (`SIGNAL_NEWS_PUBLISH_ENABLED`). Lệnh vào: limit IOC theo sổ lệnh đọc lúc giao (cũ tối đa 1 s), sau khi SoDEX xác nhận 1× isolated cho đúng market; giá × khối lượng ≤ 200 USDC; bot phải `running`; builder fee 10.
  - **Chế độ quản lý (engine B1):** bot `news_signal` còn lệnh mở luôn có runner, cả khi bot pause, đã dừng bằng "Keep open trades", chủ bot mất quyền Signal Research, hoặc công tắc tắt. Chế độ này không bao giờ mở lệnh mới (tín hiệu: `ACCESS_OFF` / `BOT_PAUSED`; lệnh bị chặn: `NEWS_ACCESS_OFF`), nhưng giữ OCO, max hold, Stop. Stop "Close all" đóng từng lệnh bằng market reduce-only; SoDEX từ chối 3 lần thì bot giữ `stopping` kèm Needs attention, không bao giờ `stopped` khi còn vị thế.
  - **Engine B2 (lệnh Edit TP/SL / Close now của người dùng, so vị thế của chính bot news) chưa có ở bản này: giữ `false`.**
  - Kiểm tra sau khi bật: `select outcome, reason, count(*) from news_signal_deliveries where created_at > now() - interval '1 hour' group by 1, 2;` và log `news signal opening order not sent` (phải không có trong vận hành bình thường).

## 3. Deploy hằng ngày
1. PR merge vào `main`, CI xanh.
2. Người dùng gõ "release" cho PM → PM tạo tag `vX.Y.Z` → `release.yml` build + push image các app đổi (app không đổi được gắn tag mới vào image của tag trước) → PM trả tag (`docs/RELEASE.md`).
3. Người dùng deploy: `infra/deploy/build-push.sh --deploy-only vX.Y.Z` (rollback: cuối mục này).

Build từ máy mình, không qua GitHub (máy đã `docker login` bằng token `drift-push`):
```bash
infra/deploy/build-push.sh              # build + push cả 11 app, không deploy
infra/deploy/build-push.sh web api      # chỉ build vài app
```
Script tự về gốc repo, đọc `WALLETCONNECT_PROJECT_ID` từ `.env` (khi chưa đặt biến), đẩy lên `DRIFT_IMAGE` (mặc định `docker.io/lthuangiang/drift`) với 2 tag `<app>-<TAG>` và `<app>-latest`; `TAG` mặc định là ngày giờ lúc build (`yyyyMMddHHmmss`, giờ máy), đổi bằng `TAG=...`. VPS ARM thì thêm `PLATFORM=linux/arm64` (máy x86 phải giả lập QEMU, chậm).

Deploy từ máy mình (thay cho làm tay `ssh` → sửa `DRIFT_TAG` → `migrate` → `pull` / `up -d`):

```bash
infra/deploy/build-push.sh --deploy engine web     # build 2 app, 9 app còn lại giữ image đang chạy
infra/deploy/build-push.sh --deploy                # build cả 11 app rồi deploy
infra/deploy/build-push.sh --deploy-only <tag>     # không build: deploy (hoặc rollback về) một tag đã push
```

- Máy đích mặc định `root@149.28.148.63` (đổi bằng `DEPLOY_TARGET` hoặc `--deploy user@host`). SSH hỏi mật khẩu một lần, trước khi build; mọi lệnh sau tới VPS dùng lại kết nối đó. Muốn khỏi gõ: `ssh-copy-id root@149.28.148.63`, hoặc để `DEPLOY_SSH_PASS=...` trong `infra/deploy/.deploy.local` (đã gitignore, cần `brew install sshpass`). VPS thiếu `/opt/drift/.env` thì script dừng trước khi build.
- Chỉ build vài app: script đọc `DRIFT_TAG` đang chạy trên VPS và gắn tag mới cho các app không build, trỏ vào đúng image đang chạy (chép trên registry, không build lại), vì compose dùng một `DRIFT_TAG` chung. VPS chưa có `DRIFT_TAG` (lần đầu) thì phải build cả 11 app.
- Trên VPS (`/opt/drift`, chỉ một `docker-compose.yml`), script chạy đúng các bước làm tay: đổi `DRIFT_TAG` trong `.env` → `docker compose pull` → `docker compose run --rm migrate` → `docker compose up -d` → xoá image `DRIFT_IMAGE` **không** thuộc tag hiện tại hay tag liền trước, rồi `docker image prune -f` (layer treo). Không đụng image hạ tầng, không `docker system prune -af` nữa: rollback một bản không phải tải lại, và layer chung của bản mới không bị xoá (DEC-214). Không chép compose của repo lên VPS. Dọn image sau cùng, để pull / migrate lỗi thì bản đang chạy vẫn còn.

Quy tắc:
- **Migration tương thích ngược**: chỉ thêm bảng/cột; xoá hoặc đổi tên ở một lần deploy sau. Rollback chỉ đổi image, không quay migration.
- Engine chạy 1 bản: khi deploy, bot ngừng đặt lệnh vài giây. Engine trả lease khi SIGTERM; lệnh chưa rõ kết quả được đối soát (`unknown`), không gửi lại mù.
- Tránh deploy khi bot đang ở bước nhạy cảm (TWAP sắp xong, vừa đổi đòn bẩy).

Rollback về tag trước:
```bash
infra/deploy/build-push.sh --deploy-only <tag trước>
```
- Tag trước: script in đúng lệnh này sau mỗi lần deploy (`deployed <tag> (rollback: infra/deploy/build-push.sh --deploy-only <tag trước>)`) và in `running tag:` lúc kết nối; trên VPS là `DRIFT_TAG` trong `/opt/drift/.env`. Là tag release `vX.Y.Z` trước, hoặc tag ngày giờ của lần build tay trước.
- Chạy đúng các bước của một lần deploy (đổi `DRIFT_TAG` → pull → migrate → `up -d` → dọn image). VPS giữ image của tag hiện tại và tag liền trước, nên rollback một bản không phải tải lại; tag cũ hơn được kéo lại từ Docker Hub bằng token read-only. Sau rollback, tag vừa bỏ thành "tag liền trước" nên deploy lại nó cũng không phải tải.
- Migration không quay lại: migrate của image cũ không làm gì (mọi migration của nó đã chạy); bảng / cột mới vẫn còn và bản cũ bỏ qua chúng.
- Rollback không hoàn lại thay đổi tay trong `/opt/drift/docker-compose.yml` hay `.env` (ví dụ 2.10, 2.12): bản cũ cần khác thì sửa tay.
- `deploy.sh` trên VPS (cách cũ) không còn dùng để rollback.

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
