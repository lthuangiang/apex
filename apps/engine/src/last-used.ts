import type { SignerApi } from "./http-gateway";

// "Last used" của API key (UI_REVIEW J2): sau mỗi lần signer ký thành công, ghi thời điểm vào
// `api_keys.last_used_at`. Ghi tối đa mỗi `everyMs` một lần cho mỗi key; lỗi ghi không làm hỏng lệnh.

export function withLastUsed(
  signer: SignerApi,
  touch: (apiKeyId: string, at: Date) => Promise<void>,
  opts: { now?: () => number; everyMs?: number; onError?: (error: unknown) => void } = {},
): SignerApi {
  const now = opts.now ?? Date.now;
  const every = opts.everyMs ?? 60_000;
  const last = new Map<string, number>();
  return {
    async sign(input) {
      const signature = await signer.sign(input);
      const t = now();
      const prev = last.get(input.apiKeyId);
      if (prev === undefined || t - prev >= every) {
        last.set(input.apiKeyId, t);
        touch(input.apiKeyId, new Date(t)).catch((error: unknown) => {
          last.delete(input.apiKeyId);
          opts.onError?.(error);
        });
      }
      return signature;
    },
  };
}
