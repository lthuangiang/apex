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

Cert mTLS (api / engine ↔ signer) do service `certs` của compose tự tạo ở lần `up` đầu, lưu trong volume `certs`, hạn 1095 ngày (3 năm); lần sau thấy đủ file thì bỏ qua. Không cần chạy `gen-dev-certs.sh` (dòng `CERT_DAYS=… gen-dev-certs.sh /opt/drift/certs` và `SIGNER_CERTS_DIR` trong `.env.production.example` là của cách cũ). Đặt lịch nhắc tạo lại trước ngày hết hạn. Signer từ chối mọi kết nối khi cert hết hạn: engine coi là chưa gửi (`signer_unavailable`, không phải `API_KEY_UNUSABLE`), thử lại rồi pause bot với `ORDER_REJECTED` sau 5 lần hoặc 5 phút (xem mục 2.4.2). Tạo lại:
```bash
cd /opt/drift
docker compose run --rm --entrypoint sh certs -c 'rm -f /certs/*'
docker compose run --rm certs
docker compose up -d --force-recreate signer api engine scheduler
```
Từ #558, scheduler cũng gọi signer (giải mã phiên rewards) và đang dùng chung cert client của api (DEC-398), nên tạo lại cert thì tạo lại cả `scheduler`. Service `certs` cấp cả `scheduler.crt` khi tạo lại; lúc đó chuyển scheduler sang `scheduler.crt` (quy trình đầy đủ: 2.4.1).

#### 2.4.1 Tạo lại toàn bộ cert prod (cert hết hạn, hoặc chuyển scheduler sang cert riêng)

Dùng khi cert sắp hết hạn (hạn 1095 ngày), hoặc khi muốn scheduler có cert riêng (CN `scheduler`) thay cho cert dùng chung của api (DEC-398). Prod xoá `ca.key` sau khi tạo cert, nên không cấp lẻ được: phải tạo lại toàn bộ, và signer, api, engine, scheduler phải được tạo lại cùng lúc. Việc bật #558 **không** cần quy trình này (scheduler dùng chung cert api).

Làm đúng thứ tự:

a. **Trước cửa sổ:**
   - Thông báo người dùng giờ bảo trì; nhờ họ Pause hoặc Stop mọi bot (team không có nút pause bot của mọi user, xem 2.4.2).
   - Kiểm không còn bot đang chạy (chỉ đọc):
     ```bash
     cd /opt/drift
     docker compose exec -T postgres psql -U drift -d drift -v ON_ERROR_STOP=1 <<'SQL'
     SET default_transaction_read_only = on;
     SET statement_timeout = '10s';
     SELECT mode, state, count(*) FROM bots
     WHERE state IN ('starting', 'running', 'resuming', 'pausing', 'stopping')
     GROUP BY mode, state ORDER BY mode, state;
     -- Lệnh tiền thật còn mở (kể cả của bot news_signal đã pause nhưng engine vẫn quản lý, 2.4.2).
     SELECT b.strategy, o.status, count(*) FROM orders o JOIN bots b ON b.id = o.bot_id
     WHERE b.mode = 'live' AND o.status IN ('open', 'partially_filled', 'unknown')
     GROUP BY b.strategy, o.status ORDER BY b.strategy, o.status;
     SQL
     ```
     Câu đầu rỗng (hoặc chỉ `paper`) thì tiếp. Còn bot `live` đang chạy thì liên hệ chủ bot hoặc dời giờ. Câu thứ hai chỉ để biết lệnh nào còn nằm trên sổ SoDEX trong lúc engine dừng (có thể khớp; engine đối soát khi lên lại).
   - Sao lưu volume cert:
     ```bash
     docker run --rm -v drift_certs:/c -v /opt/drift/backups:/b alpine tar czf /b/certs-before.tgz -C /c .
     ```

b. **Chuyển scheduler sang cert riêng** (nên làm luôn ở lần tạo lại này): trong khối `scheduler` của `/opt/drift/docker-compose.yml`, đổi `SIGNER_CLIENT_CERT: /certs/scheduler.crt` và `SIGNER_CLIENT_KEY: /certs/scheduler.key` (`SIGNER_CLIENT_CA` giữ `/certs/ca.crt`). Không chuyển thì scheduler tiếp tục dùng `api.crt` / `api.key` mới, vẫn chạy.

c. Dừng các service dùng cert client:
   ```bash
   cd /opt/drift && docker compose stop engine scheduler api
   ```

d. Tạo lại toàn bộ cert:
   ```bash
   docker compose run --rm --entrypoint sh certs -c 'rm -f /certs/*'
   docker compose run --rm certs
   ```
   Phải in `certs: created (valid 1095 days)`.

e. Tạo lại bốn service cùng lúc:
   ```bash
   docker compose up -d --force-recreate signer api engine scheduler
   ```

f. **Kiểm** (không đặt lệnh):
   - `docker compose ps`: `signer` healthy; `api`, `engine`, `scheduler` Up.
   - `docker compose logs --since 5m signer | grep -i -E 'tls|certificate|handshake'`: không có dòng lỗi.
   - api qua mTLS (CN `api`, chỉ đọc): hỏi signer kiểm một key không tồn tại; **404** = TLS + CN đúng (403 = sai CN, lỗi kết nối = sai cert):
     ```bash
     docker compose exec -T api node -e "const fs=require('fs');const r=require('https').request({host:'signer',port:8090,method:'POST',path:'/v1/keys/00000000-0000-7000-8000-000000000000/verify',servername:'signer',ca:fs.readFileSync('/certs/ca.crt'),cert:fs.readFileSync('/certs/api.crt'),key:fs.readFileSync('/certs/api.key')},s=>{console.log(s.statusCode);process.exit(s.statusCode===404?0:1)});r.on('error',e=>{console.error(e.message);process.exit(1)});r.end()"
     ```
   - engine (CN `engine`): healthcheck của signer dùng cert engine, nên `signer` healthy là đủ; thêm `docker compose logs --since 5m engine | grep -i -E 'signer_unavailable|certificate'` không có dòng nào.
   - scheduler (cert theo `SIGNER_CLIENT_CERT` của nó: `scheduler.crt` nếu đã chuyển ở bước b, không thì `api.crt`): giải mã cho một user không có dòng; **404** = TLS + CN + quyền DB (migration 0064) đúng:
     ```bash
     docker compose exec -T scheduler node -e "const fs=require('fs');const b=JSON.stringify({userId:'00000000-0000-7000-8000-000000000000'});const r=require('https').request({host:'signer',port:8090,method:'POST',path:'/v1/rewards-tokens/decrypt',servername:'signer',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)},ca:fs.readFileSync('/certs/ca.crt'),cert:fs.readFileSync(process.env.SIGNER_CLIENT_CERT),key:fs.readFileSync(process.env.SIGNER_CLIENT_KEY)},s=>{console.log(s.statusCode);process.exit(s.statusCode===404?0:1)});r.on('error',e=>{console.error(e.message);process.exit(1)});r.end(b)"
     ```
     và `docker compose logs --since 5m scheduler | grep -i 'rewards watch off'` không có dòng nào.

g. **Rollback** (bất kỳ bước kiểm nào hỏng):
   ```bash
   cd /opt/drift
   docker compose stop engine scheduler api signer
   docker compose run --rm --entrypoint sh certs -c 'rm -f /certs/*'
   docker run --rm -v drift_certs:/c -v /opt/drift/backups:/b alpine tar xzf /b/certs-before.tgz -C /c
   docker compose up -d --force-recreate signer api engine scheduler
   ```
   Nếu đã chuyển scheduler sang `scheduler.crt` ở bước b mà volume cũ không có file đó: đổi khối `scheduler` về `/certs/api.crt` / `/certs/api.key` trước lệnh `up -d` trên (thiếu file thì scheduler vẫn chạy, chỉ job rewards tắt). Kiểm lại như bước f.

h. **Sau cửa sổ:** báo người dùng Resume bot. Bot đã Pause / Stop **không tự chạy lại**.

