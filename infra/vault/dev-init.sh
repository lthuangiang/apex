#!/bin/sh
# DEV ONLY: init (lần đầu) → unseal (mỗi lần Vault khởi động) → token cố định cho signer → transit + khoá.
# Unseal key và root token dev nằm trong volume `vaultinit`, chỉ container này mount. Idempotent.
set -eu
export VAULT_ADDR="http://vault:8200"
INIT=/vault/init/init.txt

if vault status 2>/dev/null | grep -q '^Initialized *false'; then
  vault operator init -key-shares=1 -key-threshold=1 > "$INIT"
  chmod 600 "$INIT"
  echo "vault: initialized"
fi
if [ ! -s "$INIT" ]; then
  echo "vault: initialized but $INIT is missing; remove the vaultdata volume to start over (dev only)" >&2
  exit 1
fi
UNSEAL=$(sed -n 's/^Unseal Key 1: //p' "$INIT")
ROOT=$(sed -n 's/^Initial Root Token: //p' "$INIT")
if vault status 2>/dev/null | grep -q '^Sealed *true'; then
  vault operator unseal "$UNSEAL" >/dev/null
  echo "vault: unsealed"
fi

export VAULT_TOKEN="$ROOT"
# Token dev mà signer dùng (VAULT_TOKEN trong .env), giữ nguyên giá trị qua các lần restart.
vault token lookup "$DEV_TOKEN" >/dev/null 2>&1 || vault token create -id="$DEV_TOKEN" -policy=root -orphan >/dev/null
vault secrets list | grep -q '^transit/' || vault secrets enable transit
vault read transit/keys/drift-api-keys >/dev/null 2>&1 || vault write -f transit/keys/drift-api-keys type=aes256-gcm96 >/dev/null
echo "vault: ready"
