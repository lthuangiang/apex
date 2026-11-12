#!/usr/bin/env bash
# Build app Android của DRIFT dạng TWA (Trusted Web Activity): APK mở web DRIFT trên tên miền prod trong Chrome,
# toàn màn hình, không thanh địa chỉ. Không có code native; deploy web là app cập nhật theo. Hướng dẫn: README.md.
# Chạy được từ bất kỳ đâu: script tự về gốc repo.
#
#   infra/mobile/build-apk.sh                                       # lần đầu: init trên desklabs.xyz (hỏi vài câu) + build
#   infra/mobile/build-apk.sh                                       # các lần sau: build lại với cấu hình đã lưu
#   infra/mobile/build-apk.sh --update                              # áp thay đổi của android/twa-manifest.json rồi build
#   infra/mobile/build-apk.sh --install                             # build xong cài lên máy Android đang cắm (adb)
#
# Biến môi trường (tuỳ chọn):
#   DRIFT_DOMAIN                  tên miền prod (mặc định desklabs.xyz), thay cho --domain
#   BUBBLEWRAP_KEYSTORE_PASSWORD  mật khẩu keystore; không đặt thì Bubblewrap hỏi khi build
#   BUBBLEWRAP_KEY_PASSWORD       mật khẩu key trong keystore
# Kết quả ở infra/mobile/out/: drift-<thời điểm>.apk (cài thẳng), .aab (Google Play), assetlinks.json;
# cuối script in sẵn hai dòng ANDROID_* để dán vào .env trên server.
# Keystore nằm ở infra/mobile/android/android.keystore: KHÔNG commit, PHẢI sao lưu (mất là không cập nhật được app).
set -euo pipefail

cd "$(dirname "$0")/../.."
[ -f pnpm-workspace.yaml ] || { echo "error: cannot find the repo root" >&2; exit 1; }

DIR="infra/mobile/android"
OUT="infra/mobile/out"
DOMAIN="${DRIFT_DOMAIN:-desklabs.xyz}"
UPDATE=false
INSTALL=false
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain needs a host, e.g. drift.example.com}"; shift 2 ;;
    --update) UPDATE=true; shift ;;
    --install) INSTALL=true; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "error: unknown option '$1' (see --help)" >&2; exit 1 ;;
  esac
done
# Chấp nhận cả "https://drift.example.com/" lẫn "drift.example.com".
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"

command -v node >/dev/null || { echo "error: Node.js is required (node 18+)" >&2; exit 1; }
if command -v bubblewrap >/dev/null; then
  BW=(bubblewrap)
else
  echo "bubblewrap not installed globally; using npx @bubblewrap/cli"
  BW=(npx --yes @bubblewrap/cli)
fi

mkdir -p "$DIR" "$OUT"

# ---------- Lần đầu: tạo project TWA từ web manifest ----------
if [ ! -f "$DIR/twa-manifest.json" ]; then
  [ -n "$DOMAIN" ] || { echo "error: first run needs --domain <prod host>" >&2; exit 1; }
  case "$DOMAIN" in
    localhost*|127.*) echo "error: a TWA needs a real HTTPS domain, not $DOMAIN" >&2; exit 1 ;;
  esac
  MANIFEST="https://$DOMAIN/manifest.webmanifest"
  code="$(curl -s -o /dev/null -w '%{http_code}' "$MANIFEST" || true)"
  if [ "$code" != "200" ]; then
    echo "error: $MANIFEST returned ${code:-no response}." >&2
    echo "       Deploy the latest web image first (it serves the manifest, README.md step 1)." >&2
    exit 1
  fi
  echo "==> init from $MANIFEST"
  echo "    Suggested answers: Application ID com.drift.app (cannot change after publishing),"
  echo "    create a new signing key (Bubblewrap writes android.keystore)."
  (cd "$DIR" && "${BW[@]}" init --manifest="$MANIFEST")
elif [ "$UPDATE" = true ]; then
  echo "==> update from twa-manifest.json"
  (cd "$DIR" && "${BW[@]}" update)
fi

# ---------- Build APK + AAB đã ký ----------
echo "==> build"
(cd "$DIR" && "${BW[@]}" build)

STAMP="$(date -u +%Y%m%d%H%M%S)"
APK="$OUT/drift-$STAMP.apk"
AAB="$OUT/drift-$STAMP.aab"
[ -f "$DIR/app-release-signed.apk" ] || { echo "error: build produced no app-release-signed.apk" >&2; exit 1; }
cp "$DIR/app-release-signed.apk" "$APK"
[ ! -f "$DIR/app-release-bundle.aab" ] || cp "$DIR/app-release-bundle.aab" "$AAB"

# ---------- Digital Asset Links: để Android ẩn thanh địa chỉ ----------
# Đọc fingerprint từ chính APK vừa ký (public, không cần mật khẩu keystore). `bubblewrap fingerprint generateAssetLinks`
# đọc danh sách trong twa-manifest.json, danh sách này trống nên ra `[]`.
KEYTOOL="$(command -v keytool || true)"
if [ -z "$KEYTOOL" ]; then
  KEYTOOL="$(find "$HOME/.bubblewrap/jdk" -type f -name keytool 2>/dev/null | head -n 1)"
fi
PACKAGE="$(node -p "require('./$DIR/twa-manifest.json').packageId")"
SHA256=""
if [ -n "$KEYTOOL" ]; then
  SHA256="$("$KEYTOOL" -printcert -jarfile "$APK" 2>/dev/null | sed -n 's/^[[:space:]]*SHA256: //p' | head -n 1)"
fi
if [ -n "$SHA256" ]; then
  cat > "$OUT/assetlinks.json" <<JSON
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "$PACKAGE",
      "sha256_cert_fingerprints": ["$SHA256"]
    }
  }
]
JSON
else
  echo "warning: could not read the signing fingerprint from the APK (keytool not found)" >&2
fi

echo
echo "APK (install directly):  $APK"
[ ! -f "$AAB" ] || echo "AAB (Google Play):       $AAB"
if [ -n "$SHA256" ]; then
  echo
  echo "Add to .env on the server, then run: docker compose up -d web"
  echo "ANDROID_PACKAGE_NAME=$PACKAGE"
  echo "ANDROID_CERT_SHA256=$SHA256"
  echo
fi
echo "Back up $DIR/android.keystore and its password. Without them you cannot update the app."

if [ "$INSTALL" = true ]; then
  command -v adb >/dev/null || { echo "error: adb not found (Android SDK platform-tools)" >&2; exit 1; }
  echo "==> adb install"
  adb install -r "$APK"
fi
