#!/bin/sh
# Production 1 host (DEC-70). Chạy liên tục trong container `vault-init`:
#   - lần đầu: init (1 unseal key), bật transit, tạo khoá `drift-api-keys`, policy `signer` chỉ encrypt/decrypt
#     khoá đó, và token của signer (id = SIGNER_TOKEN = VAULT_TOKEN trong .env) sống 10 năm, không có quyền khác;
#   - mỗi 15 s: nếu Vault đang sealed (vừa restart / VPS reboot) thì unseal.
# Đánh đổi: unseal key nằm trong volume `vaultinit` trên cùng máy để bot tự chạy lại sau reboot. Ai có root trên
# VPS thì đọc được. Chép /vault/init/init.txt ra chỗ an toàn ngoài VPS (trình quản lý mật khẩu) ngay sau lần đầu.
set -eu
export VAULT_ADDR="http://vault:8200"
INIT=/vault/init/init.txt
READY=/tmp/ready

until vault status >/dev/null 2>&1 || [ $? -eq 2 ]; do sleep 2; done

if vault status 2>/dev/null | grep -q '^Initialized *false'; then
  vault operator init -key-shares=1 -key-threshold=1 > "$INIT"
  chmod 600 "$INIT"
  echo "vault: initialized — copy $INIT off the server now"
fi
if [ ! -s "$INIT" ]; then
  echo "vault: initialized but $INIT is missing; restore the vaultinit volume from backup" >&2
  exit 1
fi
UNSEAL=$(sed -n 's/^Unseal Key 1: //p' "$INIT")
ROOT=$(sed -n 's/^Initial Root Token: //p' "$INIT")

unseal() {
  if vault status 2>/dev/null | grep -q '^Sealed *true'; then
    vault operator unseal "$UNSEAL" >/dev/null
    echo "vault: unsealed"
  fi
}

unseal
export VAULT_TOKEN="$ROOT"
vault secrets list | grep -q '^transit/' || vault secrets enable transit
vault read transit/keys/drift-api-keys >/dev/null 2>&1 \
  || vault write -f transit/keys/drift-api-keys type=aes256-gcm96 >/dev/null
# Không cho xoá khoá transit (mất khoá = mất mọi API key đã mã hoá).
vault write transit/keys/drift-api-keys/config deletion_allowed=false >/dev/null
printf '%s\n' \
  'path "transit/encrypt/drift-api-keys" { capabilities = ["update"] }' \
  'path "transit/decrypt/drift-api-keys" { capabilities = ["update"] }' \
  | vault policy write signer - >/dev/null
# Signer chỉ đăng nhập một lần lúc khởi động và không renew token, nên token phải sống lâu.
vault auth tune -max-lease-ttl=87600h token/ >/dev/null
vault token lookup "$SIGNER_TOKEN" >/dev/null 2>&1 \
  || vault token create -id="$SIGNER_TOKEN" -policy=signer -no-default-policy -orphan -ttl=87600h >/dev/null
unset VAULT_TOKEN
touch "$READY"
echo "vault: ready"

while true; do
  sleep 15
  unseal
done