#### 2.4.2 Bot đang chạy khi signer / engine bị tạo lại (đọc code, #558)

- **Engine dừng (SIGTERM):** chờ shard đang chạy dở (có giới hạn), trả lease, rồi mới đóng user stream (`apps/engine/src/main.ts:394-411`, `apps/engine/src/engine.ts:2742-2752`). Trạng thái bot trong DB **không đổi**: bot `running` vẫn `running`, lệnh đang nằm trên sổ SoDEX giữ nguyên (có thể khớp trong lúc engine dừng). Engine lên lại thì tự nạp lại bot `starting` / `running` / `pausing` / `resuming` / `stopping` (`ENGINE_ACTIVE_STATES`, `packages/shared/src/bot-state.ts:86-92`; `engine.ts:2875-2882`) và chạy tiếp; bot `news_signal` đã pause / Stop-Keep mà còn lệnh news mở cũng vẫn được quản lý (OCO, đóng lệnh) (`engine.ts:2884-2886`), nên có thể ký lệnh đóng ngay sau khi lên lại; đối soát lệnh `open` / `partially_filled` / `unknown` (`engine.ts:2731`). Vì vậy cửa sổ bảo trì vẫn nhờ người dùng Pause: bot không bị đóng băng an toàn bằng cách tắt engine.
- **Signer không gọi được** (đang tạo lại, sai / thiếu cert, 403 sai CN, 5xx): `httpSigner.sign` ném `NotSentError("signer_unavailable")` (`apps/engine/src/http-gateway.ts:82-92`, `:220-222`). Request **chưa rời DeskLabs**, nên không tạo lệnh `unknown`, không cần đối soát. Engine thử lại 2 s → 4 s → … tối đa 60 s (`engine.ts:921-927`); quá 5 lần hoặc 5 phút thì Decisions "Paused: could not reach the signer" và pause bot với **`ORDER_REJECTED`** (`not sent (signer_unavailable)`) (`engine.ts:4151-4190`). Lệnh đóng của Stop thử lại 5 s / 15 s / 60 s, bỏ sau 10 phút: bot `needs_attention`, Decisions "Couldn't close your position", báo team `close_failed`; vị thế còn mở trên SoDEX (`engine.ts:919`, `:5615-5641`).
- **`API_KEY_UNUSABLE`** chỉ khi signer trả 422 / 404 (Vault không giải mã được key, key không `active`) (`http-gateway.ts:89-90`, `engine.ts:4155-4164`): pause mọi bot của account. Tạo lại cert **không** gây lý do này.
- **Team không có nút pause bot của mọi user.** "Halt all agents" (`POST /api/v1/risk/halt`, `apps/api/src/modules/account/routes.ts:91`, `apps/api/src/modules/account/service.ts:368-393`) chỉ Stop bot của chính người bấm (`EMERGENCY_HALT`); route admin chỉ bật / tắt cờ theo user. Cửa sổ bảo trì dựa vào thông báo cho người dùng và câu SQL ở bước a.

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
| `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` | scheduler | **Mới (#530 PR2, DEC-393).** Tín hiệu mainnet một dòng mỗi coin của sự kiện nhiều coin. Mặc định `false` (một dòng cho coin chính, `event_coins` 1). Chỉ bật sau khi mọi service lên bản mới; rollback về trước v2.18.8 thì tắt trước (mục 2.20). Migration `0062` chỉ thêm bảng, rollback không cần làm gì với bảng (mục 2.21) |

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

> **v2.16.0** (`docs/releases/v2.16.0.md`): migration `0057`–`0059`, đều chỉ thêm. Biến mới, đều có mặc định: `IDEMPOTENCY_ABANDONED_AFTER_MIN` (jobs, 10), `ENGINE_CLOCK_CONCURRENCY` (engine, 4; mục 2.18), `SIGNAL_NEWS_BOTS_ENABLED` (api + engine, `false`; mục 2.19), `SIGNAL_NEWS_PUBLISH_ENABLED` (scheduler, `false`). Khi deploy: `infra/deploy/build-push.sh --deploy-only v2.16.0` (pull, migrate, up). **Giữ hai công tắc Signal news `false`** tới khi người dùng tự thử một lệnh nhỏ thật (thứ tự trong `docs/releases/v2.16.0.md`). Engine khởi động lại có thể log `RATE_LIMITED` / `shard loop failed` vài giây (nhiều shard nạp market cùng lúc), tự hết. Có vấn đề ở bước clock: `ENGINE_CLOCK_CONCURRENCY=1` rồi `docker compose up -d engine`.

> **v2.17.0** (`docs/releases/v2.17.0.md`): migration `0060_news_trade_leverage` (chỉ thêm cột). Không có biến môi trường mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.17.0`. Bot `news_signal` cũ chạy 1× như trước; bot mới chọn 1 / 5 / 10 / 20× (DEC-373). Sau deploy, nếu log engine có `news_signal liquidation check uses the fallback maintenance margin rate` thì market đó dùng MMR dự phòng 5%.

> **v2.17.1** (`docs/releases/v2.17.1.md`): chỉ đổi câu Decisions sang tên sản phẩm. Không migration, không biến mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.17.1`.

> **v2.18.0** (`docs/releases/v2.18.0.md`): Settings / Edit cho bot `news_signal`, chặn archive khi còn lệnh mở (DEC-376), các luồng dùng chung. Không migration, không biến mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.18.0`. Sau deploy chạy câu SQL chỉ đọc trong release notes để xem có bot news nào đã lỡ archive khi còn lệnh mở (engine bản này tự quản lý lại).
>
> **v2.18.1** (`docs/releases/v2.18.1.md`): chỉ khu team: picker market + cột Avg trên Market hours, nút Export data của Signal Research. Không migration, không biến mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.18.1`.
>
> **v2.18.2** (`docs/releases/v2.18.2.md`): sửa hai lỗi tiền thật (đòn bẩy `unknown` của bot news, Market Making re-sync theo vị thế cũ, DEC-380), hết báo động giả "SoDEX errors spiking", Smart quoting tắt mặc định. Không migration, không biến mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.18.2`. Bot Market Making đang chạy nên Stop trước khi deploy rồi Start lại.
>
> **v2.18.3** (`docs/releases/v2.18.3.md`): hotfix Signal Research: Claude reader v6 (DEC-382), Rules v5 bỏ listing trên BTC / ETH (DEC-383), sổ lệnh REST một lần qua marketdata khi market không có sổ live (DEC-384), đoạn trích trong export (DEC-385). Không migration, không biến mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.18.3`. `marketdata` và `scheduler` phải lên cùng bản (subject NATS mới `sr.book.request`); lệnh deploy trên đã làm vậy. Sau deploy, số nhãn, số lệnh và cổng 50 nhãn của Signal Research đếm lại từ 0 (một lần).
>
> **v2.18.4** (`docs/releases/v2.18.4.md`): cache Realized PnL và sparkline của Overview (DEC-387), cảnh báo team "SoDEX order updates delayed" (DEC-386), sửa a11y trang Market hours. Không migration, không biến mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.18.4`. Không đổi engine, không cần Stop bot. Sau deploy chạy lại `reports/sodex-ratelimit-a.sql` để đo mức giảm weight của `positions/history`.
>
> **v2.18.5** (`docs/releases/v2.18.5.md`): Market Making báo giá theo sổ WS (DEC-389) và giữ lệnh đóng rc tối đa 10 s khi giá không đổi (DEC-390). **Đổi engine của bot tiền thật.** Không migration, không biến mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.18.5`. Stop bot Market Making trước khi deploy, Start lại sau; chạy thử cỡ lệnh nhỏ 1–2 giờ, rồi chạy lại `reports/mm-517-cost.sql` để so với số đo trước.
>
> **v2.18.6** (`docs/releases/v2.18.6.md`): Trading Agent hiện vị thế Long / Short, Unrealized PnL và thời gian giữ của Volume Builder (#527). Không migration, không biến mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.18.6`. **Nếu prod chưa deploy v2.18.5 thì lần này mang theo thay đổi engine Market Making của v2.18.5:** Stop bot Market Making trước khi deploy, Start lại sau; chạy thử cỡ lệnh nhỏ 1–2 giờ, rồi chạy lại `reports/mm-517-cost.sql` để so với số đo trước.
>
> **v2.18.7** (`docs/releases/v2.18.7.md`): vá marketdata: theo dõi ví leader và đọc ví Hyperliquid bật ngay khi khởi động, backfill nến chạy nền (DEC-391). Không migration, không biến mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.18.7`. **Prod đang ở v2.18.4 nên lần này mang theo thay đổi engine Market Making của v2.18.5:** Stop bot Market Making trước khi deploy, Start lại sau; chạy thử cỡ lệnh nhỏ 1–2 giờ, rồi chạy lại `reports/mm-517-cost.sql`. Kiểm sau deploy: log marketdata có `leader feeds started`; sau khoảng 5 phút chạy `reports/sr-531-h1.sql`, truy vấn cuối phải có `polled_5m` > 0.
>
> **v2.18.8** (`docs/releases/v2.18.8.md`): bot Market Making mới mặc định "Where to quote" = 2 (DEC-395); nền cho sự kiện tin nhiều coin (DEC-392). **Có migration `0061_news_event_coins`** (chỉ thêm hai cột, `build-push.sh --deploy-only` tự chạy bước migrate). Không biến mới. Deploy: `infra/deploy/build-push.sh --deploy-only v2.18.8`. Không đổi hành vi bot đang chạy. Sau khi deploy, báo PM để #530 PR2 / PR3 được merge (chúng cần engine của bản này).
>
> **v2.19.0** (`docs/releases/v2.19.0.md`): Signal Research tách một tin nhiều coin thành một tín hiệu mỗi coin (DEC-393, DEC-394); Market Making chỉ hiện ước tính chi phí khi "Where to quote" = 0 (DEC-396); nền tảng SoDEX rewards và trang chẩn đoán team (DEC-397). **Prod đang ở v2.18.7 nên lần này mang theo v2.18.8: có hai migration `0061_news_event_coins` và `0062_sr_context_coins`** (đều chỉ thêm cột / bảng; `build-push.sh --deploy-only` tự chạy bước migrate). Biến mới, đều để mặc định `false` khi deploy: `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` (scheduler, mục 2.20) và `REWARDS_ENABLED` (api, mục 2.22; compose trên VPS thiếu dòng `REWARDS_ENABLED` trong `environment` của `api` thì chưa cần thêm, vì thiếu = tắt). Deploy: `infra/deploy/build-push.sh --deploy-only v2.19.0`. Kiểm sau deploy: (1) mở `/admin/rewards-debug` bằng tài khoản team, ký bằng ví SoDEX, bấm "Read endpoints", gửi PM ảnh chụp (token và địa chỉ ví không hiện); (2) Signal Research đếm lại từ Rules `news-v6`, sau 24 giờ gửi PM file export; (3) chỉ bật `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` sau khi PM xem export. Rollback về trước v2.18.8: tắt `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` trước (mục 2.20).
>
> **v2.20.0** (`docs/releases/v2.20.0.md`): SoDEX rewards trong DeskLabs (SoPoints, Blind Boxes, claim / open / merge, popup box mới nhận, báo box mới qua job; DEC-397, DEC-398) và tin Telegram bot dừng đúng kế hoạch có số liệu phiên + CPM (DEC-399). **Mọi công tắc rewards mặc định tắt; role team thấy Rewards để thử.** **Có migration `0063_rewards_watch` và `0064_rewards_watch_signer_grant`** (chỉ thêm bảng và quyền đọc; `build-push.sh --deploy-only` tự chạy bước migrate). **Trước khi deploy, cập nhật `/opt/drift/docker-compose.yml` theo mẫu `deploy/server/docker-compose.yml`** (mục 2.23): configs `vault-init` và `certs-init`; khối `api` thêm `REWARDS_WATCH_ENABLED`, `REWARDS_JWT_AUD_ALLOW`; khối `scheduler` thêm các biến rewards, `SIGNER_URL`, `SIGNER_CLIENT_CERT=/certs/api.crt`, `SIGNER_CLIENT_KEY=/certs/api.key`, `SIGNER_CLIENT_CA=/certs/ca.crt`, `depends_on` `certs`, volume `certs:/certs:ro`, network `secure`. Không tạo lại cert, không dừng bot. Deploy: `infra/deploy/build-push.sh --deploy-only v2.20.0`. Kiểm sau deploy: (1) `docker compose ps` signer healthy và log signer không có lỗi; log `vault-init` có "vault: ready"; log `certs` có "certs: present (no scheduler cert; scheduler uses the api client cert, DEC-398)"; (2) một bot nhỏ vẫn đặt lệnh bình thường (do chủ sản phẩm kiểm); (3) tài khoản team: thử claim / open / merge trên `/rewards`, rồi dán cho PM thẻ "Sign-in token claims" của `/admin/rewards-debug`. Chưa bật `REWARDS_ENABLED`, `REWARDS_WATCH_ENABLED` cho tới khi PM báo.
>
> **v2.21.0** (`docs/releases/v2.21.0.md`): SoDEX rewards mở cho mọi người dùng (mặc định `REWARDS_ENABLED` bật), giao diện Rewards làm đẹp (hình box theo cấp, hiệu ứng, bảng tuần đủ cột; DEC-400), sửa hiển thị số, tin Telegram tổng kết tuần và điểm tuần. **Có migration `0065_rewards_watch_weekly`** (ba cột nullable; `build-push.sh --deploy-only` tự chạy bước migrate). Không cần sửa compose trên VPS. Deploy: `infra/deploy/build-push.sh --deploy-only v2.21.0`. `.env` trên VPS: giữ `REWARDS_ENABLED=true` (compose trên VPS còn mặc định `:-false`). Để bật báo box mới và tin tuần: thêm `REWARDS_WATCH_ENABLED=true` và `REWARDS_JWT_AUD_ALLOW=sodex`, rồi `docker compose up -d api scheduler`; cần khối `scheduler` của compose đã có `SIGNER_URL` và cert api (mục 2.23). Sau khi bật, người dùng ký lại rewards với công tắc "Tell me about new boxes" để phiên được lưu. Kiểm sau deploy: trang `/rewards` hiện hình box và bảng tuần mới; log scheduler không có lỗi `rewards watch`; khi có box, chủ sản phẩm thử claim / open / merge.

> **v2.22.0** (`docs/releases/v2.22.0.md`): phiên đăng nhập rewards giữ ở localStorage tới khi hết hạn (DEC-401; người dùng ký lại một lần sau bản này), `REWARDS_WATCH_INTERVAL_MIN` nhận 1–60 phút, chẩn đoán lỗi bật "New box alerts" (`details.cause`, mã "Reference" trên banner). **Không migration, không cần sửa compose trên VPS.** Deploy: `infra/deploy/build-push.sh --deploy-only v2.22.0`. **Script deploy từ bản này tự kiểm hai việc** (mục 2.23): từ chối nếu `/opt/drift/docker-compose.yml` có khoảng trắng sau dấu `\` nối dòng (in số dòng), và sau `up -d` chờ `vault-init` `healthy`; không được thì in log đã lọc và thoát khác 0 (app mới vẫn chạy). Lần deploy đầu với bản này là lần thử thật đầu tiên của hai kiểm đó: đọc kỹ đầu ra, cần thấy `vault-init: healthy`. Tuỳ chọn sau deploy: đặt `REWARDS_WATCH_INTERVAL_MIN=2` trong `/opt/drift/.env` rồi `docker compose up -d --no-deps scheduler` để báo box mới mỗi khoảng 2 phút (sức chứa ≈ 40 user ở trần weight mặc định). Kiểm sau deploy: mở `/rewards` ở tab mới không phải ký lại sau lần ký đầu; log scheduler không có `REWARDS_WATCH_INTERVAL_MIN invalid`.

> **v2.23.0** (`docs/releases/v2.23.0.md`): US Market + SoDEX Wealth (trang `/markets/us`, Portfolio › My Wealth chỉ đọc, giới hạn theo sổ lệnh cho ANT và token quỹ, tin công ty Anthropic → ANT-USD, cảnh báo Wealth ở trạng thái tắt; DEC-402 đến DEC-404) và thẻ SoDEX rewards hiện Spot / Perps tuần này + "Trade … more to unlock your next Blind Box" (DEC-405). **Có migration `0066_sr_context_book_depth` (cột nullable) và `0067_wealth_watch` (bảng mới)**; `build-push.sh --deploy-only` tự chạy bước migrate. **Không bắt buộc sửa compose trên VPS:** `US_MARKET_ENABLED` mặc định bật và `DEPTH_CAP_MARKETS` mặc định là danh sách ANT + 8 cặp token quỹ ngay trong code; `WEALTH_WATCH_ENABLED` mặc định tắt. Muốn đổi các biến này (mục 2.24, 2.25, 2.26) thì thêm dòng tương ứng vào khối `api` / `engine` / `scheduler` theo mẫu; `DEPTH_CAP_MARKETS` phải cùng giá trị ở engine và api, `WEALTH_READ_MAX_WEIGHT_PER_MIN` cùng giá trị ở api và scheduler. Deploy: `infra/deploy/build-push.sh --deploy-only v2.23.0` (mọi service, marketdata lên cùng scheduler). Web build có host mới trong CSP cho `lottery/progress` (host lottery của SoDEX, endpoint không có trong tài liệu: hỏng thì dòng phụ trên thẻ rewards tự ẩn). Kiểm sau deploy: (1) Strategy Lab có banner, `/markets/us` hiện khối Anthropic với độ sâu sổ lệnh và khối SoDEX Wealth funds; (2) Portfolio › My Wealth hiện đúng số của ví chính (ví không có gì thì hiện trạng thái trống); (3) thẻ SoDEX rewards hiện Spot / Perps tuần này; (4) log engine không có `entry held: order book depth unknown` lặp lại, bot ở market ngoài danh sách không có Decisions "Order reduced"; (5) Signal Research: số nhãn / số lệnh không bị đặt lại (Rules vẫn `news-v6`). **Chưa bật `WEALTH_WATCH_ENABLED`** cho tới khi team thử bằng ví thật và chốt giá trị `status` / `reasonCode` của kỳ mua định kỳ (mục 2.26).

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
  - **Tắt = không mở lệnh mới; lệnh đang mở vẫn được quản lý tới khi đóng** (#419 engine B1, DEC-369). Engine không đọc `news_signals`, không subscribe NATS `sr.signal.new`, không nạp bot `news_signal` không còn lệnh mở (log warn `news_signal bot not loaded`). Bot còn lệnh news đang mở được nạp ở chế độ quản lý (log warn `news_signal bot managed only: no new trades`): OCO TP / SL, max hold, Stop vẫn chạy.
  - Bật: engine chỉ nạp bot mainnet của chủ có role team hoặc `users.signal_research`, khi bot vẫn chỉ thu hẹp version gốc. Engine giao tín hiệu mỗi vòng (ngay sau khi nạp bot) và ngay khi nhận chuông NATS `sr.signal.new` của scheduler (`SIGNAL_NEWS_PUBLISH_ENABLED`). Lệnh vào: limit IOC theo sổ lệnh đọc lúc giao (cũ tối đa 1 s), sau khi SoDEX xác nhận đòn bẩy của bot (1 / 5 / 10 / 20×, #458) isolated cho đúng market; giá × khối lượng ≤ 200 USDC; bot phải `running`; builder fee 10.
  - **Chế độ quản lý (engine B1):** bot `news_signal` còn lệnh mở luôn có runner, cả khi bot pause, đã dừng bằng "Keep open trades", chủ bot mất quyền Signal Research, hoặc công tắc tắt. Chế độ này không bao giờ mở lệnh mới (tín hiệu: `ACCESS_OFF` / `BOT_PAUSED`; lệnh bị chặn: `NEWS_ACCESS_OFF`), nhưng giữ OCO, max hold, Stop. Stop "Close all" đóng từng lệnh bằng market reduce-only; SoDEX từ chối 3 lần thì bot giữ `stopping` kèm Needs attention, không bao giờ `stopped` khi còn vị thế.
  - **Engine B2 (#419, DEC-370):** lệnh của người dùng (Edit TP/SL, Close now) chạy ở mọi trạng thái bot còn lệnh mở, kể cả khi công tắc tắt hoặc chủ bot mất quyền. Trạng thái lệnh: `select status, count(*) from news_signal_commands group by 1;` (`queued` → `applying` → `applied` / `rejected`; `unknown` = đối soát bỏ cuộc, bot có Needs attention, kiểm tay trên SoDEX). Bot news một mình trên market được so vị thế với SoDEX như mọi bot (cảnh báo "Position doesn't match").
  - **Đòn bẩy (#458, DEC-373):** bot chọn 1 / 5 / 10 / 20× isolated; trần 200 USDC là giá trị vị thế ở mọi mức. Market có đòn bẩy tối đa thấp hơn, SoDEX từ chối, hoặc vị thế sẵn có với thiết lập khác → tín hiệu `LEVERAGE_NOT_SET`. Khoảng thanh lý ước tính (DEC-172) < 1.5 × khoảng SL → `SL_BEYOND_LIQUIDATION` (ở 10–20× sẽ bỏ nhiều tín hiệu hơn, đó là chủ ý). SoDEX không trả `marginTiers` của market thì dùng MMR dự phòng 5% và log warn `news_signal liquidation check uses the fallback maintenance margin rate` (một lần mỗi market mỗi lần engine chạy). Start check: margin isolated ≥ size × Max open trades ÷ đòn bẩy. Không có migration (đòn bẩy nằm trong config của bot; bot cũ không có trường là 1×).
  - **Bật công tắc** chỉ khi người dùng đã tự thử một lệnh nhỏ thật trên mainnet (DEPLOY trên); engine A, B1, B2 đã đủ. Lệnh nhỏ thật có đòn bẩy do người dùng tự chạy sau deploy.
  - Kiểm tra sau khi bật: `select outcome, reason, count(*) from news_signal_deliveries where created_at > now() - interval '1 hour' group by 1, 2;` và log `news signal opening order not sent` (phải không có trong vận hành bình thường).

### 2.20 Chia sự kiện nhiều coin cho bot mainnet: cờ `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` (#530 PR2, DEC-393)

- Biến của service `scheduler`, mặc định **`false`**. Mẫu `deploy/server/docker-compose.yml` có dòng `SIGNAL_NEWS_EVENT_SPLIT_ENABLED: ${SIGNAL_NEWS_EVENT_SPLIT_ENABLED:-false}`; `.env.example` có mẫu.
- **Tắt:** mỗi bài chỉ ghi một dòng `news_signals` cho coin chính, `event_key` null, `event_coins` 1, như bot mainnet trước PR1. Paper / research vẫn chia (không đọc cờ). Bài đăng lại cùng sự kiện vẫn bị chặn (`SAME_EVENT`), nên Mainnet chỉ có ít lệnh hơn trước.
- **Bật:** một dòng mỗi coin của sự kiện, cùng `event_key`, `event_coins` = số coin; engine chia cỡ lệnh (PR1).
- **Thứ tự bắt buộc:** deploy MỌI service (engine, api, scheduler) lên bản mới trước, rồi mới bật cờ (`SIGNAL_NEWS_EVENT_SPLIT_ENABLED=true` trong `.env`, rồi `docker compose up -d scheduler`). Nếu cờ bật mà engine chưa hiểu `event_coins` (bản trước PR1), mỗi coin được mở đủ cỡ lệnh, và **không có cách tự phát hiện**.
- **Rollback về bản trước PR1 (trước v2.18.8):** đặt cờ `false` và `docker compose up -d scheduler` TRƯỚC, rồi mới rollback các service.
- Kiểm tra sau khi bật: `select event_key, event_coins, count(*) from news_signals where decided_at > now() - interval '1 day' group by 1, 2 order by 3 desc;` (chỉ đọc).

### 2.21 Migration `0062_sr_context_coins` (#530 PR2, DEC-393): rollback không cần làm gì với bảng

- Migration chỉ THÊM bảng `signal_context_coins` (cùng cột với `signal_contexts`, unique `(article_id, market)`, trigger chặn UPDATE dùng lại hàm `signal_contexts_immutable`). Bảng này giữ snapshot ngữ cảnh của các coin KHÁC coin chính trong một bài nêu nhiều coin.
- `signal_contexts` **không đổi**: vẫn unique theo `article_id`, vẫn một dòng mỗi bài (coin chính). Câu ghi của bản cũ (`insertSignalContext`, `ON CONFLICT (article_id) DO NOTHING`) vẫn chạy.
- **Cửa sổ deploy** (migrate xong, scheduler cũ còn chạy): không lỗi. Scheduler cũ ghi ngữ cảnh như trước; chưa có dòng nào ở bảng mới.
- **Rollback scheduler / api về bản trước PR này** (kể cả v2.18.8): không cần chạy lệnh nào với bảng. Bản cũ không đọc `signal_context_coins`; dữ liệu ở đó giữ nguyên và được bản mới đọc lại khi lên lại. Trong thời gian chạy bản cũ, coin khác của bài nhiều coin không có snapshot (bản cũ chỉ ghi một tín hiệu mỗi bài).
- Không bao giờ cần `DROP TABLE signal_context_coins` để rollback. Nếu muốn dọn hẳn (chỉ khi đã bỏ hẳn PR này): `DROP TABLE signal_context_coins;` (mất snapshot của các coin khác, không ảnh hưởng lệnh, câu chuyện hay `signal_contexts`).

### 2.22 SoDEX rewards: công tắc `REWARDS_ENABLED` (#546, #547, DEC-397)

| Biến | Service | Ý nghĩa |
|---|---|---|
| `REWARDS_ENABLED` | api | **Mới (#547).** Công tắc toàn hệ thống của SoDEX rewards (mục Rewards, thẻ Overview, `/rewards`) cho **mọi** user; api trả `sodexRewards` trong `GET /api/v1/features`, web đọc lúc chạy (không build lại image web). Mặc định **`true`** từ bản sau #575 (DEC-397 bổ sung); trước đó `false` |
| `SODEX_REWARDS_GATEWAY` → build arg `NEXT_PUBLIC_SODEX_REWARDS_GATEWAY` | web (lúc build) | **Mới (#547), tuỳ chọn.** Origin gateway Rewards API. Trống = `https://mainnet-gw.sodex.dev` (prod không cần đặt). Chỉ nhận https; CSP `connect-src` mở đúng origin này |
| `SODEX_LOTTERY_GATEWAY` → build arg `NEXT_PUBLIC_SODEX_LOTTERY_GATEWAY` | web (lúc build) | **Mới (#601, DEC-405), tuỳ chọn.** Host lottery cho `lottery/progress` (dòng "Trade … more to unlock your next Blind Box" trên thẻ Overview). Trống = `https://mainnet-lottery.sodex.dev` (prod không cần đặt). Chỉ nhận https; CSP `connect-src` mở đúng origin này. **Endpoint không có trong tài liệu Rewards API:** SoDEX có thể đổi bất cứ lúc nào; hỏng thì dòng phụ tự ẩn, phần còn lại của thẻ không ảnh hưởng |

- **Mở cho mọi user (2026-11-27, DEC-397 bổ sung):** mặc định đổi sang `true`. Từ đó biến chỉ còn là **nút tắt khẩn** khi gateway SoDEX có sự cố: `false` thì user thường không thấy Rewards (sidebar, Overview, `/rewards` như trước), team vẫn thấy.
- Mẫu `deploy/server/docker-compose.yml` có dòng `REWARDS_ENABLED: ${REWARDS_ENABLED:-true}` trong khối `environment` của `api`. **Compose trên VPS đang có `${REWARDS_ENABLED:-false}`** (theo mẫu cũ): khi deploy bản mở Rewards phải đặt `REWARDS_ENABLED=true` trong `/opt/drift/.env` hoặc sửa dòng compose thành `:-true`, rồi `cd /opt/drift && docker compose up -d api`; nếu không, Rewards vẫn tắt với user thường.
- Bật / tắt: đặt `REWARDS_ENABLED=true` / `false` trong `/opt/drift/.env`, rồi `docker compose up -d api`. Web nhận giá trị mới khi trình duyệt tải lại `/features` (tối đa ~1 phút).
- **Trang chẩn đoán `/admin/rewards-debug`** (chỉ role team, không có mục sidebar) chạy **cả khi công tắc tắt**: chủ sản phẩm thử bằng ví thật trên prod trước khi mở. Token ký ví chỉ nằm trong trình duyệt (localStorage tới khi `exp` hết hạn, DEC-401; trước đó là sessionStorage); server DeskLabs không nhận (trừ luồng báo box mới của DEC-398), không log.
- Không migration. Không đổi gì ở engine / scheduler.

### 2.23 Báo box mới SoDEX rewards: cờ `REWARDS_WATCH_ENABLED` và migration `0063_rewards_watch` (#558, DEC-398)

| Biến | Service | Ý nghĩa |
|---|---|---|
| `REWARDS_WATCH_ENABLED` | api, scheduler | **Mới (#558 PR1).** Báo box mới: người dùng bật "Tell me about new boxes" lúc ký rewards thì api nhận phiên rewards (JWT) một lần, signer mã hoá, scheduler đọc định kỳ bằng client chỉ đọc và báo in-app. Mặc định **`false`**. Đặt cùng giá trị cho api và scheduler |

- **Giữ `false`** tới khi PM đã xem `aud` / `iss` của token trên `/admin/rewards-debug` và đặt `REWARDS_JWT_AUD_ALLOW` (api, PR3) theo đó. `aud` cho thấy token dùng được cho giao dịch thì không bật, báo người dùng. PR1 chỉ khai báo cờ; route (PR3), job (PR4), web (PR5) làm sau, nên bật cờ ở bản PR1 không làm gì.
- Mẫu `deploy/server/docker-compose.yml` có dòng `REWARDS_WATCH_ENABLED: ${REWARDS_WATCH_ENABLED:-false}` trong khối `environment` của `api` và của `scheduler`. Compose trên VPS thiếu thì thêm vào (như mẫu).
- **Migration `0063_rewards_watch`:** chỉ thêm bảng `rewards_watch` (một dòng mỗi user đã bật; JWT chỉ ở dạng ciphertext Vault transit). Bản trước không đọc bảng này, nên rollback image không cần làm gì với bảng.
- **PR2 (signer + client chỉ đọc + nối scheduler):**
  - Signer có hai endpoint mới: `POST /v1/rewards-tokens/encrypt` (chỉ CN `api`) và `POST /v1/rewards-tokens/decrypt` (CN `scheduler` hoặc `api`, theo `userId`, chỉ dòng `active`). Signer **không** gọi ra ngoài Vault.
  - Biến mới (tuỳ chọn) `VAULT_REWARDS_TRANSIT_KEY` (signer, mặc định `drift-rewards`).
  - Migration `0064_rewards_watch_signer_grant`: `GRANT SELECT (user_id, status, token_ciphertext) ON rewards_watch TO drift_signer` (chỉ khi role có). Rollback không cần làm gì.
  - Signer khởi động bình thường khi Vault chưa có khoá `drift-rewards`: lúc đó hai endpoint trả 503, không ảnh hưởng ký lệnh.
  - Vault (`vault-init`, idempotent mỗi lần khởi động): tạo khoá `drift-rewards` và cho policy `signer` encrypt / decrypt khoá đó. Vault và signer không cần restart.
  - **Cert (DEC-398): scheduler dùng chung cert client của api** (`/certs/api.crt`, `/certs/api.key`, `/certs/ca.crt`). Volume cert prod không có `ca.key` nên không cấp lẻ `scheduler.crt` được, và người dùng chọn không tạo lại cert / không dừng bot. Service `certs` với volume cũ in `certs: present (no scheduler cert; scheduler uses the api client cert, DEC-398)` và không đổi gì; volume trống thì cấp cả `scheduler.crt`. Lần tạo lại toàn bộ cert sau (2.4.1) thì chuyển scheduler sang `scheduler.crt`. Dev: `scripts/dev-up.sh` cấp cert còn thiếu (cộng dồn), compose dev cũng dùng cert api như prod.
  - Khối `scheduler` của compose: `SIGNER_URL`, `SIGNER_CLIENT_CERT=/certs/api.crt`, `SIGNER_CLIENT_KEY=/certs/api.key`, `SIGNER_CLIENT_CA=/certs/ca.crt`, volume `certs:/certs:ro`, network `secure`, `depends_on` `certs`. **Không** chờ signer healthy: signer lỗi thì chỉ job rewards dừng.
  - Thiếu / lỗi file cert thì job rewards tắt, log một lần `rewards watch off: signer client cert unavailable` (chỉ khi `REWARDS_WATCH_ENABLED=true`); scheduler vẫn chạy mọi việc khác.
- **PR3 (api):**
  - Route `POST` / `GET` / `DELETE /api/v1/rewards/watch` (404 khi `REWARDS_WATCH_ENABLED` tắt, cùng lệ với Telegram). `POST` kiểm: tài khoản có SoDEX `connected`, `address` là master wallet, claim JWT (`exp` còn ≥ 1 giờ, hạn ≤ 16 ngày), `aud` theo `REWARDS_JWT_AUD_ALLOW`, ví của token qua `GET sopoints/summary` (client chỉ đọc), rồi mới nhờ signer mã hoá; lưu ciphertext + `exp` / `iat` / `aud` / `iss` / `jti8`. Audit `rewards.watch_enabled` / `rewards.watch_disabled` (không token).
  - Xoá dòng `rewards_watch` khi: `DELETE`, đăng xuất chủ động (`DELETE /api/v1/auth/session`; phiên tự hết hạn thì giữ), ngắt SoDEX (`POST /api/v1/sodex/disconnection` và khi đối soát thấy key đã bị xoá), kết nối account SoDEX khác, xoá tài khoản.
  - Biến mới của api: `REWARDS_JWT_AUD_ALLOW` (giá trị `aud` cách nhau bằng dấu phẩy; **trống = từ chối mọi token**, mặc định), `REWARDS_WATCH_MAX_WEIGHT_PER_MIN` (mặc định `120`), `SODEX_REWARDS_GATEWAY` (trống = mainnet). Mẫu compose có dòng `REWARDS_JWT_AUD_ALLOW: ${REWARDS_JWT_AUD_ALLOW:-}` trong khối `api`.
  - Đặt `REWARDS_JWT_AUD_ALLOW` sau khi PM xem `aud` / `iss` trên `/admin/rewards-debug`. `aud` cho thấy token dùng được cho giao dịch thì không đặt, báo người dùng.
- **PR4 (scheduler):**
  - Job báo box mới chạy ở scheduler (bản leader) mỗi 30 s khi `REWARDS_WATCH_ENABLED=true` **và** có cert client cho signer; tắt thì không chạy. Mỗi lượt tối đa 20 user tới hạn; mỗi user: signer giải mã token (biến cục bộ một lượt), đọc `lottery/treasures` (1) + `lottery/ledger` (5, tối đa 3 trang tới mốc) + `lottery/draw/entries` (5, chỉ khi có giải quay số mới) qua client chỉ đọc (bucket IP chung ưu tiên `idle` 50% + trần riêng), so với mốc ở DB, ghi thông báo vào outbox `jobs.notify` cùng transaction với mốc mới.
  - Lượt đầu chỉ đặt mốc (không báo lịch sử cũ). Phân loại chỉ theo `reason` của ledger: `lottery_prize` → vé trúng (gộp theo round), transfer vào khác → box nhận được; `lifetime.granted` tăng → box chờ claim.
  - 401 / giải mã lỗi → `paused` (`unauthorized`), xoá ciphertext, báo "New box alerts paused" một lần; hết `exp` → `paused` (`expired`) không gọi SoDEX; đổi ví → `paused` (`wallet_changed`); 429 → dừng cả job theo `retryAfter` (Redis `rewards:watch:pause_until`, thiếu thì 60 s); hết ngân sách weight → dừng lượt; lỗi mạng / 5xx → lùi chu kỳ × 2^n (tối đa 6 giờ). Mỗi giờ một dòng log `rewards watch cycle` (chỉ số đếm).
  - Dọn dẹp mỗi 10 phút: dòng `paused` quá 30 ngày bị xoá.
  - Biến mới của scheduler: `REWARDS_WATCH_INTERVAL_MIN` (mặc định `15`, **1–60**; trước #585 là 5–60), `REWARDS_WATCH_MAX_WEIGHT_PER_MIN` (mặc định `120`), `SODEX_REWARDS_GATEWAY` (trống = mainnet). Mẫu compose có hai dòng đầu trong khối `scheduler`. `REWARDS_WATCH_INTERVAL_MIN` sai (không phải số nguyên 1–60, vd `0`, `61`, `abc`) thì dùng `15` và log warn một lần lúc khởi động `REWARDS_WATCH_INTERVAL_MIN invalid (expected an integer 1-60), using default` kèm `received` / `using`.
  - **Chọn chu kỳ theo số user (#585):** mỗi lượt đọc box của một user tốn khoảng **6 weight** (`lottery/treasures` 1 + `lottery/ledger` 5, thường một trang). Có thêm khi hiếm: mỗi trang ledger nữa +5 (tối đa 3 trang, khi có nhiều dòng mới), `lottery/draw/entries` +5 lần đầu gặp round trúng; tin tuần `sopoints/week/list` 5 mỗi 6 giờ (mỗi 10 phút trong cửa sổ chờ tuần COMPLETED / điểm CONFIRMED), `sopoints/summary` 5 một lần mỗi tuần. Với trần riêng `REWARDS_WATCH_MAX_WEIGHT_PER_MIN` = 120: 120 / 6 = 20 lượt mỗi phút, nên **số user tối đa ≈ 20 × số phút chu kỳ** (1 phút ≈ 20 user, 2 phút ≈ 40, 15 phút ≈ 300). Ví dụ 15 user ở chu kỳ 2 phút ≈ 45 weight / phút. Muốn nhiều user hơn ở cùng chu kỳ thì tăng trần theo cùng tỉ lệ (vẫn nhỏ so với 6.000 / phút / IP của SoDEX, và job chỉ chạy khi bucket IP chung còn trên 50%).
  - Vượt mức đó thì **không lỗi**: lượt chạm trần dừng sớm (`budget`, đếm vào `stops` của dòng log `rewards watch cycle`), user còn lại vẫn tới hạn và được đọc ở lượt 30 s sau theo thứ tự `next_check_at` cũ nhất trước, nên chu kỳ thực tế chỉ dài ra. Trạng thái trên web không đổi (chữ "delayed" chỉ hiện khi một user lỗi gateway 3 lần liên tiếp, không phải khi chạm trần).
  - Job chạy mỗi 30 s và hẹn lượt kế tiếp trong khoảng ±10% chu kỳ (dàn user), nên chu kỳ 1 phút thực tế là 60–90 s, 2 phút là 120–150 s. Lỗi mạng / 5xx lùi chu kỳ × 2^n (chu kỳ 1 phút: 2, 4, 8… phút, tối đa 6 giờ), không bao giờ ngắn hơn chu kỳ.
  - Nhóm thông báo mới `rewards`: in-app bật, **Telegram bật khi user đã kết nối Telegram**, email tắt (DEC-398). Hiện trong chuông. Bảng Settings › Notifications và toast ở PR5.
- **#567 (tin tuần SoDEX: tổng kết tuần sau snapshot, điểm tuần SoPoints):**
  - Migration `0065_rewards_watch_weekly`: chỉ thêm ba cột nullable vào `rewards_watch` (`snapshot_week_sent`, `points_week_sent`, `weekly_check_at`). Bản trước không đọc các cột này, nên migrate trước hoặc rollback image không cần làm gì.
  - Cùng job ở trên (cùng `REWARDS_WATCH_ENABLED`, cùng ngân sách weight / 401 / 429), không biến môi trường mới. Mỗi user thêm `sopoints/week/list` (5) theo mốc SoDEX trả (khi tuần kết thúc, mỗi 10 phút lúc chờ tuần COMPLETED / điểm CONFIRMED, còn lại 6 giờ một lần) và `sopoints/summary` (5) một lần mỗi tuần khi điểm đã CONFIRMED.
- **Việc prod cho #558:** chỉ cập nhật `/opt/drift/docker-compose.yml` theo mẫu (configs `vault-init`, `certs-init`; khối `scheduler`) rồi deploy như mục 3. Không tạo lại cert, không cửa sổ bảo trì, không dừng bot. Hành vi bot khi signer / engine bị tạo lại (ghi chú vận hành chung): mục 2.4.2.
- **Bật "New box alerts" báo "Couldn't turn on alerts." (#582).** Response của `POST /api/v1/rewards/watch` (DevTools › Network › Response; KHÔNG chép tab Payload vì có token) cho biết nhánh: `error.code`, `error.details.reason`, `error.details.cause` (từ bản sau #582) và `traceId` (= `reqId` trong log api; banner hiện 8 ký tự đầu là "Reference"). Log api: dòng `rewards watch: enable failed` có cùng `code` / `details`. Với `reason: "signer"`:
  - `cause: "http_403"` = Vault từ chối `transit/encrypt/drift-rewards`: khoá `drift-rewards` chưa tạo **hoặc** policy `signer` cũ (policy chỉ có `update`, nên khoá thiếu cũng ra 403 chứ không phải 400). Sửa: chép config `vault-init` từ mẫu `deploy/server/docker-compose.yml` vào `/opt/drift/docker-compose.yml` (kiểm `grep -c drift-rewards docker-compose.yml` ≥ 3), rồi `docker compose up -d --no-deps vault-init`. `vault-init` chỉ tạo khoá / ghi policy **lúc container khởi động**: sửa file mà không tạo lại container thì vẫn cũ. Signer, Vault không cần restart; log signer có `vault encrypt failed (rewards)` … `failed with 403`.
  - **Sau mọi lần sửa compose ở phần `vault-init`, kiểm** `docker compose logs --tail 20 vault-init | grep -viE 'token|unseal key|root'` có `vault: ready`, và `docker compose ps vault-init` là `healthy`. Gặp `syntax error` (vd `line 48: syntax error: unexpected "|"`) thì gần như chắc là **khoảng trắng sau dấu `\` nối dòng** (chép tay từ mẫu). Tìm: `grep -nE '\\[[:space:]]+$' docker-compose.yml | cut -d: -f1` (chỉ in số dòng); xoá khoảng trắng, rồi `docker compose up -d --no-deps vault-init`. Trường hợp đã gặp (#582): khoá `drift-rewards` được tạo nhưng policy `signer` không được ghi (Vault 403), và `vault-init` restart liên tục nên **vòng tự unseal cũng không chạy**: Vault reboot lúc đó sẽ sealed tới khi sửa.
  - Từ bản sau #582, `infra/deploy/build-push.sh --deploy-only` tự làm hai kiểm này: (1) trước khi pull, từ chối deploy nếu `docker-compose.yml` có khoảng trắng sau `\` (in số dòng); (2) sau `up -d`, chờ `vault-init` `healthy` tối đa khoảng 2 phút, không được thì in 15 dòng log (đã bỏ dòng có token / unseal / root) và thoát khác 0 (app mới vẫn chạy, chưa dọn image cũ).
  - `cause: "http_404"` = signer chạy image trước #562 (chưa có route): `docker compose images signer`, deploy lại signer đúng tag.
  - `cause: "http_503"` = Vault sealed / không tới được (log signer `vault encrypt failed (rewards)`): xem `docker compose logs vault-init` (tự unseal mỗi 15 s).
  - `cause: "network"` / `"timeout"` = api không tới được signer qua mTLS (cert client của api, network `secure`).
  - `reason: "gateway"` kèm `cause` (`http_status` + `status`, `schema`, `business` + `businessCode`, `network`, `timeout`): gateway SoDEX từ chối / lỗi khi gọi từ VPS.

### 2.24 US Market + SoDEX Wealth: công tắc `US_MARKET_ENABLED` (#589, DEC-402)

| Biến | Service | Ý nghĩa |
|---|---|---|
| `US_MARKET_ENABLED` | api | **Mới (#589).** Công tắc toàn hệ thống của US Market + SoDEX Wealth (banner Strategy Lab, `/markets/us`, Portfolio › My Wealth). api trả `usMarket` trong `GET /api/v1/features`. Mặc định **`true`**. `false` thì `GET /api/v1/markets/us` và `GET /api/v1/wealth/me` trả 404 và web ẩn các phần trên. Giới hạn theo sổ lệnh của bot (DEC-402 mục 5) **không** phụ thuộc công tắc này |
| `WEALTH_READ_MAX_WEIGHT_PER_MIN` | api | **Mới (#589), tuỳ chọn.** Trần riêng weight / phút cho lời gọi SoDEX Wealth API từ api (bucket `rl:sodex:wealth:<egress>`). Mặc định `400`. Mỗi lời gọi tính 20: đây là **giả định chưa đo**, SoDEX không công bố weight của route Wealth (tài liệu Rate limits không liệt kê), nên tính như endpoint không liệt kê |

- Đọc công khai, chỉ GET: Wealth API `https://mainnet-gw.sodex.dev/api/v1/wealth/...` (danh sách quỹ, `trading-status`, vị thế / PnL / in-flight / sổ cái / mua định kỳ / PnL history theo master wallet của tài khoản), không token, không chữ ký, không lưu DB. Sổ lệnh 10 mức, ticker và symbol qua REST SoDEX sẵn có.
- Bucket IP chung với giao dịch: Wealth chỉ lấy token khi bucket còn trên 50% (như rewards). Hết ngân sách thì phần đó trả "Not provided" (`/markets/us`) hoặc 429 `RATE_LIMITED` kèm `details.reason = "sodex_wealth_budget"` và `details.retryAfterMs` (`/wealth/me`, #592: web hiện "SoDEX Wealth is busy…", không hiện "Not provided"), không ảnh hưởng lệnh của bot.
- Cache trong bộ nhớ api: `/markets/us` 30 s (mỗi market một lần đọc sổ lệnh mỗi chu kỳ, không theo số người xem; mỗi chu kỳ khoảng 20 weight REST + 20 × (1 + số quỹ không phải token sổ lệnh) weight Wealth), `/wealth/me` **90 s** theo địa chỉ (#592). Mỗi lượt đọc mặc định 4 lời gọi Wealth theo địa chỉ (`pnl`, `positions`, `in-flight`, `fund-details`) = 80 weight (giả định 20 / lời gọi), cộng danh sách quỹ dùng chung với `/markets/us` (20 weight mỗi 30 s cho cả hệ thống). `recurring-buys` và `pnl-history` chỉ đọc khi gọi `?include=recurringBuys,pnlHistory` (mỗi phần +20, cache riêng 90 s); tab My Wealth hiện không gọi hai phần này. Với trần 400 / phút: khoảng 5 lượt tải mới mỗi phút (trước #592: 6 lời gọi = 120 weight, khoảng 3 lượt).
- Log api không có địa chỉ ví: dòng `wealth: read failed` / `us market: read failed` chỉ có phần và lý do.
- Bật / tắt: đặt `US_MARKET_ENABLED=true` / `false` trong `/opt/drift/.env`, rồi `cd /opt/drift && docker compose up -d api`. Compose trên VPS thiếu dòng `US_MARKET_ENABLED: ${US_MARKET_ENABLED:-true}` trong khối `api` thì thêm theo mẫu (thiếu dòng thì api vẫn dùng mặc định `true`).
- Không migration. Không đổi gì ở engine / scheduler trong #589.

### 2.25 Giới hạn theo sổ lệnh: biến `DEPTH_CAP_MARKETS` (#590, DEC-402 mục 5 và bổ sung 2026-11-28)

| Biến | Service | Ý nghĩa |
|---|---|---|
| `DEPTH_CAP_MARKETS` | api + engine (cùng giá trị) | **Mới (#590).** Market áp giới hạn theo sổ lệnh. `default` hoặc không đặt = `ANT-USD`, `vANT_vUSDC`, `vVOO_vUSDC`, `vQQQ_vUSDC`, `vSCHD_vUSDC`, `vSMH_vUSDC`, `vVGT_vUSDC`, `vVYM_vUSDC`, `vBOXX_vUSDC`, `vSTRC_vUSDC`. Chuỗi trống = tắt hẳn. `*` = mọi market (có hỗ trợ, chưa dùng; cần chủ sản phẩm quyết). Hoặc danh sách phân cách dấu phẩy. |

- Trong danh sách, và chỉ khi sổ 10 mức của market đang `Thin` / `Very thin` / rỗng: engine cắt lệnh vào khớp ngay về 25% phía nó ăn, hoặc cho lệnh vào chờ; api từ chối tạo bot / sửa tăng vốn khi tổng vị thế tối đa lớn hơn phía mỏng hơn. Lệnh đóng, reduce-only, SL / TP, Stop và lệnh maker không bao giờ bị cắt hay chờ. Bot paper không áp.
- Ngoài danh sách: không đọc sổ, không cắt, không kiểm. Thêm request REST chỉ ở bước có lệnh vào khớp ngay của market trong danh sách (engine cache 3 s, api cache 30 s, bucket IP chung).
- api trả danh sách đang hiệu lực qua `GET /api/v1/features` (`depthCapMarkets`; `["*"]` = mọi market, `[]` = tắt) để web hiện đúng.
- Mẫu compose truyền `${DEPTH_CAP_MARKETS-default}` (dấu `-`, không phải `:-`): thiếu biến trong `.env` thì dùng danh sách mặc định, đặt trống thì tắt. Compose trên VPS thiếu dòng này thì engine / api vẫn dùng danh sách mặc định.
- Đổi danh sách hoặc tắt: sửa `DEPTH_CAP_MARKETS` trong `/opt/drift/.env`, rồi `cd /opt/drift && docker compose up -d api engine` (luôn đổi cả hai service cùng lúc).
- Sau deploy: Decisions "Order reduced" / "Waiting: order book empty" / "Waiting: order book too thin" chỉ được xuất hiện ở bot trên market trong danh sách; log engine `entry held: order book depth unknown` là đọc sổ lỗi (lệnh vào chờ, lệnh đóng vẫn đi).
- Không migration.

### 2.26 Cảnh báo SoDEX Wealth: cờ `WEALTH_WATCH_ENABLED` và migration `0067_wealth_watch` (#594, DEC-404)

| Biến | Service | Ý nghĩa |
|---|---|---|
| `WEALTH_WATCH_ENABLED` | api + scheduler (cùng giá trị) | **Mới (#594).** Công tắc hệ thống của cảnh báo SoDEX Wealth (công tắc "Alerts" ở Portfolio › My Wealth, nhóm thông báo `wealth`). Mặc định **`false`**: user thường không thấy công tắc (`/api/v1/features.wealthAlerts` = false, route `/api/v1/wealth/watch` trả 404, nhóm không có trong Settings), **role team vẫn dùng được** và job scheduler chỉ đọc cho user role team. `true` = mọi user (khi `US_MARKET_ENABLED` cũng bật) |
| `WEALTH_WATCH_INTERVAL_MIN` | scheduler | **Mới (#594), tuỳ chọn.** Chu kỳ đọc mỗi user, phút, `5`–`60`, mặc định `10`. Sai giá trị thì dùng `10` và log một dòng warn `WEALTH_WATCH_INTERVAL_MIN invalid` lúc khởi động |
| `WEALTH_READ_MAX_WEIGHT_PER_MIN` | api + scheduler (cùng giá trị) | Đã có ở api (#589, mục 2.24). Scheduler đọc cùng biến để job và `/wealth/me` dùng **chung một trần** (bucket `rl:sodex:wealth:<egress>`). Job chỉ lấy token khi trần còn **trên 50%** (dành phần còn lại cho người đang xem) và khi bucket IP chung còn trên 50% |

- **Đọc gì:** dữ liệu Wealth công khai theo master wallet của user đã bật (không token, không chữ ký, allowlist GET): `users/{a}/fund-details` mỗi lượt; `users/{a}/recurring-buys?status=active` chỉ khi user có plan (hoặc fund-details có dòng mua định kỳ; chưa có plan thì kiểm lại tối đa mỗi ngày một lần); `users/{a}/recurring-buys/{p}/executions` cho từng plan ACTIVE; `funds` (tên quỹ) chỉ khi có tin cần gửi, cache 30 phút. Mỗi lượt một user: 20 + (20 nếu có plan) + 20 × số plan ACTIVE weight (giả định 20 / lời gọi chưa đo). Hết ngân sách thì dời sang lượt sau (tick 30 s), không tính lỗi. Lỗi khác lùi user đó (chu kỳ × 2^lần, tối đa 6 giờ). `recurring-buys` trả `code -1` = không có kế hoạch (không tính lỗi).
- **Lưu gì:** bảng `wealth_watch`, mỗi user một dòng: khoá đã băm của từng dòng SoDEX + trạng thái đã thấy, cờ "có plan", lịch đọc. Không vị thế, không số tiền, không địa chỉ. Xoá khi user tắt, ngắt SoDEX, xoá tài khoản (và job tự xoá dòng nếu tài khoản SoDEX không còn kết nối).
- **Log:** giá trị SoDEX lạ (trạng thái fund-details, trạng thái / `reasonCode` của kỳ mua) không báo, chỉ log `wealth watch: unknown SoDEX value, not alerted` với `field` + `value` + `userId` (không địa chỉ ví). Mỗi giờ một dòng `wealth watch cycle` (chỉ số đếm). Trước khi bật cho mọi user: chủ sản phẩm bật "Alerts" bằng tài khoản team của mình, tạo / đợi một yêu cầu Wealth và một kỳ mua định kỳ, rồi xem log này để chốt các giá trị **[confirm]** ở `packages/shared/src/api/wealth-watch.ts` (`WEALTH_EXECUTION_ALERT_STATUSES`, `WEALTH_EXECUTION_REASONS`).
- **Migration `0067_wealth_watch`:** chỉ thêm bảng; bản api / scheduler trước không đọc bảng này, nên migrate trước hoặc rollback không cần làm gì.
- **Bật cho mọi user:** đặt `WEALTH_WATCH_ENABLED=true` trong `/opt/drift/.env`, rồi `cd /opt/drift && docker compose up -d api scheduler` (luôn đổi cả hai). Compose trên VPS thiếu các dòng `WEALTH_WATCH_*` / `WEALTH_READ_MAX_WEIGHT_PER_MIN` trong khối `api` và `scheduler` thì thêm theo mẫu `deploy/server/docker-compose.yml` (thiếu dòng thì dùng mặc định: tắt, 10 phút, 400).

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
