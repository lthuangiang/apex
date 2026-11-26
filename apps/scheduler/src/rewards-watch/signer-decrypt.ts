import { postJson, type ClientTls } from "@drift/runtime";
import { rewardsJwtSchema } from "@drift/shared";
import { z } from "zod";

// #558 (DEC-398): xin signer giải mã phiên rewards của MỘT user (`/v1/rewards-tokens/decrypt`, mTLS). Token trả về chỉ
// là biến cục bộ của người gọi, dùng cho một lượt đọc rồi bỏ; không cache, không log, không đưa vào lỗi.

export type RewardsDecryptResult =
  | { kind: "ok"; token: string }
  /** Dòng không còn `active` (vừa tắt / tạm dừng). */
  | { kind: "not_active" }
  /** Ciphertext không giải mã được (khoá Vault mất / đổi): coi như token hỏng, người dùng ký lại. */
  | { kind: "unusable" }
  /** Signer / Vault / mạng lỗi: thử lại lượt sau (lùi). */
  | { kind: "unavailable" };

export type RewardsDecrypt = (userId: string) => Promise<RewardsDecryptResult>;

const responseSchema = z.object({ token: rewardsJwtSchema });

export function httpRewardsDecrypt(url: string, tls: ClientTls): RewardsDecrypt {
  const base = url.replace(/\/+$/, "");
  return async (userId) => {
    let res: { status: number; json: unknown };
    try {
      res = await postJson(
        `${base}/v1/rewards-tokens/decrypt`,
        { userId },
        { tls, timeoutMs: 5000 },
      );
    } catch {
      return { kind: "unavailable" };
    }
    if (res.status === 404) return { kind: "not_active" };
    if (res.status === 422) return { kind: "unusable" };
    if (res.status !== 200) return { kind: "unavailable" };
    const parsed = responseSchema.safeParse(res.json);
    return parsed.success ? { kind: "ok", token: parsed.data.token } : { kind: "unusable" };
  };
}
