import { readFileSync } from "node:fs";

import type { ClientTls } from "@drift/runtime";

// #558 (DEC-398): scheduler gọi signer (mTLS) để giải mã phiên rewards. Compose cho scheduler dùng chung cert client
// của api (CN `api`; prod chưa có cert `scheduler`), lần tạo lại toàn bộ cert sau thì chuyển sang `scheduler.crt`
// (docs/DEPLOY.md 2.4.1). Thiếu / lỗi file cert thì job rewards tắt, scheduler vẫn chạy mọi việc khác. Hàm này không bao
// giờ ném lỗi và không đọc nội dung khoá ra log.

export type RewardsSignerState =
  | { kind: "ready"; url: string; tls: ClientTls }
  | {
      kind: "off";
      reason: "watch_disabled" | "not_configured" | "cert_missing" | "cert_unreadable";
    };

type ReadFile = (path: string) => string;

/** Giá trị env đã bỏ khoảng trắng; thiếu / rỗng thì null. */
const present = (v: string | undefined): string | null => {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
};

/**
 * Đọc cấu hình signer cho job rewards. `SIGNER_URL` + `SIGNER_CLIENT_CERT` / `_KEY` / `_CA` (cùng tên biến với api và
 * engine). Tắt cờ → `watch_disabled`; thiếu biến → `not_configured`; file không có → `cert_missing`; lỗi đọc khác →
 * `cert_unreadable`.
 */
export function loadRewardsSignerState(
  env: Record<string, string | undefined>,
  watchEnabled: boolean,
  read: ReadFile = (p) => readFileSync(p, "utf8"),
): RewardsSignerState {
  if (!watchEnabled) return { kind: "off", reason: "watch_disabled" };
  const url = present(env.SIGNER_URL);
  const certPath = present(env.SIGNER_CLIENT_CERT);
  const keyPath = present(env.SIGNER_CLIENT_KEY);
  const caPath = present(env.SIGNER_CLIENT_CA);
  if (url === null || certPath === null || keyPath === null || caPath === null)
    return { kind: "off", reason: "not_configured" };
  try {
    const tls = { cert: read(certPath), key: read(keyPath), ca: read(caPath) };
    return { kind: "ready", url, tls };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { kind: "off", reason: code === "ENOENT" ? "cert_missing" : "cert_unreadable" };
  }
}
