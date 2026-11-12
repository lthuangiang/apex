// Nội dung `/.well-known/assetlinks.json` (route ở app/.well-known/assetlinks.json): xem chú thích ở route.

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function assetLinks(env: Record<string, string | undefined>): unknown[] {
  const pkg = env.ANDROID_PACKAGE_NAME?.trim() ?? "";
  const prints = (env.ANDROID_CERT_SHA256 ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => FINGERPRINT.test(s));
  if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(pkg) || prints.length === 0) return [];
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints },
    },
  ];
}
