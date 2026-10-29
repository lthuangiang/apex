#!/usr/bin/env sh
# Sinh CA nội bộ và cert cho mTLS api/engine ↔ signer (DEC-42). CHỈ dùng cho dev / E2E; production cấp cert
# bằng PKI riêng. Cách dùng: infra/certs/gen-dev-certs.sh <thư-mục-đích>
# Production 1 host (DEC-70) dùng lại script này với CERT_DAYS=1095 trên chính VPS; cert hết hạn thì signer từ
# chối mọi kết nối, nên phải tạo lại trước ngày hết hạn (docs/DEPLOY.md).
set -eu
OUT="${1:-infra/certs/dev}"
DAYS="${CERT_DAYS:-365}"
mkdir -p "$OUT"
cd "$OUT"
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -subj "/CN=drift-internal-ca" -days "$DAYS" -out ca.crt 2>/dev/null
issue() {
  name="$1"; cn="$2"; ext="$3"
  openssl req -newkey rsa:2048 -nodes -keyout "$name.key" -subj "/CN=$cn" -out "$name.csr" 2>/dev/null
  if [ -n "$ext" ]; then printf '%s\n' "$ext" > "$name.ext"; set -- -extfile "$name.ext"; else set --; fi
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days "$DAYS" -out "$name.crt" "$@" 2>/dev/null
  rm -f "$name.csr" "$name.ext"
}
issue signer signer "subjectAltName=DNS:signer,DNS:localhost,IP:127.0.0.1"
issue api api ""
issue engine engine ""
chmod 644 ./*.crt ./*.key
echo "certs written to $OUT"
