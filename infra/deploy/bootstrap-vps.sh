#!/usr/bin/env bash
# Chạy MỘT LẦN trên VPS mới (Ubuntu 24.04, arm64 hoặc amd64), bằng root: bash bootstrap-vps.sh
# Việc làm: cập nhật + vá tự động, Docker (repo chính thức), user `deploy`, swap, firewall, khoá SSH bằng mật
# khẩu, thư mục /opt/drift, xoay vòng log Docker, backup hằng ngày. Idempotent: chạy lại không hỏng gì. DEC-70.
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
SWAP_SIZE="${SWAP_SIZE:-4G}"
APP_DIR=/opt/drift

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -s /root/.ssh/authorized_keys ] || { echo "add your SSH public key to /root/.ssh/authorized_keys first" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl gnupg ufw fail2ban unattended-upgrades age rsync
dpkg-reconfigure -f noninteractive unattended-upgrades

# Docker Engine + compose plugin từ repo apt chính thức của Docker.
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
mkdir -p /etc/docker
[ -f /etc/docker/daemon.json ] || cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
JSON
systemctl enable --now docker
systemctl restart docker

# User deploy: GitHub Actions SSH vào bằng user này, không dùng root.
id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

# Swap: 4 GB RAM khá chật, swap để backtest dài chạy chậm lại thay vì bị OOM kill.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null
echo 'vm.swappiness=10' > /etc/sysctl.d/99-drift.conf

# Firewall: chỉ SSH, HTTP, HTTPS. Postgres, Redis, NATS, Vault không mở cổng nào ra ngoài.
# Lưu ý: Docker tự mở cổng của container (80, 443 của traefik) qua iptables, không qua ufw; compose chỉ publish
# hai cổng đó (và mailpit 127.0.0.1 ở profile dev, không chạy ở prod). Nên bật thêm Firewall trong panel Hetzner.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# SSH chỉ bằng key.
cat > /etc/ssh/sshd_config.d/99-drift.conf <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHD
systemctl reload ssh || systemctl reload sshd

install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR" "$APP_DIR/certs" "$APP_DIR/backups"

# Backup hằng ngày 03:15 giờ máy (infra/deploy/backup.sh, được workflow deploy chép lên).
cat > /etc/cron.d/drift-backup <<CRON
15 3 * * * $DEPLOY_USER [ -x $APP_DIR/infra/deploy/backup.sh ] && $APP_DIR/infra/deploy/backup.sh >> $APP_DIR/backups/backup.log 2>&1
CRON

echo
echo "Done. Next:"
echo "  1. Put the GitHub Actions deploy public key in /home/$DEPLOY_USER/.ssh/authorized_keys"
echo "  2. Create $APP_DIR/.env from .env.production.example (as $DEPLOY_USER)"
echo "  3. Generate mTLS certs: CERT_DAYS=1095 sh gen-dev-certs.sh $APP_DIR/certs"
echo "  See docs/DEPLOY.md."
