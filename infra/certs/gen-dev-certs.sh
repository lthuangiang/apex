#!/usr/bin/env sh
# Sinh CA nội bộ và cert cho mTLS api / engine / scheduler ↔ signer (DEC-42, DEC-398). CHỈ dùng cho dev / E2E;
# production cấp cert bằng service `certs` của compose (deploy/server/docker-compose.yml).
# Cách dùng: infra/certs/gen-dev-certs.sh <thư-mục-đích>
#
# Cộng dồn: thư mục đã có CA (ca.crt + ca.key) thì dùng lại CA đó và chỉ cấp cert còn thiếu, cert đang có không đổi
# (signer / api / engine đang chạy không bị ảnh hưởng). Thư mục trống thì tạo CA mới và mọi cert.
# Có ca.crt mà mất ca.key thì không cấp thêm được: xoá thư mục rồi chạy lại để tạo lại toàn bộ.
set -eu
OUT="${1:-infra/certs/dev}"
DAYS="${CERT_DAYS:-365}"
mkdir -p "$OUT"
cd "$OUT"
if [ -s ca.crt ] && [ -s ca.key ]; then
  echo "certs: reusing CA in $OUT"
elif [ -s ca.crt ]; then
  echo "certs: $OUT has ca.crt but no ca.key, so new certs cannot be issued. Remove the directory and run again to recreate all certs." >&2
  exit 1
else
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -subj "/CN=drift-internal-ca" -days "$DAYS" -out ca.crt 2>/dev/null
fi
issue() {
  name="$1"; cn="$2"; ext="$3"
  if [ -s "$name.crt" ] && [ -s "$name.key" ]; then return 0; fi
  openssl req -newkey rsa:2048 -nodes -keyout "$name.key" -subj "/CN=$cn" -out "$name.csr" 2>/dev/null
  if [ -n "$ext" ]; then printf '%s\n' "$ext" > "$name.ext"; set -- -extfile "$name.ext"; else set --; fi
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days "$DAYS" -out "$name.crt" "$@" 2>/dev/null
  rm -f "$name.csr" "$name.ext"
}
issue signer signer "subjectAltName=DNS:signer,DNS:localhost,IP:127.0.0.1"
issue api api ""
issue engine engine ""
# #558 / DEC-398: scheduler gọi signer để giải mã phiên rewards (chỉ endpoint decrypt nhận CN này).
issue scheduler scheduler ""
chmod 644 ./*.crt ./*.key
echo "certs written to $OUT"
