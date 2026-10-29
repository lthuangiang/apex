import { postJson, type ClientTls } from "@drift/runtime";
import { z } from "zod";

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
