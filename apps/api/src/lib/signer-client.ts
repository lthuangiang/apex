import { postJson, type ClientTls } from "@drift/runtime";
import { z } from "zod";

import type { RewardsSignerFailure, RewardsTokenSigner } from "../modules/rewards-watch/service";
import type { SignerClient } from "../modules/sodex/service";

// Gọi signer trong network `secure`, qua mTLS khi có cert (DEC-42; CN `api` chỉ được tạo key). Timeout 5 s (C5).
const responseSchema = z.object({
  id: z.uuid(),
  publicKey: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

/** Kết quả verify được nhớ 60 s mỗi key: `/sodex/connection` được gọi định kỳ từ mọi tab. */
const VERIFY_TTL_MS = 60_000;

export function httpSignerClient(baseUrl: string, tls?: ClientTls): SignerClient {
  const base = baseUrl.replace(/\/+$/, "");
  const verified = new Map<string, { at: number; result: "ok" | "unusable" }>();
  return {
    async verifyApiKey(id) {
      const hit = verified.get(id);
      if (hit !== undefined && Date.now() - hit.at < VERIFY_TTL_MS) return hit.result;
      let status: number;
      try {
        status = (await postJson(`${base}/v1/keys/${id}/verify`, {}, { tls, timeoutMs: 5000 }))
          .status;
      } catch {
        return "unavailable";
      }
      const result = status === 204 ? "ok" : status === 422 ? "unusable" : null;
      if (result === null) return "unavailable";
      verified.set(id, { at: Date.now(), result });
      return result;
    },
    async createApiKey(input) {
      const res = await postJson(`${base}/v1/api-keys`, input, { tls, timeoutMs: 5000 });
      if (res.status !== 201) throw new Error(`signer returned ${String(res.status)}`);
      return responseSchema.parse(res.json);
    },
  };
}

const rewardsEncryptSchema = z.object({
  ciphertext: z.string().startsWith("vault:"),
  keyRef: z.string().min(1),
});

/**
 * #558 (DEC-398): mã hoá JWT rewards ở signer (`/v1/rewards-tokens/encrypt`, chỉ CN `api`). Lỗi mạng / signer / Vault
 * hay response lạ → `failure` (người gọi trả `REWARDS_WATCH_UNAVAILABLE`, chưa lưu gì; #582: kèm lý do để đọc log).
 * Không log, không đưa token vào lỗi.
 */
export function httpRewardsSigner(baseUrl: string, tls?: ClientTls): RewardsTokenSigner {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async encrypt(token): ReturnType<RewardsTokenSigner["encrypt"]> {
      const fail = (failure: RewardsSignerFailure) => ({ failure });
      try {
        const res = await postJson(
          `${base}/v1/rewards-tokens/encrypt`,
          { token },
          { tls, timeoutMs: 5000 },
        );
        if (res.status !== 200) return fail(`http_${String(res.status)}`);
        const parsed = rewardsEncryptSchema.safeParse(res.json);
        return parsed.success ? parsed.data : fail("bad_response");
      } catch (error) {
        const timeout =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return fail(timeout ? "timeout" : "network");
      }
    },
  };
}
